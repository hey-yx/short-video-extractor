import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { WEIBO_UA, resetGuestTicketForTests, weiboAdapter } from '@/platforms/weibo/adapter';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult } from '@/types/platform';
import showVideo from '../fixtures/weibo/show-video.json';
import componentPlayinfo from '../fixtures/weibo/component-playinfo.json';

/**
 * 微博 fetch 链路离线用例：假 globalThis.fetch 上游（genvisitor2/incarnate 取票 → tv/api/component → statuses/show），
 * 覆盖成功链路、访客票据、component 302 重取重试降级与错误映射；parse 回归见 weibo-parse.test.ts（fixture），不碰真网。
 *
 * 注：guestTicket 是 weibo adapter 的模块级单例且无 reset 钩子（生产代码不可改）。
 * 默认用静态导入的同一个实例（这样 bun 覆盖率能计入本文件）；
 * 只有 5 个必须观察「取票请求条数」的用例走 ?fresh 缓存击穿拿全新模块实例。
 */

const realFetch = globalThis.fetch;


interface UpstreamCall {
  kind: 'gen' | 'incarnate' | 'component' | 'show' | 'resolve';
  url: string;
  init: RequestInit;
}

function classify(url: string): UpstreamCall['kind'] | null {
  if (url.includes('passport.weibo.com/visitor/genvisitor2')) return 'gen';
  if (url.includes('passport.weibo.com/visitor/visitor')) return 'incarnate';
  if (url.includes('weibo.com/tv/api/component')) return 'component';
  if (url.includes('m.weibo.cn/statuses/show')) return 'show';
  if (url.startsWith('https://t.cn/')) return 'resolve';
  return null;
}

/** 假上游：按 URL 分取票/component/show 路由，handler 按（kind + 第 n 次）返回 Response（throw 模拟网络层失败） */
function stubWeibo(handler: (call: UpstreamCall & { nth: number }) => Response | Promise<Response>): {
  calls: () => UpstreamCall[];
  byKind: (kind: UpstreamCall['kind']) => number;
} {
  const calls: UpstreamCall[] = [];
  const nthOf = new Map<UpstreamCall['kind'], number>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const kind = classify(url);
    if (!kind) throw new TypeError(`fetch failed (unexpected url: ${url})`);
    const nth = (nthOf.get(kind) ?? 0) + 1;
    nthOf.set(kind, nth);
    const call: UpstreamCall = { kind, url, init: (init ?? {}) as RequestInit };
    calls.push(call);
    return handler({ ...call, nth });
  }) as typeof fetch;
  return {
    calls: () => calls,
    byKind: (kind) => calls.filter((c) => c.kind === kind).length,
  };
}

/** genvisitor2 JSONP：带 stale sub/subp，验证 incarnate 的 Set-Cookie 才是最终票据 */
const GEN_JSONP =
  'gen_callback && gen_callback({"retcode":0,"data":{"tid":"tid-fixture-01","sub":"stale-sub","subp":"stale-subp"}})';
const GEN_JSONP_NO_TID = 'gen_callback && gen_callback({"retcode":2,"data":{}})';
const GEN_JSONP_NO_SUB = 'gen_callback && gen_callback({"retcode":0,"data":{"tid":"tid-fixture-01"}})';

const incarnateOk = (): Response =>
  new Response(null, {
    status: 200,
    headers: [
      ['set-cookie', 'SUB=real-sub; Path=/; Domain=.weibo.com'],
      ['set-cookie', 'SUBP=real-subp; Path=/; Domain=.weibo.com'],
    ],
  });

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

const FID = '1034:5339930738753551';
const MID = '5339931342014513';

const input = (id: string): MatchResult => ({
  platform: 'weibo',
  id,
  kind: id.includes(':') ? 'video' : 'unknown',
  needsResolve: false,
});

const makeCtx = (): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
});

const statusUrl = (id: string) => new URL(`https://m.weibo.cn/status/${id}`);

interface WeiboBody {
  show: unknown;
  component?: unknown;
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

/** fid 通道默认成功路由：取票 + component + show 全 200 */
function okChain(): ReturnType<typeof stubWeibo> {
  return stubWeibo((call) => {
    switch (call.kind) {
      case 'gen':
        return new Response(GEN_JSONP, { status: 200 });
      case 'incarnate':
        return incarnateOk();
      case 'component':
        return ok(componentPlayinfo);
      case 'show':
        return ok(showVideo);
      default:
        return ok(showVideo);
    }
  });
}

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('weibo fetch 成功链路', () => {
  test('bid 直取 statuses/show：载荷仅 show，via=api / channel=http', async () => {
    const upstream = stubWeibo((call) => (call.kind === 'show' ? ok(showVideo) : ok({})));
    const raw = await weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx());
    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(raw.fetchedAt).toBeGreaterThan(0);
    const body = raw.body as WeiboBody;
    expect(body.show).toEqual(showVideo);
    expect(body.component).toBeUndefined();
    expect(upstream.byKind('gen')).toBe(0);
    expect(upstream.byKind('component')).toBe(0);
    const show = upstream.calls().find((c) => c.kind === 'show')!;
    expect(show.url).toContain('id=K5cI2eXlP');
    expect(new Headers(show.init.headers).get('user-agent')).toBe(WEIBO_UA);
    expect(show.init.redirect).toBe('manual');
  });

  test('fid 通道：取票 → component 换 mid → show，载荷带 show + component', async () => {
    const upstream = okChain();
    const raw = await weiboAdapter.fetch(
      input(FID),
      new URL(`https://video.weibo.com/show?fid=${FID}`),
      makeCtx(),
    );
    const body = raw.body as WeiboBody;
    expect(body.show).toEqual(showVideo);
    expect(body.component).toEqual(componentPlayinfo);
    expect(upstream.byKind('gen')).toBe(1);
    expect(upstream.byKind('incarnate')).toBe(1);
    expect(upstream.byKind('component')).toBe(1);
    const show = upstream.calls().find((c) => c.kind === 'show')!;
    // show 用 component 返回的 mid 而非 fid
    expect(show.url).toContain(`id=${MID}`);
  });

  test('component 请求带访客 Cookie、data=oid 载荷与 referer', async () => {
    resetGuestTicketForTests();
    const upstream = okChain();
    await weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx());
    const comp = upstream.calls().find((c) => c.kind === 'component')!;
    expect(comp.init.method).toBe('POST');
    const headers = new Headers(comp.init.headers);
    expect(headers.get('cookie')).toBe('SUB=real-sub; SUBP=real-subp');
    expect(headers.get('referer')).toBe(`https://video.weibo.com/show?fid=${FID}`);
    const body = new URLSearchParams(String(comp.init.body));
    expect(JSON.parse(body.get('data') ?? '{}')).toEqual({
      Component_Play_Playinfo: { oid: FID },
    });
    // 取票：genvisitor2 是 POST 表单，incarnate 按 tid 一跳
    const gen = upstream.calls().find((c) => c.kind === 'gen')!;
    expect(gen.init.method).toBe('POST');
    expect(String(gen.init.body)).toContain('cb=gen_callback');
    const inc = upstream.calls().find((c) => c.kind === 'incarnate')!;
    expect(inc.url).toContain('a=incarnate');
    expect(inc.url).toContain('t=tid-fixture-01');
  });

  test('票据复用：同实例第二次 fetch 不再取票', async () => {
    resetGuestTicketForTests();
    const upstream = okChain();
    await weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx());
    await weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx());
    expect(upstream.byKind('gen')).toBe(1);
    expect(upstream.byKind('incarnate')).toBe(1);
    expect(upstream.byKind('component')).toBe(2);
    expect(upstream.byKind('show')).toBe(2);
  });
});

describe('weibo 访客票据', () => {
  test('genvisitor2 响应无 tid → UPSTREAM_CHANGED', async () => {
    resetGuestTicketForTests();
    stubWeibo((call) => (call.kind === 'gen' ? new Response(GEN_JSONP_NO_TID, { status: 200 }) : ok({})));
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('incarnate 未返回 SUB/SUBP → UPSTREAM_ERROR', async () => {
    resetGuestTicketForTests();
    stubWeibo((call) =>
      call.kind === 'gen'
        ? new Response(GEN_JSONP_NO_SUB, { status: 200 })
        : new Response(null, { status: 200 }),
    );
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('incarnate Set-Cookie 覆盖 genvisitor 的 sub/subp', async () => {
    const upstream = okChain();
    await weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx());
    const comp = upstream.calls().find((c) => c.kind === 'component')!;
    const cookie = (comp.init.headers as Record<string, string>).Cookie;
    expect(cookie).toContain('SUB=real-sub');
    expect(cookie).not.toContain('stale-sub');
  });
});

describe('weibo component 降级与错误映射', () => {
  test('component 302：清票据重取，重试一次后成功', async () => {
    resetGuestTicketForTests();
    const upstream = stubWeibo((call) => {
      switch (call.kind) {
        case 'gen':
          return new Response(GEN_JSONP, { status: 200 });
        case 'incarnate':
          return incarnateOk();
        case 'component':
          return call.nth === 1
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://passport.weibo.com/visitor/visitor' },
              })
            : ok(componentPlayinfo);
        default:
          return ok(showVideo);
      }
    });
    const raw = await weiboAdapter.fetch(
      input(FID),
      new URL(`https://video.weibo.com/show?fid=${FID}`),
      makeCtx(),
    );
    expect((raw.body as WeiboBody).component).toEqual(componentPlayinfo);
    expect(upstream.byKind('gen')).toBe(2); // 首取 + 302 后清票据重取
    expect(upstream.byKind('component')).toBe(2);
    expect(upstream.byKind('show')).toBe(1);
  });

  test('component 连续 302：CONTENT_RESTRICTED（内容需登录态）', async () => {
    const upstream = stubWeibo((call) => {
      switch (call.kind) {
        case 'gen':
          return new Response(GEN_JSONP, { status: 200 });
        case 'incarnate':
          return incarnateOk();
        case 'component':
          return new Response(null, {
            status: 302,
            headers: { location: 'https://passport.weibo.com/visitor/visitor' },
          });
        default:
          return ok(showVideo);
      }
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'CONTENT_RESTRICTED',
    );
    expect(upstream.byKind('component')).toBe(2);
    expect(upstream.byKind('show')).toBe(0);
  });

  test('component HTTP 500 → UPSTREAM_ERROR', async () => {
    stubWeibo((call) => {
      if (call.kind === 'gen') return new Response(GEN_JSONP, { status: 200 });
      if (call.kind === 'incarnate') return incarnateOk();
      return new Response('oops', { status: 500 });
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('component 空 body → UPSTREAM_CHANGED', async () => {
    stubWeibo((call) => {
      if (call.kind === 'gen') return new Response(GEN_JSONP, { status: 200 });
      if (call.kind === 'incarnate') return incarnateOk();
      return new Response('', { status: 200 });
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('component 非 JSON → UPSTREAM_CHANGED', async () => {
    stubWeibo((call) => {
      if (call.kind === 'gen') return new Response(GEN_JSONP, { status: 200 });
      if (call.kind === 'incarnate') return incarnateOk();
      return new Response('<html>error</html>', { status: 200 });
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('component 业务码非 100000 → CONTENT_NOT_FOUND', async () => {
    stubWeibo((call) => {
      if (call.kind === 'gen') return new Response(GEN_JSONP, { status: 200 });
      if (call.kind === 'incarnate') return incarnateOk();
      return ok({ code: '3000001', msg: 'not found' });
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('component 未返回 mid → UPSTREAM_CHANGED', async () => {
    stubWeibo((call) => {
      if (call.kind === 'gen') return new Response(GEN_JSONP, { status: 200 });
      if (call.kind === 'incarnate') return incarnateOk();
      return ok({ code: '100000', data: { Component_Play_Playinfo: {} } });
    });
    await expectAppError(
      weiboAdapter.fetch(input(FID), new URL(`https://video.weibo.com/show?fid=${FID}`), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });
});

describe('weibo show 错误映射', () => {
  test('show 302 到 passport → CONTENT_RESTRICTED（内容需登录）', async () => {
    stubWeibo((call) =>
      call.kind === 'show'
        ? new Response(null, { status: 302, headers: { location: 'https://passport.weibo.com/login' } })
        : ok({}),
    );
    await expectAppError(
      weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
      'CONTENT_RESTRICTED',
    );
  });

  test('show 429 / 403 / 418 → RISK_CONTROL', async () => {
    for (const status of [429, 403, 418]) {
      stubWeibo((call) => (call.kind === 'show' ? new Response('blocked', { status }) : ok({})));
      await expectAppError(
        weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
        'RISK_CONTROL',
      );
    }
  });

  test('show HTTP 500 → UPSTREAM_ERROR', async () => {
    stubWeibo((call) => (call.kind === 'show' ? new Response('oops', { status: 500 }) : ok({})));
    await expectAppError(
      weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
      'UPSTREAM_ERROR',
    );
  });

  test('show 200 空 body → UPSTREAM_CHANGED（不当内容不存在）', async () => {
    stubWeibo((call) => (call.kind === 'show' ? new Response('', { status: 200 }) : ok({})));
    await expectAppError(
      weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });

  test('show 200 非 JSON → UPSTREAM_CHANGED', async () => {
    stubWeibo((call) => (call.kind === 'show' ? new Response('<html>x</html>', { status: 200 }) : ok({})));
    await expectAppError(
      weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
      'UPSTREAM_CHANGED',
    );
  });
});

describe('weibo 网络层失败与 t.cn 展开', () => {
  test('fetch 网络失败（TypeError）归一成 UPSTREAM_ERROR，编排层能重试', async () => {
    stubWeibo(() => {
      throw new TypeError('fetch failed');
    });
    const err = await expectAppError(
      weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.detail?.cause).toContain('fetch failed');
  });

  test('请求被中止（AbortError）原样上抛', async () => {
    stubWeibo(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    try {
      await weiboAdapter.fetch(input('K5cI2eXlP'), statusUrl('K5cI2eXlP'), makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    }
  });

  test('t.cn 302 → 返回展开地址（GET 展开，t.cn 对 HEAD 不跳）', async () => {
    const upstream = stubWeibo(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://video.weibo.com/show?fid=1034:5339930738753551' },
        }),
    );
    const final = await weiboAdapter.resolve!(new URL('https://t.cn/AX0CCdCG'), makeCtx());
    const call = upstream.calls()[0]!;
    expect(call.kind).toBe('resolve');
    expect(call.init.method).toBe('GET');
    expect(final.hostname).toBe('video.weibo.com');
    expect(final.searchParams.get('fid')).toBe(FID);
  });

  test('t.cn 短链无 Location → INVALID_URL', async () => {
    stubWeibo(() => new Response('gone', { status: 200 }));
    await expectAppError(weiboAdapter.resolve!(new URL('https://t.cn/AX0CCdCG'), makeCtx()), 'INVALID_URL');
  });
});
