import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { parseCache } from '@/services/cache';
import { metrics } from '@/infra/metrics';
import { browserFallbackEnabled } from '@/routes/parse.routes';

/**
 * BROWSER_FALLBACK 开关与 /metrics 熔断 gauge 的 routes 级用例：
 *  - off 时 ctx.browser 不注入（风控直接 503，无降级）；
 *  - /metrics 暴露 channel_breaker_open，风控熔断后可见 1。
 */

const app = createApp();

const RISK_BODY = 'Blocked by ArgusSecurityPlugin Uifid Not Found';
const realFetch = globalThis.fetch;
let idSeq = 0;
const nextAwemeId = () => `760${String(++idSeq).padStart(16, '0')}`;

function stubRisk(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      return new Response(RISK_BODY, { status: 403 });
    }
    throw new TypeError(`unexpected upstream: ${url}`);
  }) as typeof fetch;
}

function postParse(url: string): Promise<Response> {
  return app.handle(
    new Request('http://localhost/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.11.11.11' },
      body: JSON.stringify({ url }),
    }),
  );
}

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
  parseCache.resetForTests();
  stubRisk();
});

afterEach(() => {
  delete process.env.BROWSER_FALLBACK;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('browserFallbackEnabled 开关', () => {
  test('默认开', () => {
    expect(browserFallbackEnabled()).toBe(true);
  });

  test('BROWSER_FALLBACK=off（任意大小写/空白）→ 关', () => {
    process.env.BROWSER_FALLBACK = 'off';
    expect(browserFallbackEnabled()).toBe(false);
    process.env.BROWSER_FALLBACK = ' OFF ';
    expect(browserFallbackEnabled()).toBe(false);
    process.env.BROWSER_FALLBACK = 'Off';
    expect(browserFallbackEnabled()).toBe(false);
  });

  test('其他值不关（只认 off，防止误配静默降级）', () => {
    process.env.BROWSER_FALLBACK = '0';
    expect(browserFallbackEnabled()).toBe(true);
    process.env.BROWSER_FALLBACK = 'false';
    expect(browserFallbackEnabled()).toBe(true);
  });
});

describe('BROWSER_FALLBACK=off 请求路径', () => {
  test('风控 → 503 RISK_CONTROL，且不建立浏览器降级', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const res = await postParse(`https://www.douyin.com/video/${nextAwemeId()}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('RISK_CONTROL');
  });
});

describe('/metrics 熔断 gauge', () => {
  test('连续风控（有兜底场景）熔断后 channel_breaker_open{platform="douyin"} 1；其他平台 0', async () => {
    // 有浏览器兜底时：降级在 adapter 内部消化（不建止血窗口），两次 L1 风控后熔断粘住
    const { parseUrl } = await import('@/services/parse.service');
    const fixture = await import('../fixtures/douyin/aweme-video.json');
    let interceptCalls = 0;
    const ctx = {
      signal: AbortSignal.timeout(15_000),
      channel: 'http' as const,
      browser: {
        async getDocumentHtml() {
          return '<html></html>';
        },
        async interceptJson() {
          interceptCalls += 1;
          return { aweme_detail: { ...fixture.default.aweme_detail, aweme_id: nextAwemeId() } };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    for (let i = 0; i < 2; i++) {
      await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, ctx);
    }
    const text = await (await app.handle(new Request('http://localhost/metrics'))).text();
    expect(text).toContain('channel_breaker_open{platform="douyin"} 1');
    expect(text).toContain('channel_breaker_open{platform="xhs"} 0');
    expect(text).toContain('# TYPE channel_breaker_open gauge');
  });
});
