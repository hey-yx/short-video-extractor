import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { youtubeAdapter, CLIENT_CHAIN } from '@/platforms/youtube/adapter';
import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, RawPayload } from '@/types/platform';
import mergedFixture from '../fixtures/youtube/player-merged-androidvr.json';
import dashIosFixture from '../fixtures/youtube/player-dash-ios.json';
import loginRequiredFixture from '../fixtures/youtube/player-login-required.json';

/**
 * YouTube innertube 链路离线用例（假上游 globalThis.fetch，不碰真网）：
 *  - ANDROID_VR 成功直出；被 bot 检查拦时换 IOS 回退（client 回退链）；
 *  - 不可播状态经 mapPlayability 归类（RISK_CONTROL/CONTENT_RESTRICTED/CONTENT_NOT_FOUND/UPSTREAM_ERROR）；
 *  - 网络层失败换 client 重试，全挂按最后一次 attempt 归错；
 *  - youtu.be 短链 HEAD 302 展开。
 * parse 回归见 youtube-parse.test.ts（fixture），这里只测 fetch/resolve 的 IO 链路。
 */

const realFetch = globalThis.fetch;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  proxy: unknown;
}

let calls: Recorded[] = [];
let idSeq = 0;
const nextId = () => `yt${String(++idSeq).padStart(9, '0')}`;

const input = (id = nextId()): MatchResult => ({
  platform: 'youtube',
  id,
  kind: 'video',
  needsResolve: false,
});

const makeCtx = (proxyUrl?: string): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: { info() {}, warn() {}, error() {} },
  ...(proxyUrl ? { proxyUrl } : {}),
});

/** Headers → 普通对象（键为小写，与 Headers.get 语义一致） */
function headerRecord(init?: RequestInit): Record<string, string> {
  const h = new Headers(init?.headers as HeadersInit);
  const pairs: Array<[string, string]> = [];
  h.forEach((v, k) => pairs.push([k, v]));
  return Object.fromEntries(pairs);
}

/** 假 player 上游：handler 按（第 n 次调用）返回 Response 或直接 throw */
function stubPlayer(handler: (call: number, req: Recorded) => Response | Promise<Response>): void {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init),
      body: init?.body,
      proxy: (init as { proxy?: unknown } | undefined)?.proxy,
    };
    calls.push(rec);
    n += 1;
    return handler(n, rec);
  }) as unknown as typeof fetch;
}

const okPlayer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

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
  calls = [];
  stubPlayer(() => new Response('unexpected upstream', { status: 500 }));
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('YouTube player 成功链路（innertube）', () => {
  test('ANDROID_VR 200 OK + 格式齐全：一次请求直出，body.client=ANDROID_VR，via=api / channel=http', async () => {
    stubPlayer(() => okPlayer(mergedFixture));
    const raw = (await youtubeAdapter.fetch(
      input(),
      new URL('https://www.youtube.com/watch?v=x'),
      makeCtx(),
    )) as RawPayload;

    expect(raw.via).toBe('api');
    expect(raw.channel).toBe('http');
    expect(calls).toHaveLength(1);
    const body = raw.body as { client: string; player: unknown };
    expect(body.client).toBe(CLIENT_CHAIN[0]);
    expect(body.player).toEqual(mergedFixture);
  });

  test('请求配方：POST player 接口、ANDROID_VR 客户端头、body 带 videoId/contentCheckOk', async () => {
    stubPlayer(() => okPlayer(mergedFixture));
    const id = nextId();
    await youtubeAdapter.fetch(input(id), new URL('https://www.youtube.com/watch?v=x'), makeCtx());

    const req = calls[0]!;
    expect(req.url).toBe('https://www.youtube.com/youtubei/v1/player');
    expect(req.method).toBe('POST');
    expect(req.headers['x-youtube-client-name']).toBe('28');
    expect(req.headers['x-youtube-client-version']).toBe('1.62.27');
    const body = req.body as string;
    expect(JSON.parse(body)).toMatchObject({ videoId: id, contentCheckOk: true, racyCheckOk: true });
  });

  test('ctx.proxyUrl 经 proxiedFetch 注入 fetch 的 proxy 选项', async () => {
    stubPlayer(() => okPlayer(mergedFixture));
    await youtubeAdapter.fetch(
      input(),
      new URL('https://www.youtube.com/watch?v=x'),
      makeCtx('http://proxy.local:7890'),
    );
    expect(calls[0]!.proxy).toBe('http://proxy.local:7890');
  });

  test('ANDROID_VR 被 bot 检查拦（LOGIN_REQUIRED）→ 换 IOS 成功：两次请求，body.client=IOS', async () => {
    stubPlayer((n) => (n === 1 ? okPlayer(loginRequiredFixture) : okPlayer(dashIosFixture)));
    const raw = await youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx());

    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['x-youtube-client-name']).toBe('28');
    expect(calls[1]!.headers['x-youtube-client-name']).toBe('5');
    const body = raw.body as { client: string; player: unknown };
    expect(body.client).toBe(CLIENT_CHAIN[1]);
    expect(body.player).toEqual(dashIosFixture);
  });

  test('ANDROID_VR 网络层失败（TypeError）→ 换 IOS 成功', async () => {
    stubPlayer((n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return okPlayer(dashIosFixture);
    });
    const raw = await youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx());
    expect(calls).toHaveLength(2);
    expect((raw.body as { client: string }).client).toBe('IOS');
  });

  test('OK 但无可用格式 → 换 client；两个 client 都一样 → UPSTREAM_ERROR 且 attempts 记满两次', async () => {
    stubPlayer(() =>
      okPlayer({ playabilityStatus: { status: 'OK' }, streamingData: { formats: [], adaptiveFormats: [] } }),
    );
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(calls).toHaveLength(2);
    expect(err.detail?.attempts).toHaveLength(2);
  });
});

describe('YouTube 不可播状态归类（mapPlayability，两个 client 都试过）', () => {
  test('LOGIN_REQUIRED（风控）→ RISK_CONTROL', async () => {
    stubPlayer(() => okPlayer(loginRequiredFixture));
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'RISK_CONTROL',
    );
    expect(err.detail?.status).toBe('LOGIN_REQUIRED');
  });

  test('UNPLAYABLE → CONTENT_RESTRICTED', async () => {
    stubPlayer(() => okPlayer({ playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' } }));
    await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'CONTENT_RESTRICTED',
    );
  });

  test('VIDEO_UNAVAILABLE → CONTENT_NOT_FOUND', async () => {
    stubPlayer(() =>
      okPlayer({ playabilityStatus: { status: 'VIDEO_UNAVAILABLE', reason: 'This video is unavailable' } }),
    );
    await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'CONTENT_NOT_FOUND',
    );
  });

  test('未知播放状态 → UPSTREAM_ERROR（兜底归类）', async () => {
    stubPlayer(() => okPlayer({ playabilityStatus: { status: 'SOMETHING_NEW', reason: '?' } }));
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(err.detail?.status).toBe('SOMETHING_NEW');
  });
});

describe('YouTube 网络层失败与 youtu.be 展开', () => {
  test('两个 client 全部网络抛错 → UPSTREAM_ERROR，attempts 记录失败原因', async () => {
    stubPlayer(() => {
      throw new TypeError('fetch failed');
    });
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    expect(calls).toHaveLength(2);
    const attempts = err.detail?.attempts as Array<{ client: string; reason: string }>;
    expect(attempts.map((a) => a.client)).toEqual(['ANDROID_VR', 'IOS']);
    expect(attempts[0]!.reason).toContain('fetch failed');
  });

  test('player HTTP 500 全挂 → UPSTREAM_ERROR，attempt reason 含 HTTP 500', async () => {
    stubPlayer(() => new Response('boom', { status: 500 }));
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    const attempts = err.detail?.attempts as Array<{ reason: string }>;
    expect(attempts[0]!.reason).toContain('HTTP 500');
  });

  test('player 返回非 JSON 全挂 → UPSTREAM_ERROR，attempt reason 含「非 JSON」', async () => {
    stubPlayer(() => new Response('<html>captcha</html>', { status: 200 }));
    const err = await expectAppError(
      youtubeAdapter.fetch(input(), new URL('https://www.youtube.com/watch?v=x'), makeCtx()),
      'UPSTREAM_ERROR',
    );
    const attempts = err.detail?.attempts as Array<{ reason: string }>;
    expect(attempts[0]!.reason).toContain('非 JSON');
  });

  test('youtu.be 短链 HEAD 302 → 返回展开地址（redirect:manual 且取消 body）', async () => {
    stubPlayer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        }),
    );
    const out = await youtubeAdapter.resolve!(new URL('https://youtu.be/dQw4w9WgXcQ'), makeCtx());
    expect(out.href).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('HEAD');
  });

  test('youtu.be 短链无 Location → INVALID_URL', async () => {
    stubPlayer(() => new Response(null, { status: 200 }));
    await expectAppError(
      youtubeAdapter.resolve!(new URL('https://youtu.be/dQw4w9WgXcQ'), makeCtx()),
      'INVALID_URL',
    );
  });
});
