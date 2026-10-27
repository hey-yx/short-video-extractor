import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { tiktokAdapter } from '@/platforms/tiktok/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult } from '@/types/platform';
import tikwmFixture from '../fixtures/tiktok/tikwm-video.json';

/**
 * TikTok fetch/resolve 链路离线用例（注入假 fetch，不碰真网）：
 *  vm./vt. 短链 302 展开 → tikwm 中转查询两跳、代理透传、错误映射。
 *  parse 回归见 tiktok-parse.test.ts（fixture），这里只测 fetch 链路。
 */

const realFetch = globalThis.fetch;

const TIKWM_API = 'https://www.tikwm.com/api/';
const VIDEO_ID = '7665075736742530317';
const PROXY = 'http://127.0.0.1:7890';

const input = (id: string): MatchResult => ({
  platform: 'tiktok',
  id,
  kind: 'unknown',
  needsResolve: false,
});

const makeCtx = (over: Partial<FetchCtx> = {}): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
  ...over,
});

interface StubCall {
  url: string;
  init: RequestInit | undefined;
  headers: Headers;
  /** proxiedFetch 注入的 per-request 代理串（RequestInit 无此字段，单独取） */
  proxy: string | undefined;
}

/** 假上游：handler 按请求返回 Response 或直接 throw（模拟网络层失败） */
function stubFetch(handler: (call: StubCall) => Response | Promise<Response>): { calls: () => StubCall[] } {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = req instanceof Request ? req.url : String(req);
    const call: StubCall = {
      url,
      init,
      headers: new Headers(init?.headers),
      proxy: (init as (RequestInit & { proxy?: string }) | undefined)?.proxy,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls: () => calls };
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

const shortUrl = new URL('https://vm.tiktok.com/ZMabcdef/');
const longUrl = new URL(`https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`);

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('tiktok 短链 resolve 链路（注入假 fetch）', () => {
  test('302：Location 展开为长链，GET + 不跟随 + 代理透传', async () => {
    const upstream = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: longUrl.href },
        }),
    );
    const final = await tiktokAdapter.resolve!(shortUrl, makeCtx({ proxyUrl: PROXY }));
    expect(final.href).toBe(longUrl.href);
    const call = upstream.calls()[0]!;
    expect(call.init?.method).toBe('GET');
    expect(call.init?.redirect).toBe('manual');
    expect(call.proxy).toBe(PROXY);
  });

  test('302 无 Location：INVALID_URL', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expectAppError(tiktokAdapter.resolve!(shortUrl, makeCtx()), 'INVALID_URL');
  });
});

describe('tiktok fetch 链路（tikwm 中转，注入假 fetch）', () => {
  test('成功链路：tikwm ?url=长链&hd=1，via=api 且 body 与 fixture 一致', async () => {
    const upstream = stubFetch(() => new Response(JSON.stringify(tikwmFixture), { status: 200 }));
    const raw = await tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx({ proxyUrl: PROXY }));
    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(raw.body).toEqual(tikwmFixture);
    expect(raw.fetchedAt).toBeGreaterThan(1_700_000_000);
    const call = upstream.calls()[0]!;
    const reqUrl = new URL(call.url);
    expect(reqUrl.origin + reqUrl.pathname).toBe(TIKWM_API);
    expect(reqUrl.searchParams.get('url')).toBe(longUrl.href);
    expect(reqUrl.searchParams.get('hd')).toBe('1');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.proxy).toBe(PROXY);
  });

  test('无代理配置：直连（proxy 不注入）', async () => {
    const upstream = stubFetch(() => new Response(JSON.stringify(tikwmFixture), { status: 200 }));
    await tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx());
    expect(upstream.calls()[0]!.proxy).toBeUndefined();
  });

  test('tikwm 429：RATE_LIMITED，detail 带 videoId', async () => {
    stubFetch(() => new Response('too many requests', { status: 429 }));
    const err = await expectAppError(
      tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx()),
      'RATE_LIMITED',
    );
    expect(err.detail?.videoId).toBe(VIDEO_ID);
  });

  test('tikwm 5xx：UPSTREAM_ERROR，message 带 HTTP 状态且 body 截断 120 字符', async () => {
    stubFetch(() => new Response('y'.repeat(200), { status: 500 }));
    const err = await expectAppError(
      tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('tikwm HTTP 500');
    expect(err.detail?.body).toHaveLength(120);
  });

  test('tikwm 200 非 JSON（限频 HTML 页）：UPSTREAM_ERROR（疑似限频或风控）', async () => {
    stubFetch(() => new Response('<html>slow down</html>', { status: 200 }));
    const err = await expectAppError(
      tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('非 JSON');
  });

  test('fetch 网络层抛错：原样上抛不包 AppError（疑似缺陷：parse.service 瞬态重试只认 UPSTREAM_* AppError）', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    try {
      await tiktokAdapter.fetch(input(VIDEO_ID), longUrl, makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toContain('fetch failed');
    }
  });
});
