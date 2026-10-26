import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseWeibo, type WeiboPayload, type WeiboShowPayload } from './parse';

export const WEIBO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SHOW_URL = 'https://m.weibo.cn/statuses/show';
const COMPONENT_URL = 'https://weibo.com/tv/api/component';

/** 视频直链页 fid：1034:<32 位 hex | 16+ 位数字>（yt-dlp 同一正则） */
const FID_RE = /^\d+:(?:[\da-f]{32}|\d{16,})$/;
/** 数字 mid（10~20 位）或 base62 bid（8~12 位） */
const POST_ID_RE = /^[A-Za-z0-9]{8,20}$/;
const SHORT_CODE_RE = /^\/([A-Za-z0-9]+)\/?$/;

/**
 * 访客票据（SUB/SUBP）：仅 weibo.com 的 tv/api/component 需要（fid → mid）。
 * 2026-10-26 实测：m.weibo.cn/statuses/show 匿名可取（无需 cookie）；
 * weibo.com/ajax/statuses/show 与 tv/api/component 匿名被 302 到 passport，必须访客 cookie。
 * 失败模式：取票失败 → UPSTREAM_ERROR；取票后仍被 302 → CONTENT_RESTRICTED（内容需登录）。
 */
interface GuestTicket {
  cookie: string;
  fetchedAt: number;
}
let guestTicket: GuestTicket | null = null;
/** 票据复用窗口：访客 cookie 小时级有效，1 小时后重取（不做过期探测，失效靠 302 重取兜底） */
const GUEST_TTL_SECONDS = 3600;

async function fetchGuestTicket(ctx: FetchCtx): Promise<GuestTicket> {
  const fp = JSON.stringify({
    os: '1',
    browser: 'Chrome131,0,0,0',
    fonts: 'undefined',
    screenInfo: '1920*1080*24',
    plugins: '',
  });
  const genRes = await fetch('https://passport.weibo.com/visitor/genvisitor2', {
    method: 'POST',
    headers: {
      'User-Agent': WEIBO_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ cb: 'gen_callback', fp }).toString(),
    redirect: 'manual',
    signal: ctx.signal,
  });
  const genText = await genRes.text();
  const gen = stripJsonp(genText) as { data?: { tid?: string; sub?: string; subp?: string } } | null;
  const tid = gen?.data?.tid;
  if (!tid) {
    throw new AppError('UPSTREAM_CHANGED', '微博访客票据响应结构变化', { body: genText.slice(0, 120) });
  }
  const incRes = await fetch(
    `https://passport.weibo.com/visitor/visitor?a=incarnate&t=${encodeURIComponent(tid)}&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
    {
      headers: { 'User-Agent': WEIBO_UA, Referer: 'https://passport.weibo.com/visitor/visitor' },
      redirect: 'manual',
      signal: ctx.signal,
    },
  );
  await incRes.body?.cancel();
  // incarnate 的 Set-Cookie 才是最终有效的 SUB/SUBP（genvisitor2 返回的 sub 会被刷新）
  let sub = gen.data?.sub ?? '';
  let subp = gen.data?.subp ?? '';
  for (const line of incRes.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? '';
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (name === 'SUB') sub = value;
    if (name === 'SUBP') subp = value;
  }
  if (!sub || !subp) {
    throw new AppError('UPSTREAM_ERROR', '微博访客票据获取失败（未返回 SUB/SUBP）');
  }
  return { cookie: `SUB=${sub}; SUBP=${subp}`, fetchedAt: Math.floor(Date.now() / 1000) };
}

async function guestCookie(ctx: FetchCtx): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (guestTicket && now - guestTicket.fetchedAt < GUEST_TTL_SECONDS) {
    return guestTicket.cookie;
  }
  guestTicket = await fetchGuestTicket(ctx);
  return guestTicket.cookie;
}

/** JSONP 剥壳：window.gen_callback && gen_callback({...}) → {...} */
function stripJsonp(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** fid → 数字 mid 的请求在 fetch 里做（requestComponent）；此处仅保留 guest cookie 通道 */

/** statuses/show：m 站匿名可取（2026-10-26 实测），bid/mid 通用 */
async function requestShow(id: string, ctx: FetchCtx): Promise<WeiboShowPayload> {
  const url = `${SHOW_URL}?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': WEIBO_UA,
      Referer: 'https://m.weibo.cn/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    redirect: 'manual',
    signal: ctx.signal,
  });
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) {
    throw new AppError('CONTENT_RESTRICTED', '微博内容需要登录（302 到 passport）', {
      id,
      status: res.status,
    });
  }
  if (res.status === 429 || res.status === 418 || res.status === 403) {
    throw new AppError('RISK_CONTROL', `微博风控拦截（HTTP ${res.status}）`, { id });
  }
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `微博接口 HTTP ${res.status}`, { id, body: text.slice(0, 120) });
  }
  if (!text) {
    // 200 + 空 body：按失败处理（上游异常），绝不当内容不存在
    throw new AppError('UPSTREAM_CHANGED', '微博接口返回空 body', { id });
  }
  try {
    return JSON.parse(text) as WeiboShowPayload;
  } catch {
    throw new AppError('UPSTREAM_CHANGED', '微博接口返回非 JSON', { id, body: text.slice(0, 120) });
  }
}

export const weiboAdapter: PlatformAdapter = {
  platform: 'weibo',
  description:
    '微博：statuses/show 匿名 JSON（bid/mid 通用），视频直链页 fid 经 tv/api/component 换 mid，图集走 pics[]',
  hosts: ['weibo.com', 'weibo.cn', 'weibo.com.cn', 't.cn'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    if (
      !hostMatches(url.hostname, 'weibo.com') &&
      !hostMatches(url.hostname, 'weibo.cn') &&
      !hostMatches(url.hostname, 'weibo.com.cn') &&
      url.hostname !== 't.cn'
    ) {
      return null;
    }
    // t.cn 短链：302 展开（一跳，落在 m 站 / video.weibo.com）
    if (url.hostname === 't.cn') {
      const m = url.pathname.match(SHORT_CODE_RE);
      if (!m?.[1]) return null;
      return { platform: 'weibo', id: m[1], kind: 'unknown', needsResolve: true };
    }
    // 视频直链页：video.weibo.com/show?fid=1034:<id> 或 weibo.com/tv/show/<fid>
    const fid =
      url.hostname === 'video.weibo.com' && url.pathname === '/show'
        ? url.searchParams.get('fid')
        : (url.pathname.match(/^\/tv\/show\/([^/?#]+)/)?.[1] ?? null);
    if (fid && FID_RE.test(fid)) {
      return { platform: 'weibo', id: fid, kind: 'video', needsResolve: false };
    }
    // weibo.com/<uid>/<bid>（bid 是 base62，接口自己解码，实测 2026-10-26）
    const [seg1, seg2] = url.pathname.split('/').filter(Boolean);
    if (seg2 && /^\d+$/.test(seg1 ?? '') && POST_ID_RE.test(seg2)) {
      return { platform: 'weibo', id: seg2, kind: 'unknown', needsResolve: false };
    }
    // m 站：/status/<id|bid>、/detail/<id>、/detail/<id>（m.weibo.cn/2/detail/<id> 取末段）
    const segs = url.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    if (segs.length >= 2 && (segs.includes('status') || segs.includes('detail')) && POST_ID_RE.test(last)) {
      return { platform: 'weibo', id: last, kind: 'unknown', needsResolve: false };
    }
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // t.cn 302 一跳到 m 站 status 页或 video.weibo.com/show（实测 t.cn/AX0CCdCG → show?fid=）
    // 注意：t.cn 对 HEAD 返回 200 不跳转，必须 GET 才给 302（2026-10-26 实测）
    const res = await fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': WEIBO_UA },
      signal: ctx.signal,
    });
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', 't.cn 短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    let showId = input.id;
    let component: WeiboPayload['component'];
    if (FID_RE.test(input.id)) {
      // fid 通道：component（cookie）换 mid，同时带走多档 urls（比 show 更全，实测 1080P 档）
      const cookie = await guestCookie(ctx);
      component = await requestComponent(input.id, cookie, ctx);
      showId = String(component?.data?.Component_Play_Playinfo?.mid ?? '');
      if (!showId) {
        throw new AppError('UPSTREAM_CHANGED', '微博 component 未返回 mid', { fid: input.id });
      }
    }
    const show = await requestShow(showId, ctx);
    const body: WeiboPayload = component ? { show, component } : { show };
    return {
      via: 'api',
      channel: 'http',
      fetchedAt: Math.floor(Date.now() / 1000),
      body,
    };
  },

  parse: parseWeibo,
};

/** component 请求（fid 通道专用，带访客 cookie；被 302 时清票据重取一次） */
async function requestComponent(
  fid: string,
  cookie: string,
  ctx: FetchCtx,
): Promise<NonNullable<WeiboPayload['component']>> {
  const body = new URLSearchParams({
    data: JSON.stringify({ Component_Play_Playinfo: { oid: fid } }),
  }).toString();
  const doRequest = (ck: string) =>
    fetch(`${COMPONENT_URL}?page=${encodeURIComponent(`/tv/show/${fid}`)}`, {
      method: 'POST',
      headers: {
        'User-Agent': WEIBO_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `https://video.weibo.com/show?fid=${fid}`,
        Cookie: ck,
      },
      body,
      redirect: 'manual',
      signal: ctx.signal,
    });
  let res = await doRequest(cookie);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    guestTicket = null;
    const retryCookie = await guestCookie(ctx);
    res = await doRequest(retryCookie);
  }
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) {
    throw new AppError('CONTENT_RESTRICTED', '微博视频页需要登录态（component 302 到 passport）', {
      fid,
      status: res.status,
    });
  }
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `微博 component HTTP ${res.status}`, {
      fid,
      body: text.slice(0, 120),
    });
  }
  if (!text) {
    throw new AppError('UPSTREAM_CHANGED', '微博 component 返回空 body', { fid });
  }
  let json: { code?: string; data?: { Component_Play_Playinfo?: { mid?: number | string } } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new AppError('UPSTREAM_CHANGED', '微博 component 返回非 JSON', { fid });
  }
  if (json.code !== '100000') {
    throw new AppError('CONTENT_NOT_FOUND', '微博视频不存在（component 错误）', { fid, code: json.code });
  }
  return json as NonNullable<WeiboPayload['component']>;
}
