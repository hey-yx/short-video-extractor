import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bilibiliAdapter, BILIBILI_UA } from '@/platforms/bilibili/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, RawPayload } from '@/types/platform';
import viewVideo from '../fixtures/bilibili/view-video.json';
import viewMulti from '../fixtures/bilibili/view-multi.json';
import playurlDash from '../fixtures/bilibili/playurl-dash.json';

/**
 * B站 fetch 链路离线用例：假 globalThis.fetch 上游（view + playurl 两段），
 * 覆盖成功链路、业务码/HTTP 错误映射与网络层失败上抛；parse 回归见 bilibili-parse.test.ts（fixture），不碰真网。
 */

const realFetch = globalThis.fetch;

interface UpstreamCall {
  kind: 'view' | 'playurl';
  url: string;
  headers: Record<string, string>;
}

/** 假上游：按 URL 分 view / playurl 两段路由，handler 直接给 Response（throw 模拟网络层失败） */
function stubBili(handler: (call: UpstreamCall) => Response | Promise<Response>): {
  calls: () => UpstreamCall[];
  byKind: (kind: UpstreamCall['kind']) => number;
} {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const kind: UpstreamCall['kind'] | null = url.includes('/x/web-interface/view')
      ? 'view'
      : url.includes('/x/player/playurl')
        ? 'playurl'
        : null;
    /** proxiedFetch 会把 headers 包成 Headers 实例，断言前归一成普通对象 */
    function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
      if (!h) return {};
      if (h instanceof Headers) return Object.fromEntries(h.entries());
      if (Array.isArray(h)) return Object.fromEntries(h);
      return h as Record<string, string>;
    }

    if (!kind) throw new TypeError(`fetch failed (unexpected url: ${url})`);
    const call: UpstreamCall = {
      kind,
      url,
      headers: headersToRecord(init?.headers),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls: () => calls,
    byKind: (kind) => calls.filter((c) => c.kind === kind).length,
  };
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

const input = (id: string): MatchResult => ({
  platform: 'bilibili',
  id,
  kind: 'video',
  needsResolve: false,
});

const makeCtx = (): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
});

const videoUrl = (id: string) => new URL(`https://www.bilibili.com/video/${id}`);

interface BiliBody {
  view: { code: number; message?: string; data: unknown };
  streams: Array<{ page: number; cid: unknown; part: unknown; videos: unknown[]; audios: unknown[] }>;
}

const bodyOf = (raw: RawPayload): BiliBody => raw.body as BiliBody;

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

describe('bilibili fetch 成功链路（view + playurl）', () => {
  test('单 P：载荷带 view + streams，via=api / channel=http', async () => {
    stubBili((call) => (call.kind === 'view' ? ok(viewVideo) : ok(playurlDash)));
    const raw = await bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx());
    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(raw.fetchedAt).toBeGreaterThan(0);
    const body = bodyOf(raw);
    expect(body.view.code).toBe(0);
    expect((body.view.data as { bvid: string }).bvid).toBe('BV1GJ411x7h7');
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]!.page).toBe(1);
    expect(body.streams[0]!.cid).toBe(137649199);
    expect(body.streams[0]!.videos).toEqual(playurlDash.data.dash.video);
    expect(body.streams[0]!.audios).toEqual(playurlDash.data.dash.audio);
  });

  test('请求统一带站点 Referer 与浏览器 UA（防盗链）', async () => {
    const upstream = stubBili((call) => (call.kind === 'view' ? ok(viewVideo) : ok(playurlDash)));
    await bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx());
    for (const call of upstream.calls()) {
      expect(call.headers['user-agent']).toBe(BILIBILI_UA);
      expect(call.headers['referer']).toBe('https://www.bilibili.com');
    }
  });

  test('playurl 参数要 DASH 与免登录高清（fnval=4048 / try_look=1）', async () => {
    const upstream = stubBili((call) => (call.kind === 'view' ? ok(viewVideo) : ok(playurlDash)));
    await bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx());
    const play = upstream.calls().find((c) => c.kind === 'playurl')!;
    expect(play.url).toContain('bvid=BV1GJ411x7h7');
    expect(play.url).toContain('cid=137649199');
    expect(play.url).toContain('fnval=4048');
    expect(play.url).toContain('fnver=0');
    expect(play.url).toContain('fourk=1');
    expect(play.url).toContain('try_look=1');
    expect(play.url).toContain('qn=80');
  });

  test('多 P：逐 P 打 playurl，streams 与 pages 一一对齐', async () => {
    const pages = viewMulti.data.pages as Array<{ cid: number }>;
    const upstream = stubBili((call) => (call.kind === 'view' ? ok(viewMulti) : ok(playurlDash)));
    const raw = await bilibiliAdapter.fetch(input('BV1bK411W797'), videoUrl('BV1bK411W797'), makeCtx());
    const body = bodyOf(raw);
    expect(body.streams).toHaveLength(pages.length);
    expect(upstream.byKind('playurl')).toBe(pages.length);
    body.streams.forEach((s, i) => {
      expect(s.page).toBe(i + 1);
      expect(s.cid).toBe(pages[i]!.cid);
    });
  });

  test('av 号链接：view 走 aid= 查询，playurl 用 view 返回的 bvid', async () => {
    const upstream = stubBili((call) => (call.kind === 'view' ? ok(viewVideo) : ok(playurlDash)));
    await bilibiliAdapter.fetch(input('__av_80433022'), videoUrl('av80433022'), makeCtx());
    const view = upstream.calls().find((c) => c.kind === 'view')!;
    expect(view.url).toContain('aid=80433022');
    expect(view.url).not.toContain('bvid=');
    const play = upstream.calls().find((c) => c.kind === 'playurl')!;
    expect(play.url).toContain('bvid=BV1GJ411x7h7');
  });
});

describe('bilibili 业务码与 HTTP 错误映射', () => {
  test('view HTTP 500 → UPSTREAM_ERROR', async () => {
    stubBili(() => new Response('oops', { status: 500 }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('view 200 空 body → UPSTREAM_CHANGED', async () => {
    stubBili(() => new Response('', { status: 200 }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('view 200 非 JSON → UPSTREAM_CHANGED', async () => {
    stubBili(() => new Response('<html>error page</html>', { status: 200 }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('业务码 -404 / -400 → CONTENT_NOT_FOUND', async () => {
    for (const code of [-404, -400]) {
      stubBili(() => ok({ code, message: '啥都没有', data: null }));
      await expectAppError(
        bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
        'CONTENT_NOT_FOUND',
      );
    }
  });

  test('业务码 62002 / -403 → CONTENT_RESTRICTED', async () => {
    for (const code of [62002, -403]) {
      stubBili(() => ok({ code, message: '稿件不可见', data: null }));
      await expectAppError(
        bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
        'CONTENT_RESTRICTED',
      );
    }
  });

  test('其他业务码 → UPSTREAM_ERROR', async () => {
    stubBili(() => ok({ code: -500, message: '服务器错误', data: null }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('view data 为空 → CONTENT_NOT_FOUND', async () => {
    stubBili(() => ok({ code: 0, message: 'OK', data: null }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('view 未返回 pages → UPSTREAM_CHANGED', async () => {
    stubBili(() => ok({ code: 0, message: 'OK', data: { bvid: 'BV1GJ411x7h7' } }));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('pages 缺 cid → UPSTREAM_CHANGED', async () => {
    stubBili(() =>
      ok({ code: 0, message: 'OK', data: { bvid: 'BV1GJ411x7h7', pages: [{ page: 1, part: 'x' }] } }),
    );
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('playurl 未返回数据 → UPSTREAM_CHANGED', async () => {
    stubBili((call) => (call.kind === 'view' ? ok(viewVideo) : ok({ code: 0, data: null })));
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('playurl 无 dash.video → UPSTREAM_CHANGED', async () => {
    stubBili((call) =>
      call.kind === 'view' ? ok(viewVideo) : ok({ code: 0, data: { dash: { video: [], audio: [] } } }),
    );
    await expectAppError(
      bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });
});

describe('bilibili 网络层失败与 b23.tv 展开', () => {
  test('fetch 网络失败（TypeError）归一成 UPSTREAM_ERROR，瞬态重试接得住', async () => {
    stubBili(() => {
      throw new TypeError('fetch failed');
    });
    try {
      await bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
      expect((e as AppError).detail?.cause).toContain('fetch failed');
    }
  });

  test('请求被中止（AbortError）原样上抛', async () => {
    stubBili(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    try {
      await bilibiliAdapter.fetch(input('BV1GJ411x7h7'), videoUrl('BV1GJ411x7h7'), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    }
  });

  test('b23.tv 短链 302 → 返回展开地址', async () => {
    stubBili(() => {
      throw new TypeError('fetch failed (unexpected url)');
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe('https://b23.tv/abc123');
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2' },
      });
    }) as typeof fetch;
    const final = await bilibiliAdapter.resolve!(new URL('https://b23.tv/abc123'), makeCtx());
    expect(final.pathname).toBe('/video/BV1GJ411x7h7');
    expect(final.searchParams.get('p')).toBe('2');
  });

  test('b23.tv 短链无 Location → INVALID_URL', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response('gone', { status: 200 })) as typeof fetch;
    await expectAppError(
      bilibiliAdapter.resolve!(new URL('https://b23.tv/abc123'), makeCtx()),
      'INVALID_URL',
    );
  });
});
