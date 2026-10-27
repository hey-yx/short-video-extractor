import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { instagramAdapter } from '@/platforms/instagram/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult } from '@/types/platform';
import reelFixture from '../fixtures/instagram/graphql-reel.json';

/**
 * Instagram fetch 链路离线用例（注入假 fetch，不碰真网）：
 *  csrftoken 首页 → GraphQL doc_id 查询两跳的请求配方、错误映射与网络失败归一。
 *  parse 回归见 instagram-parse.test.ts（fixture），这里只测 fetch 链路。
 */

const realFetch = globalThis.fetch;

const IG_HOME = 'https://www.instagram.com/';
const GRAPHQL_URL = 'https://www.instagram.com/graphql/query';
const IG_APP_ID = '936619743392459';
const DOC_ID = 'doc-fixture-123';
const CSRF = 'csrf-fixture-token';

const input = (id: string): MatchResult => ({
  platform: 'instagram',
  id,
  kind: 'video',
  needsResolve: false,
});

const makeCtx = (over: Partial<FetchCtx> = {}): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
  instagramDocId: DOC_ID,
  ...over,
});

interface StubCall {
  url: string;
  init: RequestInit | undefined;
  headers: Headers;
}

/** 假上游：handler 按请求返回 Response 或直接 throw（模拟网络层失败） */
function stubFetch(handler: (call: StubCall) => Response | Promise<Response>): { calls: () => StubCall[] } {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = req instanceof Request ? req.url : String(req);
    const call: StubCall = { url, init, headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls: () => calls };
}

const csrfRes = (): Response =>
  new Response('', {
    status: 200,
    headers: [
      ['set-cookie', `csrftoken=${CSRF}; Path=/; Secure`],
      ['set-cookie', 'mid=abc; Path=/'],
    ],
  });

const gqlRes = (body: string, status = 200): Response => new Response(body, { status });

/** 默认假上游：首页发 csrftoken，GraphQL 回 reel fixture */
function stubDefault(): { calls: () => StubCall[] } {
  return stubFetch((call) => {
    if (call.url === IG_HOME) return csrfRes();
    if (call.url === GRAPHQL_URL) return gqlRes(JSON.stringify(reelFixture));
    throw new TypeError(`fetch failed (unexpected url: ${call.url})`);
  });
}

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

const reelUrl = new URL('https://www.instagram.com/reel/Cxyz123/');

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('instagram fetch 链路（注入假 fetch）', () => {
  test('缺 IG_GRAPHQL_DOC_ID：CONFIG_MISSING，零请求', async () => {
    const upstream = stubDefault();
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx({ instagramDocId: undefined })),
      'CONFIG_MISSING',
    );
    expect(err.detail?.env).toBe('IG_GRAPHQL_DOC_ID');
    expect(upstream.calls()).toHaveLength(0);
  });

  test('成功链路：首页取 csrftoken → GraphQL 成功，via=api 且 body 原样进载荷', async () => {
    const upstream = stubDefault();
    const raw = await instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx());
    expect(upstream.calls()).toHaveLength(2);
    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(raw.body).toEqual(reelFixture);
    expect(raw.fetchedAt).toBeGreaterThan(1_700_000_000);
  });

  test('GraphQL 请求配方：doc_id + variables.shortcode + X-IG-App-ID/X-CSRFToken/Cookie，首页 GET 不跟随跳转', async () => {
    const upstream = stubDefault();
    await instagramAdapter.fetch(
      input('Cabc123'),
      new URL('https://www.instagram.com/p/Cabc123/'),
      makeCtx(),
    );
    const [home, gql] = upstream.calls();
    expect(home!.init?.method).toBe('GET');
    expect(home!.init?.redirect).toBe('manual');
    expect(gql!.init?.method).toBe('POST');
    expect(gql!.headers.get('x-ig-app-id')).toBe(IG_APP_ID);
    expect(gql!.headers.get('x-csrftoken')).toBe(CSRF);
    expect(gql!.headers.get('cookie')).toBe(`csrftoken=${CSRF}`);
    expect(gql!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(gql!.init?.body ?? ''));
    expect(body.get('doc_id')).toBe(DOC_ID);
    expect(JSON.parse(body.get('variables')!)).toEqual({
      shortcode: 'Cabc123',
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    });
  });

  test('首页网络层抛错：归一 UPSTREAM_ERROR（瞬态重试才接得住）', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('csrftoken');
    expect(err.detail?.cause).toContain('网络失败');
  });

  test('首页超时中止（AbortError）：同样归一 UPSTREAM_ERROR', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expectAppError(instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()), 'UPSTREAM_ERROR');
  });

  test('首页未发 csrftoken cookie：UPSTREAM_ERROR（疑似风控/登录墙），不再打 GraphQL', async () => {
    const upstream = stubFetch((call) => {
      if (call.url === IG_HOME)
        return new Response('', { status: 200, headers: [['set-cookie', 'mid=abc; Path=/']] });
      return gqlRes(JSON.stringify(reelFixture));
    });
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('csrftoken');
    expect(upstream.calls()).toHaveLength(1);
  });

  test('GraphQL 网络层抛错：UPSTREAM_ERROR，detail 带 shortcode', async () => {
    const upstream = stubFetch((call) => {
      if (call.url === IG_HOME) return csrfRes();
      throw new TypeError('fetch failed');
    });
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.detail?.shortcode).toBe('Cxyz123');
    expect(upstream.calls()).toHaveLength(2);
  });

  test('GraphQL 429：RATE_LIMITED', async () => {
    stubFetch((call) => (call.url === IG_HOME ? csrfRes() : gqlRes('too many requests', 429)));
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()),
      'RATE_LIMITED',
    );
    expect(err.detail?.shortcode).toBe('Cxyz123');
  });

  test('GraphQL 5xx：UPSTREAM_ERROR，message 带 HTTP 状态且 body 截断 120 字符', async () => {
    stubFetch((call) => (call.url === IG_HOME ? csrfRes() : gqlRes('x'.repeat(200), 503)));
    const err = await expectAppError(
      instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('HTTP 503');
    expect(err.detail?.body).toHaveLength(120);
  });

  test('GraphQL 200 非 JSON（落到登录页 HTML）：UPSTREAM_CHANGED', async () => {
    stubFetch((call) => (call.url === IG_HOME ? csrfRes() : gqlRes('<html>login</html>', 200)));
    await expectAppError(instagramAdapter.fetch(input('Cxyz123'), reelUrl, makeCtx()), 'UPSTREAM_CHANGED');
  });
});
