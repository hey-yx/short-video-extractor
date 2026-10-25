import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { parseNote } from './parse';

/** noteId：24 位十六进制（/explore/<id> 与 /discovery/item/<id>） */
const NOTE_ID_RE = /\/(?:explore|discovery\/item)\/([0-9a-f]{24})/;
const SHORT_HOSTS = new Set(['xhslink.com', 'xhslink.cn']);

export const xhsAdapter: PlatformAdapter = {
  platform: 'xhs',
  description: '小红书：浏览器截主文档 HTML → __INITIAL_STATE__（xsec_token 与 noteId 配对）',
  hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  capabilities: {
    http: false,
    browser: true,
    tlsImpersonation: true,
    kinds: ['video', 'album'],
  },

  match(url: URL): MatchResult | null {
    if (SHORT_HOSTS.has(url.hostname)) {
      // 短链：有效短链 302 → /explore/<id>?xsec_token=...&xsec_source=pc_share（调研 §1.7）。
      // 展开也必须走浏览器 TLS 指纹，所以不实现 resolve()（纯 HTTP 撑不住），
      // 直接让 fetch() 用浏览器一次导航跟随跳转链，noteId 由 parse 从 state 里取。
      return { platform: 'xhs', id: '', kind: 'unknown', needsResolve: true };
    }
    const m = url.href.match(NOTE_ID_RE);
    if (!m?.[1]) return null;
    const token = url.searchParams.get('xsec_token');
    return {
      platform: 'xhs',
      id: m[1],
      kind: 'unknown',
      needsResolve: false,
      params: token ? { xsec_token: token } : undefined,
    };
  },

  async fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
    if (!ctx.browser) {
      throw new AppError('UPSTREAM_ERROR', '小红书需要浏览器通道，但 FetchCtx.browser 未注入');
    }
    // 放行靠真实 Chrome 的 TLS/HTTP2 指纹（Bun fetch 伪造不了 JA3/JA4，调研 §1.2 结论 1）；
    // 链接上的 xsec_token 原样带上——token 与 noteId 配对，改一个字符就 300031。
    const html = await ctx.browser.getDocumentHtml(url.href, 12_000);
    if (!html) {
      throw new AppError('UPSTREAM_CHANGED', '浏览器未截到主文档 HTML');
    }
    return {
      via: 'browser-intercept',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: html,
    };
  },

  parse: parseNote,
};
