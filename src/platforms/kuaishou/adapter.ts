import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseKuaishou } from './parse';

/** 分享页只对移动端 UA 出完整 HTML：桌面 UA 会被 302 到 SPA 空壳（2026-10-25 实测） */
export const KUAISHOU_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const PHOTO_PATH_RE = /\/fw\/photo\/([A-Za-z0-9_-]+)/;
/** 兜底：部分落地页路径不含 /fw/photo/，但 query 里一定带 photoId */
const PHOTO_ID_QS_RE = /[?&]photoId=([A-Za-z0-9_-]+)/;
const SHORT_CODE_RE = /^\/([A-Za-z0-9]+)\/?$/;
/** 桌面分享页 /short-video/<photoId>（2026-10-29 实测 HEAD 302 到 m.gifshow.com/fw/photo） */
const SHORT_VIDEO_PATH_RE = /\/short-video\/([A-Za-z0-9_-]+)/;
/** 桌面分享链接 /f/<code>：code 不是 photoId，必须跟随 302 才拿到作品 */
const SHARE_PATH_RE = /\/f\/([A-Za-z0-9_-]+)\/?$/;

export const kuaishouAdapter: PlatformAdapter = {
  platform: 'kuaishou',
  description: '快手：短链 302 取 photoId + 移动端分享页 INIT_STATE',
  hosts: ['kuaishou.com', 'chenzhongtech.com'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    if (
      !hostMatches(url.hostname, 'kuaishou.com') &&
      !hostMatches(url.hostname, 'chenzhongtech.com') &&
      !hostMatches(url.hostname, 'gifshow.com')
    )
      return null;
    // 短链 v.kuaishou.com/<code>（只认短链 host，其他 kuaishou 域是落地页）
    if (url.hostname === 'v.kuaishou.com') {
      const m = url.pathname.match(SHORT_CODE_RE);
      if (!m?.[1]) return null;
      return { platform: 'kuaishou', id: m[1], kind: 'unknown', needsResolve: true };
    }
    // 落地页：/fw/photo/<photoId>（chenzhongtech/kuaishou 均出现，2026-10-25 实测为 c.kuaishou.com）
    const path = url.href.match(PHOTO_PATH_RE);
    if (path?.[1]) return { platform: 'kuaishou', id: path[1], kind: 'unknown', needsResolve: false };
    const qs = url.href.match(PHOTO_ID_QS_RE);
    if (qs?.[1]) return { platform: 'kuaishou', id: qs[1], kind: 'unknown', needsResolve: false };
    // 桌面分享页 /short-video/<photoId>：photoId 直接可用，不必再跳一跳
    const shortVideo = url.pathname.match(SHORT_VIDEO_PATH_RE);
    if (shortVideo?.[1])
      return { platform: 'kuaishou', id: shortVideo[1], kind: 'unknown', needsResolve: false };
    // 桌面分享链接 /f/<code>：302 一跳到 /short-video/<photoId>，dispatch 会重新匹配
    const share = url.pathname.match(SHARE_PATH_RE);
    if (share?.[1]) return { platform: 'kuaishou', id: share[1], kind: 'unknown', needsResolve: true };
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // HEAD 不跟随，Location 即落地页；零 cookie，UA 也不敏感（实测矩阵见 docs/research/02 §2.2）
    const res = await proxiedFetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': KUAISHOU_UA },
      signal: ctx.signal,
    });
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', '快手短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    const pageUrl = `https://v.m.chenzhongtech.com/fw/photo/${input.id}`;
    const res = await proxiedFetch(pageUrl, {
      redirect: 'follow',
      headers: {
        // 桌面 UA 会被 302 到 SPA 空壳（无 INIT_STATE），必须装手机
        'User-Agent': KUAISHOU_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: ctx.signal,
    });
    if (res.status !== 200) {
      throw new AppError('UPSTREAM_ERROR', `快手分享页 HTTP ${res.status}`, { photoId: input.id });
    }
    const html = await res.text();
    if (!html.includes('window.INIT_STATE')) {
      // 典型原因：UA 不被认作移动端 → 302 到桌面 SPA 空壳
      throw new AppError('UPSTREAM_CHANGED', '快手分享页无 INIT_STATE（可能被跳到桌面空壳页）', {
        photoId: input.id,
        finalUrl: res.url,
      });
    }
    return {
      via: 'html-embedded-json',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: html,
      channel: 'http',
    };
  },

  parse: parseKuaishou,
};
