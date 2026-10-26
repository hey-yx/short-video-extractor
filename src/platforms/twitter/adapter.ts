import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { parseTweetResultJson, parseTwitter } from './parse';

/**
 * X/Twitter 单条推文（syndication 通道，2026-10-26 实测）：
 *   GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=0
 *   - 免登录免签名，token 服务端不校验（token=0 与公式 token 均可；无 token 返回空对象 → 判 404）
 *   - 只能按 id 单条取；已删除/受保护推文返回 404 HTML 错误页，必须先判 Content-Type/JSON
 *   - mediaDetails[].video_info.variants 含完整 mp4 档位（bitrate 256k~10M）+ HLS
 * 备选通道实测结论（选择理由见任务卡评论）：guest token GraphQL 需 bearer 且端点随前端发版漂移；
 * fxtwitter 公开 API 可用作应急人工通道但非官方 SLA，不进主链路。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result';

/** /<user>/status/<id>（可带 /video/1、/photo/2 后缀与 query）；id 15~20 位数字 */
const STATUS_RE = /\/status(?:es)?\/(\d{15,20})/;

/** t.co 短链一跳 302 到 x.com/<user>/status/<id> */
export const twitterAdapter: PlatformAdapter = {
  platform: 'twitter',
  description: 'X/Twitter：cdn.syndication.twimg.com/tweet-result 免 token 单条取，variants 含 mp4 档位',
  hosts: ['x.com', 'twitter.com', 't.co'],
  capabilities: {
    http: true,
    browser: false,
    tlsImpersonation: false,
    kinds: ['video', 'album'],
  },

  match(url: URL): MatchResult | null {
    if (
      !hostMatches(url.hostname, 'x.com') &&
      !hostMatches(url.hostname, 'twitter.com') &&
      url.hostname !== 't.co'
    ) {
      return null;
    }
    // 短链 t.co/<code>：无路径信息，needsResolve 走通用展开
    if (url.hostname === 't.co') {
      const code = url.pathname.replace(/\//g, '');
      if (!code) return null;
      return { platform: 'twitter', id: code, kind: 'unknown', needsResolve: true };
    }
    // x.com/<user>/status/<id>；注意 /i/status/<id>（web/分享出的是 /<user>/status/）也在此列
    const m = url.href.match(STATUS_RE);
    if (!m?.[1]) return null;
    return { platform: 'twitter', id: m[1], kind: 'unknown', needsResolve: false };
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // t.co 302 一跳到 twitter.com/<user>/status/<id>；实测浏览器 UA 拿到的是 200 挂页，
    // 无 UA（爬虫形态）才发 301，所以这里不带 UA
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
      throw new AppError('INVALID_URL', 't.co 短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    const qs = new URLSearchParams({ id: input.id, token: '0' });
    const res = await proxiedFetch(`${SYNDICATION_URL}?${qs}`, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: ctx.signal,
      proxy: ctx.proxyUrl,
    });
    const text = await res.text();
    if (res.status === 404) {
      // 已删除/受保护：syndication 返回 HTML 错误页
      throw new AppError('CONTENT_NOT_FOUND', '推文不存在或已删除', { tweetId: input.id, status: 404 });
    }
    if (res.status === 429) {
      throw new AppError('RATE_LIMITED', 'syndication 限流，请稍后再试', { tweetId: input.id });
    }
    if (res.status !== 200) {
      throw new AppError('UPSTREAM_ERROR', `syndication HTTP ${res.status}`, {
        tweetId: input.id,
        body: text.slice(0, 120),
      });
    }
    const tweet = parseTweetResultJson(text, input.id);
    return {
      via: 'api',
      channel: 'http',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: tweet,
    };
  },

  parse: parseTwitter,
};
