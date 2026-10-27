import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { signMediaUrl } from '@/services/media-proxy';

/**
 * /media 中转路由离线用例（假上游 globalThis.fetch，不碰真网）：
 *  - PROXY_SECRET 未配置 → 501（可选增强未启用，走 envelope 错误信封）；
 *  - HMAC 签名五连拒：缺参 / exp 非法 / 过期 410 / 篡改 403 / u 非法 URL / http 与白名单外域名 403；
 *  - GET：内容头重建 + content-disposition（标题清洗 + RFC 5987，音频 .m4a）+ Range 透传；
 *  - HEAD 显式注册：无 body、不写 content-disposition；
 *  - 并发上限 2：满员直接 429 不排队；
 *  - 302 手动跟随（每跳 SSRF 校验）。
 */

const app = createApp();

const realFetch = globalThis.fetch;
const OLD_SECRET = process.env.PROXY_SECRET;
const SECRET = 'test-secret';

const MEDIA_HOST = 'https://v26-web.douyinvod.com/video/tos/abc';

let upstreamCalls: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: unknown;
}> = [];

/** Headers → 普通对象（键为小写，与 Headers.get 语义一致） */
function headerRecord(init?: RequestInit): Record<string, string> {
  const h = new Headers(init?.headers as HeadersInit);
  const pairs: Array<[string, string]> = [];
  h.forEach((v, k) => pairs.push([k, v]));
  return Object.fromEntries(pairs);
}

interface Envelope {
  success: boolean;
  data: unknown;
  error?: { code: string; message: string; detail?: Record<string, unknown> };
}

/** 构造带合法签名的 /media 请求串 */
function signedQuery(rawUrl: string, nowSec?: number, tweak?: (q: Record<string, string>) => void): string {
  const { exp, sig } = signMediaUrl(rawUrl, nowSec);
  const q: Record<string, string> = { u: Buffer.from(rawUrl).toString('base64url'), exp: String(exp), sig };
  tweak?.(q);
  return new URLSearchParams(q).toString();
}

function mediaRequest(
  qs: string,
  method: 'GET' | 'HEAD' = 'GET',
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/media?${qs}`, { method, headers });
}

function stubUpstream(handler: (call: number) => Response | Promise<Response>): void {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    upstreamCalls.push({
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init),
      redirect: (init as { redirect?: unknown } | undefined)?.redirect,
    });
    n += 1;
    return handler(n);
  }) as typeof fetch;
}

async function expectFail(res: Response, status: number, code: string): Promise<Envelope> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as Envelope;
  expect(body.success).toBe(false);
  expect(body.data).toBeNull();
  expect(body.error?.code).toBe(code);
  return body;
}

beforeEach(() => {
  process.env.PROXY_SECRET = SECRET;
  upstreamCalls = [];
  stubUpstream(() => new Response('unexpected upstream', { status: 500 }));
});

afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.PROXY_SECRET;
  else process.env.PROXY_SECRET = OLD_SECRET;
  globalThis.fetch = realFetch;
});

describe('/media 未启用与签名校验（HMAC 五连拒）', () => {
  test('PROXY_SECRET 未配置 → 501 MEDIA_PROXY_DISABLED（走 envelope）', async () => {
    const qs = signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000));
    delete process.env.PROXY_SECRET;
    const res = await app.handle(mediaRequest(qs));
    await expectFail(res, 501, 'MEDIA_PROXY_DISABLED');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('缺签名参数（只有 u）→ 400 INVALID_URL', async () => {
    const res = await app.handle(mediaRequest('u=' + Buffer.from(MEDIA_HOST).toString('base64url')));
    await expectFail(res, 400, 'INVALID_URL');
  });

  test('exp 不是合法时间戳 → 400 INVALID_URL', async () => {
    const res = await app.handle(mediaRequest('u=x&exp=abc&sig=x'));
    await expectFail(res, 400, 'INVALID_URL');
  });

  test('签名过期 → 410 MEDIA_LINK_EXPIRED（detail 带 expiredAt）', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = await expectFail(
      await app.handle(mediaRequest(signedQuery(MEDIA_HOST, nowSec - 700))),
      410,
      'MEDIA_LINK_EXPIRED',
    );
    expect(typeof body.error?.detail?.expiredAt).toBe('number');
  });

  test('sig 篡改 → 403 MEDIA_BAD_SIGNATURE', async () => {
    const qs = signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000), (q) => {
      q.sig = q.sig!.slice(0, -1) + (q.sig!.endsWith('0') ? '1' : '0');
    });
    await expectFail(await app.handle(mediaRequest(qs)), 403, 'MEDIA_BAD_SIGNATURE');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('u 解码后不是合法 URL → 400 INVALID_URL（签名本身有效）', async () => {
    const qs = signedQuery('notaurl', Math.floor(Date.now() / 1000));
    await expectFail(await app.handle(mediaRequest(qs)), 400, 'INVALID_URL');
  });

  test('http 链接 → 403 CONTENT_RESTRICTED（只允许 https）', async () => {
    const qs = signedQuery('http://v26-web.douyinvod.com/video/x', Math.floor(Date.now() / 1000));
    await expectFail(await app.handle(mediaRequest(qs)), 403, 'CONTENT_RESTRICTED');
  });

  test('域名不在 SSRF 白名单 → 403 CONTENT_RESTRICTED（detail 带 host）', async () => {
    const qs = signedQuery('https://evil.example.com/x', Math.floor(Date.now() / 1000));
    const body = await expectFail(await app.handle(mediaRequest(qs)), 403, 'CONTENT_RESTRICTED');
    expect(body.error?.detail?.host).toBe('evil.example.com');
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('/media GET：内容头重建与 content-disposition', () => {
  test('200 透传 body，标题清洗 + RFC 5987 文件名，上游注入 UA/Referer，Range 透传', async () => {
    stubUpstream(
      () =>
        new Response('VIDEO', {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '5', 'transfer-encoding': 'chunked' },
        }),
    );
    const title = '标题/含:非法*字符';
    const res = await app.handle(
      mediaRequest(
        signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000), (q) => void (q.title = title)),
        'GET',
        {
          range: 'bytes=0-99',
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('VIDEO');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('标题 含 非法 字符.mp4')}`,
    );
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // 逐跳头不透传回客户端
    expect(res.headers.get('transfer-encoding')).toBeNull();

    const up = upstreamCalls[0]!;
    expect(up.method).toBe('GET');
    expect(up.redirect).toBe('manual');
    expect(up.headers.referer).toBe('https://www.douyin.com/');
    expect(up.headers['accept-encoding']).toBe('identity');
    expect(up.headers['user-agent']).toContain('Mozilla');
    expect(up.headers.range).toBe('bytes=0-99');
  });

  test('音频 content-type → 文件名扩展 .m4a', async () => {
    stubUpstream(() => new Response('A', { status: 200, headers: { 'content-type': 'audio/mp4' } }));
    const res = await app.handle(
      mediaRequest(signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000), (q) => void (q.title = '一首歌'))),
    );
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('一首歌.m4a')}`,
    );
  });

  test('标题清洗后为空 → 不写 content-disposition', async () => {
    stubUpstream(() => new Response('V', { status: 200, headers: { 'content-type': 'video/mp4' } }));
    const res = await app.handle(
      mediaRequest(signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000), (q) => void (q.title = ' /:*? '))),
    );
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  test('上游 content-type 缺失/octet-stream → 兜底 video/mp4', async () => {
    stubUpstream(
      () => new Response('V', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    const res = await app.handle(mediaRequest(signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000))));
    expect(res.headers.get('content-type')).toBe('video/mp4');
    // 无 title 参数也不写 content-disposition
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  test('上游 302 手动跟随一跳（每跳 SSRF 校验）到白名单 CDN 后 200', async () => {
    stubUpstream((n) =>
      n === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://v3-web.douyinvod.com/video/tos/next' },
          })
        : new Response('ZZ', { status: 200, headers: { 'content-type': 'video/mp4' } }),
    );
    const res = await app.handle(mediaRequest(signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000))));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ZZ');
    expect(upstreamCalls.map((c) => c.url)).toEqual([
      MEDIA_HOST,
      'https://v3-web.douyinvod.com/video/tos/next',
    ]);
    // 每跳都用同一份请求头白名单注入
    expect(upstreamCalls[1]!.headers.referer).toBe('https://www.douyin.com/');
  });

  test('上游 302 无 Location → 原样交回上游响应', async () => {
    stubUpstream(() => new Response(null, { status: 302 }));
    const res = await app.handle(mediaRequest(signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000))));
    expect(res.status).toBe(302);
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe('/media HEAD：显式注册，不改写 content-length', () => {
  test('HEAD 200：无 body、不写 content-disposition、content-length 保留', async () => {
    stubUpstream(
      () =>
        new Response(null, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5' } }),
    );
    const res = await app.handle(
      mediaRequest(
        signedQuery(MEDIA_HOST, Math.floor(Date.now() / 1000), (q) => void (q.title = '标题')),
        'HEAD',
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-length')).toBe('5');
    expect(upstreamCalls[0]!.method).toBe('HEAD');
  });
});

describe('/media 并发上限', () => {
  test('并发满 2 直接 429 RATE_LIMITED 不排队；名额释放后恢复', async () => {
    const gates: Array<() => void> = [];
    globalThis.fetch = (async () =>
      new Promise<Response>((resolve) => {
        gates.push(() =>
          resolve(new Response('X', { status: 200, headers: { 'content-type': 'video/mp4' } })),
        );
      })) as unknown as typeof fetch;

    const qs = (n: number) =>
      signedQuery(`https://v26-web.douyinvod.com/video/tos/c${n}`, Math.floor(Date.now() / 1000));
    const pA = app.handle(mediaRequest(qs(1)));
    const pB = app.handle(mediaRequest(qs(2)));
    try {
      // 等两个请求都占住中转名额
      for (let i = 0; i < 1000 && gates.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
      expect(gates.length).toBe(2);

      await expectFail(await app.handle(mediaRequest(qs(3))), 429, 'RATE_LIMITED');
      expect(gates.length).toBe(2); // 第三个请求没进上游
    } finally {
      gates.forEach((release) => release());
    }

    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // 名额释放后新请求恢复
    stubUpstream(() => new Response('Y', { status: 200, headers: { 'content-type': 'video/mp4' } }));
    expect((await app.handle(mediaRequest(qs(4)))).status).toBe(200);
  });
});
