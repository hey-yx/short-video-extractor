import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { metrics } from '@/infra/metrics';
import { ipRateLimiter } from '@/services/limiter';
import fixture from '../fixtures/douyin/aweme-video.json';

const app = createApp();

interface Envelope {
  success: boolean;
  data: { id?: string; platform?: string } | null;
  cached?: boolean;
  error?: { code: string; message: string; detail?: Record<string, unknown> };
}

const realFetch = globalThis.fetch;
let upstreamCalls = 0;
let ipSeq = 0;
let idSeq = 0;

/** 每个用例独立 IP，避免共享限流桶互相干扰 */
const nextIp = () => `10.7.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
/** 假 aweme_id（19 位数字，过 match 的 15-20 位校验），互不重复防缓存串用例 */
const nextAwemeId = () => `730${String(++idSeq).padStart(16, '0')}`;

function stubFetch(body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      upstreamCalls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('unexpected upstream', { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  // 默认 stub 成失败，任何用例都不得误打真实网络
  stubFetch({ unexpected: true });
  upstreamCalls = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function postParse(body: unknown, ip = nextIp(), contentType = 'application/json'): Promise<Response> {
  return app.handle(
    new Request('http://localhost/parse', {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-real-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function getParse(url: string, ip = nextIp()): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/parse?url=${encodeURIComponent(url)}`, { headers: { 'x-real-ip': ip } }),
  );
}

async function expectError(res: Response, status: number, code: string): Promise<Envelope> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as Envelope;
  expect(body.success).toBe(false);
  expect(body.data).toBeNull();
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  return body;
}

function fixtureWithExpiry(secondsFromNow: number): typeof fixture {
  return {
    ...fixture,
    aweme_detail: {
      ...fixture.aweme_detail,
      video: {
        ...fixture.aweme_detail.video,
        cdn_url_expired: Math.floor(Date.now() / 1000) + secondsFromNow,
      },
    },
  };
}

describe('/parse 错误路径（统一信封）', () => {
  test('INVALID_URL 400：完全不是链接', async () => {
    const res = await postParse({ url: '这完全不是一个链接哦' });
    const body = await expectError(res, 400, 'INVALID_URL');
    expect(body.error?.message).toContain('无法解析的链接');
  });

  test('INVALID_URL 400：非 http(s) 协议', async () => {
    const res = await postParse({ url: 'ftp://example.com/a.mp4' });
    await expectError(res, 400, 'INVALID_URL');
  });

  test('INVALID_URL 400：平台域名但链接格式不匹配', async () => {
    const res = await postParse({ url: 'https://www.douyin.com/user/MS4wLjABAAAA' });
    const body = await expectError(res, 400, 'INVALID_URL');
    expect(body.error?.message).toContain('douyin');
  });

  test('UNSUPPORTED_PLATFORM 422：未知域名 + detail.host', async () => {
    const res = await postParse({ url: 'https://example.com/video/12345678' });
    const body = await expectError(res, 422, 'UNSUPPORTED_PLATFORM');
    expect(body.error?.detail?.host).toBe('example.com');
  });

  test('非法 body 400：缺 url 字段', async () => {
    const res = await postParse({ foo: 'bar' });
    await expectError(res, 400, 'INVALID_URL');
  });

  test('非法 body 400：url 长度不足', async () => {
    const res = await postParse({ url: 'short' });
    await expectError(res, 400, 'INVALID_URL');
  });

  test('非法 body 400：非 JSON body', async () => {
    const res = await postParse('这根本不是 JSON', nextIp(), 'text/plain');
    await expectError(res, 400, 'INVALID_URL');
  });

  test('GET /parse 缺 query 400', async () => {
    const res = await app.handle(
      new Request('http://localhost/parse', { headers: { 'x-real-ip': nextIp() } }),
    );
    await expectError(res, 400, 'INVALID_URL');
  });

  test('限流 429：同 IP 超阈值 RATE_LIMITED', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 30; i++) ipRateLimiter.take(ip);
    const res = await postParse({ url: `https://www.douyin.com/video/${nextAwemeId()}` }, ip);
    await expectError(res, 429, 'RATE_LIMITED');
  });
});

describe('/parse 成功与缓存（上游 mock）', () => {
  test('POST 成功：统一信封 + data 形状 + cached=false + X-Request-Id', async () => {
    stubFetch(fixtureWithExpiry(3600));
    const res = await postParse({ url: `https://www.douyin.com/video/${nextAwemeId()}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.data?.platform).toBe('douyin');
    expect(body.data?.id).toBe(fixture.aweme_detail.aweme_id);
  });

  test('GET 成功：query 形态同样返回统一信封', async () => {
    stubFetch(fixtureWithExpiry(3600));
    const res = await getParse(`https://www.douyin.com/video/${nextAwemeId()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect(body.data?.platform).toBe('douyin');
  });

  test('缓存命中：同 URL 二次请求 cached=true、上游只打一次', async () => {
    stubFetch(fixtureWithExpiry(3600));
    const url = `https://www.douyin.com/video/${nextAwemeId()}`;
    const ip = nextIp();
    const first = (await (await postParse({ url }, ip)).json()) as Envelope;
    expect(first.cached).toBe(false);
    const second = (await (await postParse({ url }, ip)).json()) as Envelope;
    expect(second.cached).toBe(true);
    expect(second.data?.id).toBe(first.data?.id);
    expect(upstreamCalls).toBe(1);
  });

  test('cache_hit_total 自增：二次请求后 /metrics 可见', async () => {
    metrics.reset();
    stubFetch(fixtureWithExpiry(3600));
    const url = `https://www.douyin.com/video/${nextAwemeId()}`;
    const ip = nextIp();
    await postParse({ url }, ip);
    await postParse({ url }, ip);
    const text = await (await app.handle(new Request('http://localhost/metrics'))).text();
    expect(text).toContain('cache_hit_total 1');
  });

  test('/metrics 记录 parse_total{platform="douyin",code="ok"} 与 parse_duration_ms', async () => {
    metrics.reset();
    stubFetch(fixtureWithExpiry(3600));
    await postParse({ url: `https://www.douyin.com/video/${nextAwemeId()}` });
    const text = await (await app.handle(new Request('http://localhost/metrics'))).text();
    expect(text).toContain('parse_total{platform="douyin",code="ok"} 1');
    expect(text).toContain('parse_duration_ms_count{platform="douyin"} 1');
    expect(text).toContain('parse_duration_ms_bucket{platform="douyin",le="+Inf"} 1');
  });
});
