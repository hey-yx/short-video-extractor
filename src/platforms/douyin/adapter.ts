import { AppError } from '@/core/errors';
import { recordChannelDowngrade } from '@/infra/metrics';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '../hosts';
import { parseAweme } from './parse';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** detail 接口的零签名通道（实测唯一开关是 Origin 头，见 docs/research/01 §2.2） */
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
/** 浏览器兜底时从 response 事件截取的 XHR 路径（页面自己会带签名请求它） */
const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';
const OPEN_ORIGIN = 'https://open.douyin.com';
/** 浏览器兜底单次导航上限（总耗时仍受 ctx.signal 15s 约束） */
const BROWSER_TIMEOUT_MS = 15_000;

const AWEME_ID_RE = /\/(?:video|note|share\/video|share\/note)\/(\d{15,20})/;
const MODAL_ID_RE = /[?&]modal_id=(\d{15,20})/;

/** 抖音直链形态（空 Referer 可下；见 docs/research/01 §5） */
export function buildPlayUrl(videoId: string, ratio: string): string {
  return `https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(videoId)}&ratio=${ratio}&line=0`;
}

/** 纯 HTTP 通道：L1 零签名 detail 接口（失效信号 = 403 ArgusSecurityPlugin，§2.2） */
async function fetchViaHttp(input: MatchResult, ctx: FetchCtx): Promise<RawPayload> {
  const qs = new URLSearchParams({ aweme_id: input.id, aid: '6383' });
  let res: Response;
  try {
    res = await fetch(`${DETAIL_URL}?${qs}`, {
      headers: {
        // 唯一必需头；UA/Referer 均可省（实测矩阵见调研文档）
        Origin: OPEN_ORIGIN,
        'User-Agent': UA,
      },
      signal: ctx.signal,
    });
  } catch (err) {
    // 网络层失败归一成 UPSTREAM_TIMEOUT（parse.service 据此重试）；请求被取消则原样上抛
    if (ctx.signal.aborted) throw err;
    throw new AppError('UPSTREAM_TIMEOUT', '抖音接口网络错误或超时', { err: String(err).slice(0, 120) });
  }

  if (res.status === 403) {
    const text = await res.text();
    if (text.includes('ArgusSecurityPlugin') || text.includes('Uifid')) {
      throw new AppError('RISK_CONTROL', '抖音风控拦截（L1 通道疑似失效）', { body: text.slice(0, 120) });
    }
    throw new AppError('UPSTREAM_ERROR', '抖音接口 403', { body: text.slice(0, 120) });
  }
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `抖音接口 HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) {
    // 200 + 空 body = 静默拒绝，必须当失败（调研文档 §2.3）
    throw new AppError('UPSTREAM_CHANGED', '抖音接口返回空 body');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('UPSTREAM_CHANGED', '抖音接口返回非 JSON');
  }
  return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body: json, channel: 'http' };
}

/** 浏览器兜底通道：真实 Chrome 打开作品页，截页面自己发出的 detail XHR JSON */
async function fetchViaBrowser(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
  if (!ctx.browser) {
    throw new AppError('RISK_CONTROL', '抖音风控拦截，且浏览器兜底通道不可用', { id: input.id });
  }
  // 优先用原链接导航（保留 /note/、modal 等页面形态）；短链已在 dispatch 展开成内容页
  const pageUrl = hostMatches(url.hostname, 'douyin.com')
    ? url.href
    : `https://www.douyin.com/video/${input.id}`;
  let body: unknown;
  try {
    body = await ctx.browser.interceptJson(pageUrl, DETAIL_PATH, BROWSER_TIMEOUT_MS, ctx.signal);
  } catch (err) {
    if (err instanceof AppError || ctx.signal.aborted) throw err;
    // puppeteer 原生超时等非业务错误归一，别以 INTERNAL 冒出
    throw new AppError('UPSTREAM_TIMEOUT', '抖音浏览器通道超时', { err: String(err).slice(0, 120) });
  }
  const detail = (body as { aweme_detail?: unknown } | null)?.aweme_detail;
  if (!detail) {
    throw new AppError('UPSTREAM_CHANGED', '浏览器通道未截到 aweme_detail 数据');
  }
  return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body, channel: 'browser' };
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  description: '抖音：零签名 detail 通道 + play 直链（L1 风控时自动降级浏览器）',
  hosts: ['douyin.com', 'iesdouyin.com'],
  capabilities: { http: true, browser: true, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    // 短链
    if (url.hostname === 'v.douyin.com') {
      return { platform: 'douyin', id: url.pathname.replace(/\//g, ''), kind: 'unknown', needsResolve: true };
    }
    // 长链 / 分享页
    const m = url.href.match(AWEME_ID_RE);
    if (m?.[1]) return { platform: 'douyin', id: m[1], kind: 'unknown', needsResolve: false };
    const modal = url.href.match(MODAL_ID_RE);
    if (modal?.[1]) return { platform: 'douyin', id: modal[1], kind: 'unknown', needsResolve: false };
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // v.douyin.com 短链：HEAD 不跟随，Location 里直接有 aweme_id
    const res = await fetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: ctx.signal,
    });
    // 响应体必须取消，防连接泄漏
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', '抖音短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc);
  },

  async fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
    try {
      return await fetchViaHttp(input, ctx);
    } catch (err) {
      // L1 失效（403 Argus 风控 / 接口侧 5xx/404）→ 自动降级浏览器通道；
      // 超时与结构变更不降级（交给上层重试/如实报错），无浏览器环境、信号已取消时原样上抛
      const downgrade =
        err instanceof AppError && (err.code === 'RISK_CONTROL' || err.code === 'UPSTREAM_ERROR');
      if (!downgrade || !ctx.browser || ctx.signal.aborted) {
        throw err;
      }
      ctx.logger.warn('douyin L1 risk control, downgrade to browser channel', { id: input.id });
      recordChannelDowngrade('douyin', 'http', 'browser');
      return fetchViaBrowser(input, url, ctx);
    }
  },

  parse: parseAweme,
};

export { UA as DOUYIN_UA };
