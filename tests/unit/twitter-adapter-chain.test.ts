import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { twitterAdapter } from '@/platforms/twitter/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult } from '@/types/platform';
import tweetVideo from '../fixtures/twitter/tweet-video.json';

/**
 * X/Twitter fetch 链路离线用例：假 globalThis.fetch 上游（cdn.syndication.twimg.com/tweet-result），
 * 覆盖成功链路、状态码/载荷错误映射、代理注入与 t.co 展开；parse 回归见 twitter-parse.test.ts（fixture），不碰真网。
 */

const realFetch = globalThis.fetch;

interface UpstreamCall {
  url: string;
  init: RequestInit & { proxy?: string };
}

/** 假上游：handler 直接给 Response（throw 模拟网络层失败）；记录请求 URL 与 init（含 proxiedFetch 注入的 proxy） */
function stubTwitter(handler: (call: UpstreamCall) => Response | Promise<Response>): {
  calls: () => UpstreamCall[];
} {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: UpstreamCall = { url, init: (init ?? {}) as UpstreamCall['init'] };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls: () => calls };
}

const TWEET_ID = '2104732943457599638';

const input = (id: string): MatchResult => ({
  platform: 'twitter',
  id,
  kind: 'unknown',
  needsResolve: false,
});

const makeCtx = (proxyUrl?: string): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
  ...(proxyUrl ? { proxyUrl } : {}),
});

const tweetUrl = (id: string) => new URL(`https://x.com/user/status/${id}`);

async function expectAppError(p: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  try {
    await p;
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
}

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('twitter fetch 成功链路（syndication）', () => {
  test('200 JSON：载荷即推文对象，via=api / channel=http', async () => {
    stubTwitter(() => new Response(JSON.stringify(tweetVideo), { status: 200 }));
    const raw = await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx());
    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(raw.fetchedAt).toBeGreaterThan(0);
    expect(raw.body).toEqual(tweetVideo);
  });

  test('按 id 单条取且 token=0（服务端不校验 token）', async () => {
    const upstream = stubTwitter(() => new Response(JSON.stringify(tweetVideo), { status: 200 }));
    await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx());
    expect(upstream.calls()).toHaveLength(1);
    const url = new URL(upstream.calls()[0]!.url);
    expect(url.origin + url.pathname).toBe('https://cdn.syndication.twimg.com/tweet-result');
    expect(url.searchParams.get('id')).toBe(TWEET_ID);
    expect(url.searchParams.get('token')).toBe('0');
  });

  test('ctx.proxyUrl 经 proxiedFetch 注入 fetch 的 proxy 选项', async () => {
    const upstream = stubTwitter(() => new Response(JSON.stringify(tweetVideo), { status: 200 }));
    await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx('http://127.0.0.1:7890'));
    expect(upstream.calls()[0]!.init.proxy).toBe('http://127.0.0.1:7890');
  });

  test('未配置代理：直连（proxy 选项为空）', async () => {
    const upstream = stubTwitter(() => new Response(JSON.stringify(tweetVideo), { status: 200 }));
    await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx());
    expect(upstream.calls()[0]!.init.proxy).toBeUndefined();
  });
});

describe('twitter 状态码与载荷错误映射', () => {
  test('404（已删除/受保护的 HTML 错误页）→ CONTENT_NOT_FOUND', async () => {
    stubTwitter(() => new Response('<html>Not Found</html>', { status: 404 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('429 → RATE_LIMITED', async () => {
    stubTwitter(() => new Response('rate limited', { status: 429 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'RATE_LIMITED',
    );
  });

  test('其他非 200（503）→ UPSTREAM_ERROR', async () => {
    stubTwitter(() => new Response('oops', { status: 503 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('200 空对象（无 token/无效 id）→ CONTENT_NOT_FOUND', async () => {
    stubTwitter(() => new Response('{}', { status: 200 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('200 非 JSON（错误页）→ UPSTREAM_CHANGED', async () => {
    stubTwitter(() => new Response('<html>Something went wrong</html>', { status: 200 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('TweetTombstone（已删除）→ CONTENT_NOT_FOUND', async () => {
    stubTwitter(() => new Response(JSON.stringify({ __typename: 'TweetTombstone' }), { status: 200 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('结构变化（缺 user）→ UPSTREAM_CHANGED', async () => {
    stubTwitter(() => new Response(JSON.stringify({ __typename: 'Tweet' }), { status: 200 }));
    await expectAppError(
      twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });
});

describe('twitter 网络层失败与 t.co 展开', () => {
  test('fetch 网络失败（TypeError）归一成 AppError，瞬态重试接得住', async () => {
    stubTwitter(() => {
      throw new TypeError('fetch failed');
    });
    try {
      await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
      expect((e as AppError).detail?.cause).toContain('fetch failed');
    }
  });

  test('请求被中止（AbortError）原样上抛', async () => {
    stubTwitter(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    try {
      await twitterAdapter.fetch(input(TWEET_ID), tweetUrl(TWEET_ID), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    }
  });

  test('t.co 302 → 返回展开地址（GET 且刻意不带 UA）', async () => {
    const upstream = stubTwitter(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://x.com/user/status/2104732943457599638/video/1' },
        }),
    );
    const final = await twitterAdapter.resolve!(
      new URL('https://t.co/abc123'),
      makeCtx('http://127.0.0.1:7890'),
    );
    expect(upstream.calls()).toHaveLength(1);
    const call = upstream.calls()[0]!;
    expect(call.init.method).toBe('GET');
    expect((call.init.headers as Record<string, string>)['user-agent']).toBeUndefined();
    expect(call.init.proxy).toBe('http://127.0.0.1:7890');
    expect(final.hostname).toBe('x.com');
    expect(final.pathname).toBe('/user/status/2104732943457599638/video/1');
  });

  test('t.co 短链无 Location → INVALID_URL', async () => {
    stubTwitter(() => new Response('gone', { status: 200 }));
    await expectAppError(twitterAdapter.resolve!(new URL('https://t.co/abc123'), makeCtx()), 'INVALID_URL');
  });
});
