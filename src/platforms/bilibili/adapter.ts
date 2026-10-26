import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseBilibili } from './parse';

/** upos 等节点有 Referer 防盗链报告，解析请求统一带站点 Referer + 浏览器 UA（零成本） */
export const BILIBILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

const API = 'https://api.bilibili.com';
const VIEW_URL = `${API}/x/web-interface/view`;
const PLAY_URL = `${API}/x/player/playurl`;

/** playurl 参数：fnval=4048 要 DASH，try_look=1 免登录拿 1080P（实测矩阵 docs/research/02 §3.2） */
function playUrlParams(bvid: string, cid: string): URLSearchParams {
  return new URLSearchParams({
    bvid,
    cid,
    qn: '80',
    fnval: '4048',
    fnver: '0',
    fourk: '1',
    try_look: '1',
  });
}

const BVID_RE = /(BV[0-9A-Za-z]{10})/;
/** 老.av 链接的 av 号（官方已保证 av 链接 302 到 BV，这里直接带 aid 查 view） */
const AV_RE = /av(\d{6,15})/;

function bvidFromAv(av: string): string {
  // 新版 av 号超 2^30 后由官方重定向接口换 bv，避免本地实现 NewAv 算法漂移
  return `__av_${av}`;
}

export const bilibiliAdapter: PlatformAdapter = {
  platform: 'bilibili',
  description: 'B站：view + playurl(try_look=1)，DASH 音视频分离，多 P 逐个出 asset',
  hosts: ['bilibili.com', 'b23.tv'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video'] },

  match(url: URL): MatchResult | null {
    if (!hostMatches(url.hostname, 'bilibili.com') && url.hostname !== 'b23.tv') return null;
    // 短链 b23.tv/<code>
    if (url.hostname === 'b23.tv') {
      const code = url.pathname.replace(/\//g, '');
      if (!code) return null;
      return { platform: 'bilibili', id: code, kind: 'unknown', needsResolve: true };
    }
    // 长链：/video/BVxxxx（?p=N 是分 P 选择，全 P 都出，不影响 match）
    const bv = url.href.match(BVID_RE);
    if (bv?.[1]) return { platform: 'bilibili', id: bv[1], kind: 'video', needsResolve: false };
    // .av 链接：标记为 __av_<id>，view 接口用 aid= 查询（见 fetch）
    const av = url.href.match(AV_RE);
    if (av?.[1]) return { platform: 'bilibili', id: bvidFromAv(av[1]), kind: 'video', needsResolve: false };
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // b23.tv 302 一跳到 www.bilibili.com/video/BVxxx
    const res = await fetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': BILIBILI_UA },
      signal: ctx.signal,
    });
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', 'b23.tv 短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    const headers = { 'User-Agent': BILIBILI_UA, Referer: REFERER };
    const isAv = input.id.startsWith('__av_');
    const aid = isAv ? input.id.slice(5) : null;

    // ① view：拿 title/owner/pic/pages[]（多 P 逐 P 出 asset 的数据源）
    const viewQs = new URLSearchParams(isAv && aid ? { aid } : { bvid: input.id });
    const view = await requestJson(`${VIEW_URL}?${viewQs}`, headers, ctx.signal);
    const viewData = asRecord(view.data);
    if (!viewData) throw new AppError('CONTENT_NOT_FOUND', 'B站接口未返回视频数据', { bvid: input.id });
    const bvid = typeof viewData.bvid === 'string' ? viewData.bvid : input.id.replace(/^__av_/, '');

    // ② playurl：每个 page 一次（单 P 视频只有 pages[0]，直接循环 pages 不会漏 P）
    const pageList = Array.isArray(viewData.pages) ? viewData.pages : [];
    if (pageList.length === 0) {
      throw new AppError('UPSTREAM_CHANGED', 'B站 view 未返回 pages', { bvid });
    }
    const streams = await Promise.all(
      pageList.map(async (page, i) => {
        const cid = asRecord(page)?.cid;
        if (typeof cid !== 'number' && typeof cid !== 'string') {
          throw new AppError('UPSTREAM_CHANGED', `B站 pages[${i}] 缺少 cid`, { bvid });
        }
        const play = await requestJson(
          `${PLAY_URL}?${playUrlParams(bvid, String(cid))}`,
          headers,
          ctx.signal,
        );
        const playData = asRecord(play.data);
        if (!playData)
          throw new AppError('UPSTREAM_CHANGED', `B站 playurl 未返回数据（P${i + 1}）`, { bvid, cid });
        // 与真实响应保持一致：键同时存在 snake/camel 两种写法（实测 base_url 与 baseUrl 双写）
        const dash = asRecord(playData.dash);
        const videos = dash?.video;
        const audios = dash?.audio;
        if (!Array.isArray(videos) || videos.length === 0) {
          throw new AppError('UPSTREAM_CHANGED', `B站 playurl 无 dash.video（P${i + 1}）`, { bvid, cid });
        }
        return {
          page: i + 1,
          cid,
          part: asRecord(page)?.part,
          videos,
          audios: Array.isArray(audios) ? audios : [],
        };
      }),
    );

    return {
      via: 'api',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: { view, streams },
      channel: 'http',
    };
  },

  parse: parseBilibili,
};

/* ---------- fetch 内部的最小类型助手 ---------- */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{
  code: number;
  message?: string;
  data: unknown;
}> {
  const res = await fetch(url, { headers, signal });
  const text = await res.text();
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `B站接口 HTTP ${res.status}`, {
      url: url.split('?')[0],
      body: text.slice(0, 120),
    });
  }
  if (!text) {
    throw new AppError('UPSTREAM_CHANGED', 'B站接口返回空 body');
  }
  let json: { code?: number; message?: string; data?: unknown };
  try {
    json = JSON.parse(text) as { code?: number; message?: string; data?: unknown };
  } catch {
    throw new AppError('UPSTREAM_CHANGED', 'B站接口返回非 JSON');
  }
  // B 站业务码：-400 请求错误 / -404 啥都没有 / 62002 稿件不可见 / -403 权限不足
  if (json.code !== 0) {
    const msg = json.message ?? '未知错误';
    if (json.code === -404 || json.code === -400) {
      throw new AppError('CONTENT_NOT_FOUND', `B站视频不存在（${msg}）`, { code: json.code });
    }
    if (json.code === 62002 || json.code === -403) {
      throw new AppError('CONTENT_RESTRICTED', `B站视频不可见（${msg}）`, { code: json.code });
    }
    throw new AppError('UPSTREAM_ERROR', `B站接口错误 ${json.code}: ${msg}`, { code: json.code });
  }
  return { code: 0, message: json.message, data: json.data };
}
