import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseTiktok } from './parse';

/**
 * TikTok（tikwm 第三方通道，调研 05 §4.2，2026-10-26 实测）：
 *   GET https://www.tikwm.com/api/?url=<分享链>&hd=1
 *   - 出站必走代理（部署机在国内；本机 TUN 下也要显式传，与 YouTube 同链路）
 *   - code=0 成功；code=-1 失败（msg 区分限频/链接无效）；限频/超时按 UPSTREAM 分类
 *   - 直链在 tiktokcdn-us.com 家族，不绑出口 IP、无需 Referer（/media 直连即可）
 * 短链 vm./vt.tiktok.com 302 一跳到 www.tiktok.com/@<user>/video/<id>（username 可空）；
 * tikwm 对短链支持不全（vt 实测拒收），所以先本地展开再交给 tikwm。
 */

const TIKWM_API = 'https://www.tikwm.com/api/';

/** /@<user>/video/<id>、/@<user>/photo/<id>；@<user> 可为空（短链展开出的 @/video/） */
const VIDEO_RE = /\/@(?:[^/]*)\/(video|photo)\/(\d{15,25})/;

/** vm./vt. 短链：<code> 无路径信息，needsResolve 走通用展开 */
const SHORT_HOSTS = ['vm.tiktok.com', 'vt.tiktok.com'];

export const tiktokAdapter: PlatformAdapter = {
  platform: 'tiktok',
  description: 'TikTok：tikwm 公开接口（无水印直链/图集/音乐），出站走代理，直链不绑 IP',
  hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    const isShort = SHORT_HOSTS.includes(url.hostname);
    if (!isShort && !hostMatches(url.hostname, 'tiktok.com')) {
      return null;
    }
    if (isShort) {
      const code = url.pathname.replace(/\//g, '');
      if (!code) return null;
      return { platform: 'tiktok', id: code, kind: 'unknown', needsResolve: true };
    }
    const m = url.href.match(VIDEO_RE);
    if (!m?.[2]) return null;
    // photo/<id> 与 video/<id> 同 id 空间（tikwm 同接口返回，按 images[] 区分形态）
    return { platform: 'tiktok', id: m[2], kind: 'unknown', needsResolve: false };
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // vm./vt. 302 一跳到 www.tiktok.com/@<user>/video/<id>（无 UA 也发 302，实测与 t.co 不同）
    const res = await proxiedFetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: ctx.signal,
      proxy: ctx.proxyUrl,
    });
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', 'TikTok 短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
    // tikwm 要完整分享链（自己也在服务端拉 TikTok 页面）：用展开后的规范长链
    const qs = new URLSearchParams({ url: url.href, hd: '1' });
    const res = await proxiedFetch(`${TIKWM_API}?${qs}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctx.signal,
      proxy: ctx.proxyUrl,
    });
    const text = await res.text();
    if (res.status === 429) {
      throw new AppError('RATE_LIMITED', 'tikwm 限流，请稍后再试', { videoId: input.id });
    }
    if (res.status !== 200) {
      throw new AppError('UPSTREAM_ERROR', `tikwm HTTP ${res.status}`, {
        videoId: input.id,
        body: text.slice(0, 120),
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // 限频过猛时 tikwm 会回 HTML/空体而非 JSON
      throw new AppError('UPSTREAM_ERROR', 'tikwm 返回非 JSON（疑似限频或风控）', {
        videoId: input.id,
        body: text.slice(0, 120),
      });
    }
    return {
      via: 'api',
      channel: 'http',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: json,
    };
  },

  parse: parseTiktok,
};
