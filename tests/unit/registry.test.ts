import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { dispatch, listAdapters, matchAdapter, register } from '@/platforms/registry';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, Platform, PlatformAdapter } from '@/types/platform';

/**
 * 适配器注册与 dispatch 分发离线用例（假适配器，不碰真网）：
 *  - register 幂等；matchAdapter 按域名找适配器；
 *  - dispatch 的四个错误分支（深度超限 / 平台不识别 / 格式不符 / 展开后不识别）；
 *  - 短链 resolve 一跳递归展开（不嵌套解析）与防环。
 * 每个测试文件模块状态独立，假适配器不会污染其他文件的 registry。
 */

const makeCtx = (): FetchCtx => ({
  signal: AbortSignal.timeout(5_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
});

interface FakeOpts {
  match?: (url: URL) => MatchResult | null;
  resolve?: (url: URL, ctx: FetchCtx) => Promise<URL>;
}

/** 注册表快照（跨用例/跨文件还原用；全量测试同进程共享模块状态） */
let saved: PlatformAdapter[] = [];

function makeAdapter(platform: Platform, opts: FakeOpts = {}): PlatformAdapter {
  return {
    platform,
    description: `假 ${platform} 适配器`,
    hosts: [],
    capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video'] },
    match:
      opts.match ??
      ((url: URL): MatchResult => ({
        platform,
        id: url.pathname.slice(1) || 'id',
        kind: 'video',
        needsResolve: false,
      })),
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
    async fetch() {
      return { via: 'api', channel: 'http', fetchedAt: 0, body: {} };
    },
    parse() {
      throw new Error('本用例不测 parse');
    },
  };
}

const matchOf =
  (platform: Platform, needsResolve = false) =>
  (url: URL): MatchResult => ({
    platform,
    id: url.pathname.slice(1) || 'id',
    kind: 'video',
    needsResolve,
  });

/** 注册表是模块级单例：每个用例前清空（假适配器才注册得上），用例后原样还原 */
function snapshot(): void {
  saved = [...(listAdapters() as PlatformAdapter[])];
}

function restore(): void {
  const list = listAdapters() as PlatformAdapter[];
  list.length = 0;
  list.push(...saved);
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
  snapshot();
  // 清空才能让本用例的假适配器注册上（register 同平台幂等）
  const list = listAdapters() as PlatformAdapter[];
  list.length = 0;
});

afterEach(restore);

describe('register / listAdapters / matchAdapter', () => {
  test('register 幂等：同平台重复注册跳过', () => {
    const a = makeAdapter('douyin');
    register(a);
    register(makeAdapter('douyin'));
    expect(listAdapters()).toHaveLength(1);
    expect(listAdapters()[0]).toBe(a);
  });

  test('matchAdapter 按域名找适配器', () => {
    const a = makeAdapter('douyin');
    register(a);
    expect(matchAdapter(new URL('https://www.douyin.com/video/1'))).toBe(a);
  });

  test('域名属于已知平台但未注册适配器 → null', () => {
    expect(matchAdapter(new URL('https://www.bilibili.com/video/BV1'))).toBeNull();
  });

  test('域名不在任何平台清单 → null', () => {
    register(makeAdapter('douyin'));
    expect(matchAdapter(new URL('https://example.com/x'))).toBeNull();
  });
});

describe('dispatch：错误分支', () => {
  test('短链跳转超过 3 层（depth>3 直接拒）→ INVALID_URL', async () => {
    register(makeAdapter('douyin'));
    const err = await expectAppError(
      dispatch(new URL('https://v.douyin.com/abc/'), makeCtx(), 4),
      'INVALID_URL',
    );
    expect(err.message).toContain('循环');
  });

  test('无法识别的平台 → UNSUPPORTED_PLATFORM（detail 带 host）', async () => {
    const err = await expectAppError(
      dispatch(new URL('https://example.com/x'), makeCtx()),
      'UNSUPPORTED_PLATFORM',
    );
    expect(err.detail?.host).toBe('example.com');
  });

  test('域名是平台但链接格式不符 → INVALID_URL', async () => {
    register(makeAdapter('douyin', { match: () => null }));
    await expectAppError(dispatch(new URL('https://www.douyin.com/zzz'), makeCtx()), 'INVALID_URL');
  });

  test('短链展开后无法识别 → UNSUPPORTED_PLATFORM（detail 带展开后 host）', async () => {
    register(
      makeAdapter('douyin', {
        match: matchOf('douyin', true),
        resolve: async () => new URL('https://unknown.example.org/landing'),
      }),
    );
    const err = await expectAppError(
      dispatch(new URL('https://v.douyin.com/abc/'), makeCtx()),
      'UNSUPPORTED_PLATFORM',
    );
    expect(err.detail?.host).toBe('unknown.example.org');
  });
});

describe('dispatch：分发与短链展开', () => {
  test('needsResolve=false：直接返回适配器与 match 结果，不触发 resolve', async () => {
    const a = makeAdapter('douyin');
    register(a);
    const url = new URL('https://www.douyin.com/video/7400000000000000001');
    const out = await dispatch(url, makeCtx());

    expect(out.adapter).toBe(a);
    expect(out.url).toBe(url);
    expect(out.input.id).toBe('video/7400000000000000001');
  });

  test('needsResolve=true 但适配器无 resolve 方法：原样返回不展开', async () => {
    const a = makeAdapter('douyin', { match: matchOf('douyin', true) });
    register(a);
    const out = await dispatch(new URL('https://v.douyin.com/abc/'), makeCtx());
    expect(out.adapter).toBe(a);
    expect(out.input.needsResolve).toBe(true);
  });

  test('短链 resolve 一跳展开后递归重新匹配到目标平台适配器', async () => {
    let resolved = 0;
    const shortLink = makeAdapter('douyin', {
      match: matchOf('douyin', true),
      resolve: async (url) => {
        resolved += 1;
        expect(url.hostname).toBe('v.douyin.com');
        return new URL('https://www.bilibili.com/video/BV1xx411c7mD');
      },
    });
    const target = makeAdapter('bilibili');
    register(shortLink);
    register(target);

    const out = await dispatch(new URL('https://v.douyin.com/abc/'), makeCtx());
    expect(resolved).toBe(1);
    expect(out.adapter).toBe(target);
    expect(out.url.href).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(out.input.platform).toBe('bilibili');
    // resolve 只负责一跳：目标平台 match 结果 needsResolve=false，不再嵌套解析
    expect(out.input.needsResolve).toBe(false);
  });

  test('resolve 展开链成环：深度上限兜住，抛 INVALID_URL', async () => {
    const loop = makeAdapter('douyin', {
      match: matchOf('douyin', true),
      resolve: async (url) => new URL(`https://v.douyin.com/${url.pathname.slice(1)}x`),
    });
    register(loop);
    await expectAppError(dispatch(new URL('https://v.douyin.com/abc/'), makeCtx()), 'INVALID_URL');
  });
});
