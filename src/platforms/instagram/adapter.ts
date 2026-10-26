import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseInstagram } from './parse';

/**
 * Instagram（Reels/Post/IGTV，匿名 GraphQL doc_id 通道，2026-10-26 实测）：
 *   GET https://www.instagram.com/                      → Set-Cookie: csrftoken
 *   POST https://www.instagram.com/graphql/query        → data.xdt_api__v1__media__shortcode__web_info
 *     头：X-IG-App-ID: 936619743392459 + X-CSRFToken + Cookie（csrftoken）
 *     body（x-www-form-urlencoded）：doc_id + variables={"shortcode":...}
 *   - 无效/已删 shortcode 同样返回 200，但带 errors[]（execution error）——按 errors + items 双判
 *   - doc_id 随 IG 前端发版轮换（instaloader 主干跟踪），必须配置化：IG_GRAPHQL_DOC_ID
 *   - 直链（*.fna.fbcdn.net 等）实测无 Referer 要求、URL 无 ip= 绑定，客户端可直接下载
 */

const IG_HOME = 'https://www.instagram.com/';
const GRAPHQL_URL = 'https://www.instagram.com/graphql/query';
const IG_APP_ID = '936619743392459';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** /reel/<id> /reels/<id> /p/<id> /tv/<id>；shortcode 字母数字下划线连字符 */
const SHORTCODE_RE = /\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/;

/** 每次解析新建 csrftoken（不落进程级状态；匿名 token 无会话语义） */
async function fetchCsrfToken(ctx: FetchCtx): Promise<string> {
  let res: Response;
  try {
    res = await proxiedFetch(IG_HOME, {
      method: 'GET',
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'manual',
      proxy: ctx.proxyUrl,
      signal: ctx.signal,
    });
  } catch (e) {
    // 网络层瞬态失败（ECONNRESET 等）归一成 UPSTREAM_ERROR：parse.service 的瞬态重试才接得住
    throw new AppError('UPSTREAM_ERROR', 'Instagram csrftoken 请求网络失败（瞬态重试）', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  await res.body?.cancel();
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const token = cookies.map((c) => c.match(/csrftoken=([^;]+)/)?.[1]).find((t): t is string => !!t);
  if (!token) {
    throw new AppError('UPSTREAM_ERROR', 'Instagram 未返回 csrftoken（可能被风控/登录墙拦截）', {
      status: res.status,
    });
  }
  return token;
}

export const instagramAdapter: PlatformAdapter = {
  platform: 'instagram',
  description: 'Instagram：匿名 GraphQL doc_id 口子（免登录免 cookie），Reels/Post/IGTV 直链',
  hosts: ['instagram.com', 'instagr.am'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    if (!hostMatches(url.hostname, 'instagram.com') && !hostMatches(url.hostname, 'instagr.am')) {
      return null;
    }
    const m = url.pathname.match(SHORTCODE_RE);
    const code = m?.[1];
    if (!code) return null;
    const kind = m[0]!.startsWith('/p/') ? 'unknown' : 'video';
    return { platform: 'instagram', id: code, kind, needsResolve: false };
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    if (!ctx.instagramDocId) {
      throw new AppError(
        'CONFIG_MISSING',
        'Instagram 通道需要配置 IG_GRAPHQL_DOC_ID（匿名 GraphQL doc_id，会随 IG 发版轮换，跟踪 instaloader/gallery-dl 更新）',
        { env: 'IG_GRAPHQL_DOC_ID' },
      );
    }
    const token = await fetchCsrfToken(ctx);
    let res: Response;
    try {
      res = await proxiedFetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          'content-type': 'application/x-www-form-urlencoded',
          'x-ig-app-id': IG_APP_ID,
          'x-csrftoken': token,
          cookie: `csrftoken=${token}`,
        },
        body: new URLSearchParams({
          doc_id: ctx.instagramDocId,
          variables: JSON.stringify({
            shortcode: input.id,
            __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
          }),
        }),
        proxy: ctx.proxyUrl,
        signal: ctx.signal,
      });
    } catch (e) {
      throw new AppError('UPSTREAM_ERROR', 'Instagram GraphQL 网络失败（瞬态重试）', {
        shortcode: input.id,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
    const text = await res.text();
    if (res.status === 429) {
      throw new AppError('RATE_LIMITED', 'Instagram GraphQL 限流，请稍后再试', { shortcode: input.id });
    }
    if (res.status !== 200) {
      throw new AppError('UPSTREAM_ERROR', `Instagram GraphQL HTTP ${res.status}`, {
        shortcode: input.id,
        body: text.slice(0, 120),
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new AppError('UPSTREAM_CHANGED', 'Instagram GraphQL 返回非 JSON（可能落到登录页 HTML）', {
        shortcode: input.id,
      });
    }
    return { via: 'api', channel: 'http', fetchedAt: Math.floor(Date.now() / 1000), body };
  },

  parse: parseInstagram,
};
