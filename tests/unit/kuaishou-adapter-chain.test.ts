import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { kuaishouAdapter, KUAISHOU_UA } from '@/platforms/kuaishou/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult } from '@/types/platform';

/**
 * 快手 fetch/resolve 链路离线用例（注入假 fetch，不碰真网）：
 *  短链 HEAD 302 展开 → 移动端分享页 INIT_STATE 两跳、错误映射。
 *  parse 回归见 kuaishou-parse.test.ts（fixture），这里只测 fetch 链路。
 */

const shareHtml = readFileSync(new URL('../fixtures/kuaishou/share-page.html', import.meta.url), 'utf8');
const realFetch = globalThis.fetch;

const PHOTO_ID = '5203346566089417256';

const input = (id: string): MatchResult => ({
  platform: 'kuaishou',
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

describe('kuaishou 短链 resolve 链路（注入假 fetch）', () => {
  test('HEAD 302：Location 原样展开（相对路径补到短链域），HEAD + 不跟随 + 移动端 UA', async () => {
    const upstream = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `/fw/photo/${PHOTO_ID}?cc=share_copylink` },
        }),
    );
    const final = await kuaishouAdapter.resolve!(new URL('https://v.kuaishou.com/short1'), makeCtx());
    expect(final.href).toBe(`https://v.kuaishou.com/fw/photo/${PHOTO_ID}?cc=share_copylink`);
    const call = upstream.calls()[0]!;
    expect(call.init?.method).toBe('HEAD');
    expect(call.init?.redirect).toBe('manual');
    expect(call.headers.get('user-agent')).toBe(KUAISHOU_UA);
  });

  test('302 无 Location：INVALID_URL', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expectAppError(
      kuaishouAdapter.resolve!(new URL('https://v.kuaishou.com/short1'), makeCtx()),
      'INVALID_URL',
    );
  });
});

describe('kuaishou fetch 链路（注入假 fetch）', () => {
  test('成功链路：移动端分享页 INIT_STATE，via=html-embedded-json 且 body 原样进载荷', async () => {
    const upstream = stubFetch(() => new Response(shareHtml, { status: 200 }));
    const raw = await kuaishouAdapter.fetch(
      input(PHOTO_ID),
      new URL('https://v.kuaishou.com/short1'),
      makeCtx(),
    );
    expect(raw.via).toBe('html-embedded-json');
    expect(raw.channel).toBe('http');
    expect(raw.body).toBe(shareHtml);
    expect(raw.fetchedAt).toBeGreaterThan(1_700_000_000);
    const call = upstream.calls()[0]!;
    expect(call.url).toBe(`https://v.m.chenzhongtech.com/fw/photo/${PHOTO_ID}`);
    expect(call.init?.redirect).toBe('follow');
    // 桌面 UA 会被 302 到 SPA 空壳：必须装手机
    expect(call.headers.get('user-agent')).toBe(KUAISHOU_UA);
  });

  test('分享页非 200（502）：UPSTREAM_ERROR，message 带 HTTP 状态', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }));
    const err = await expectAppError(
      kuaishouAdapter.fetch(input(PHOTO_ID), new URL('https://v.kuaishou.com/short1'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.message).toContain('HTTP 502');
    expect(err.detail?.photoId).toBe(PHOTO_ID);
  });

  test('200 但无 INIT_STATE（桌面空壳页）：UPSTREAM_CHANGED', async () => {
    stubFetch(() => new Response('<html><body>desktop spa shell</body></html>', { status: 200 }));
    const err = await expectAppError(
      kuaishouAdapter.fetch(input(PHOTO_ID), new URL('https://v.kuaishou.com/short1'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
    expect(err.message).toContain('INIT_STATE');
    expect(err.detail?.photoId).toBe(PHOTO_ID);
  });

  test('fetch 网络层抛错：归一成 UPSTREAM_ERROR，瞬态重试接得住', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    try {
      await kuaishouAdapter.fetch(input(PHOTO_ID), new URL('https://v.kuaishou.com/short1'), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
      expect((e as AppError).detail?.cause).toContain('fetch failed');
    }
  });
});
