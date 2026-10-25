import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { parseAweme } from './parse';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** detail 接口的零签名通道（实测唯一开关是 Origin 头，见 docs/research/01 §2.2） */
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const OPEN_ORIGIN = 'https://open.douyin.com';

const AWEME_ID_RE = /\/(?:video|note|share\/video|share\/note)\/(\d{15,20})/;
const MODAL_ID_RE = /[?&]modal_id=(\d{15,20})/;

/** 抖音直链形态（空 Referer 可下；见 docs/research/01 §5） */
export function buildPlayUrl(videoId: string, ratio: string): string {
  return `https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(videoId)}&ratio=${ratio}&line=0`;
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  description: '抖音：零签名 detail 通道 + play 接口直链',
  hosts: ['douyin.com', 'iesdouyin.com'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video', 'album'] },

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

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    const qs = new URLSearchParams({ aweme_id: input.id, aid: '6383' });
    const res = await fetch(`${DETAIL_URL}?${qs}`, {
      headers: {
        // 唯一必需头；UA/Referer 均可省（实测矩阵见调研文档）
        Origin: OPEN_ORIGIN,
        'User-Agent': UA,
      },
      signal: ctx.signal,
    });

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
    return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body: json };
  },

  parse: parseAweme,
};

export { UA as DOUYIN_UA };
