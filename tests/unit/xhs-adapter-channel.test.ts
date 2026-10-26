import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { xhsAdapter, setXhsClientForTests, type XhsFetchClient } from '@/platforms/xhs/adapter';
import { metrics } from '@/infra/metrics';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, RawPayload } from '@/types/platform';

/**
 * 小红书 HTTP 主通道离线用例：通道选择与降级逻辑走注入假 client + 假 browser gateway，
 * parse 回归见 xhs-parse.test.ts（fixture），这里不碰真网/真 Chrome。
 */

const videoHtml = await Bun.file('tests/fixtures/xhs/note-video.html').text();

const realFetch = globalThis.fetch;

const input = (id = '', token?: string): MatchResult => ({
  platform: 'xhs',
  id,
  kind: 'unknown',
  needsResolve: false,
  params: token ? { xsec_token: token } : undefined,
});

const makeCtx = (withBrowser: boolean): FetchCtx & { docCalls: () => number; docUrls: () => string[] } => {
  const urls: string[] = [];
  let calls = 0;
  return {
    signal: AbortSignal.timeout(15_000),
    channel: 'http',
    browser: withBrowser
      ? {
          async getDocumentHtml(url: string) {
            calls += 1;
            urls.push(url);
            return videoHtml;
          },
          async interceptJson() {
            throw new Error('xhs 不使用 interceptJson');
          },
        }
      : undefined,
    logger: { info() {}, warn() {}, error() {} },
    docCalls: () => calls,
    docUrls: () => urls,
  };
};

/** 假 HTTP 通道：handler 按（第 n 次调用）返回 Response 或直接 throw */
function stubHttp(handler: (call: number) => Response | Promise<Response>): { calls: () => number } {
  let calls = 0;
  setXhsClientForTests((async () => {
    calls += 1;
    return handler(calls);
  }) as unknown as XhsFetchClient);
  return { calls: () => calls };
}

const loginwallRes = (): Response =>
  new Response(null, {
    status: 302,
    headers: { location: 'https://www.xiaohongshu.com/login?redirectPath=/explore' },
  });

beforeEach(() => {
  metrics.reset();
});

afterEach(() => {
  setXhsClientForTests((url, init) => fetch(url, init));
  globalThis.fetch = realFetch;
});

describe('xhs HTTP 主通道（注入假 client）', () => {
  test('200：HTML 原样进载荷，via/browser-intercept + channel=http', async () => {
    const upstream = stubHttp(() => new Response(videoHtml, { status: 200 }));
    const raw = await xhsAdapter.fetch(
      input('6aa0343c00000000270173b7', 'tok'),
      new URL('https://www.xiaohongshu.com/explore'),
      makeCtx(false),
    );
    expect(upstream.calls()).toBe(1);
    expect(raw.channel).toBe('http');
    expect(raw.via).toBe('browser-intercept');
    expect(raw.body).toBe(videoHtml);
  });

  test('登录墙 302：换连接重试 1 次，连续 2 次且无浏览器 → UPSTREAM_ERROR', async () => {
    const upstream = stubHttp(loginwallRes);
    try {
      await xhsAdapter.fetch(
        input('6aa0343c00000000270173b7'),
        new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
        makeCtx(false),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
    }
    expect(upstream.calls()).toBe(2);
  });

  test('登录墙第 1 次 + 第 2 次 200：重试成功，不降级', async () => {
    const upstream = stubHttp((call) =>
      call === 1 ? loginwallRes() : new Response(videoHtml, { status: 200 }),
    );
    const raw = await xhsAdapter.fetch(
      input('6aa0343c00000000270173b7'),
      new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
      makeCtx(true),
    );
    expect(upstream.calls()).toBe(2);
    expect(raw.channel).toBe('http');
  });

  test('登录墙 2 次 + 浏览器可用：降级兜底成功，channel_downgrade_total 计数', async () => {
    const upstream = stubHttp(loginwallRes);
    const ctx = makeCtx(true);
    const raw = await xhsAdapter.fetch(
      input('6aa0343c00000000270173b7'),
      new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
      ctx,
    );
    expect(upstream.calls()).toBe(2);
    expect(ctx.docCalls()).toBe(1);
    expect(raw.channel).toBe('browser');
    expect(metrics.render()).toContain('channel_downgrade_total{platform="xhs",from="http",to="browser"} 1');
  });

  test('登录墙 2 次 + 无浏览器环境：UPSTREAM_ERROR 如实上抛', async () => {
    stubHttp(loginwallRes);
    try {
      await xhsAdapter.fetch(
        input('6aa0343c00000000270173b7'),
        new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
        makeCtx(false),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
    }
  });

  test('300012 IP at risk 302：RISK_CONTROL 直接报错，不重试不降级', async () => {
    const upstream = stubHttp(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://www.xiaohongshu.com/website-login/error?error_code=300012&error_msg=IP%20at%20risk.',
          },
        }),
    );
    const ctx = makeCtx(true);
    try {
      await xhsAdapter.fetch(
        input('6aa0343c00000000270173b7'),
        new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
        ctx,
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('RISK_CONTROL');
    }
    expect(upstream.calls()).toBe(1);
    expect(ctx.docCalls()).toBe(0);
  });

  test('300031 token 失效 302：CONTENT_NOT_FOUND，不重试不降级', async () => {
    const upstream = stubHttp(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.xiaohongshu.com/404/sec_404?error_code=300031' },
        }),
    );
    const ctx = makeCtx(true);
    try {
      await xhsAdapter.fetch(
        input('6aa0343c00000000270173b7'),
        new URL('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7'),
        ctx,
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
    expect(upstream.calls()).toBe(1);
    expect(ctx.docCalls()).toBe(0);
  });

  test('短链 resolve：302 Location 原样返回展开地址', async () => {
    stubHttp(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://www.xiaohongshu.com/discovery/item/6ac016680000000002029db8?xsec_token=ABxyz&xsec_source=pc_share',
          },
        }),
    );
    const final = await xhsAdapter.resolve!(new URL('https://xhslink.com/a/abc123'), makeCtx(false));
    expect(final.pathname).toBe('/discovery/item/6ac016680000000002029db8');
    expect(final.searchParams.get('xsec_token')).toBe('ABxyz');
  });
});

describe('xhs match 短链（resolve 接入后）', () => {
  test('xhslink.cn 同样 needsResolve', () => {
    const m = xhsAdapter.match(new URL('https://xhslink.cn/abc123'));
    expect(m?.needsResolve).toBe(true);
    expect(m?.id).toBe('');
  });
});
