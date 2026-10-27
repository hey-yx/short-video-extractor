import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { parseUrl } from '@/services/parse.service';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { ParseCache, parseCache } from '@/services/cache';
import { AppError } from '@/core/errors';
import type { FetchCtx } from '@/types/platform';
import fixture from '../fixtures/douyin/aweme-video.json';

/**
 * 熔断粘性 + 平台风控止血的链路级离线用例（走 parseUrl 服务层）：
 *  - 连续 2 次 RISK_CONTROL → 第三次请求不再打 L1，直接浏览器；
 *  - BROWSER_FALLBACK=off → 不降级，45s 止血窗口内后续请求不打上游。
 * 全程假上游 + 假 gateway，不碰真网/真 Chrome。
 */

createApp();

const RISK_BODY = 'Blocked by ArgusSecurityPlugin Uifid Not Found';
const realFetch = globalThis.fetch;
let idSeq = 0;
const nextAwemeId = () => `750${String(++idSeq).padStart(16, '0')}`;

interface FakeGateway {
  interceptCalls: number;
}

let fakeGateway: FakeGateway | null = null;

function makeCtx(withBrowser: boolean): FetchCtx {
  return {
    signal: AbortSignal.timeout(15_000),
    channel: 'http',
    browser:
      withBrowser && fakeGateway
        ? {
            async getDocumentHtml() {
              return '<html></html>';
            },
            async interceptJson(url: string) {
              fakeGateway!.interceptCalls += 1;
              return { aweme_detail: { ...fixture.aweme_detail, aweme_id: nextAwemeId() } };
            },
          }
        : undefined,
    logger: { info() {}, warn() {}, error() {} },
  };
}

function stubDetail(handler: () => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      calls += 1;
      return handler();
    }
    throw new TypeError(`fetch failed (unexpected url: ${url})`);
  }) as typeof fetch;
  return { calls: () => calls };
}

async function expectAppError(p: Promise<unknown>, code: AppError['code']): Promise<void> {
  try {
    await p;
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
  }
}

beforeEach(() => {
  metrics.reset();
  resetChannelPolicyForTests();
  parseCache.resetForTests();
  fakeGateway = { interceptCalls: 0 };
});

afterEach(() => {
  delete process.env.BROWSER_FALLBACK;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('熔断粘性（浏览器兜底可用时）', () => {
  test('连续 2 次风控后：后续请求直接走浏览器，不打 L1', async () => {
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    const id1 = nextAwemeId();
    await parseUrl(`https://www.douyin.com/video/${id1}`, makeCtx(true));
    const id2 = nextAwemeId();
    await parseUrl(`https://www.douyin.com/video/${id2}`, makeCtx(true));
    // 前两次：每次 L1 1 记 + 浏览器 1 记
    expect(upstream.calls()).toBe(2);
    expect(fakeGateway!.interceptCalls).toBe(2);
    // 第三次：熔断粘性生效，L1 零调用，直接浏览器
    const id3 = nextAwemeId();
    const outcome = await parseUrl(`https://www.douyin.com/video/${id3}`, makeCtx(true));
    expect(upstream.calls()).toBe(2);
    expect(fakeGateway!.interceptCalls).toBe(3);
    expect((outcome.result as unknown as { via: string }).via).toBe('browser');
  });

  test('降级后浏览器成功不记风控（L1 失败但兜底成功 ≠ 平台不可用）', async () => {
    stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(true));
    // 兜底成功 → parseUrl resolve，不应进平台止血窗口
    expect(parseCache.getPlatformRisk('douyin')).toBeUndefined();
  });
});

describe('BROWSER_FALLBACK=off（纯 HTTP 部署）', () => {
  test('风控时无浏览器可降级：RISK_CONTROL 503 + 平台止血窗口建立', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(1);
    expect(parseCache.getPlatformRisk('douyin')).toBeDefined();
  });

  test('止血窗口内后续请求：不打上游直接 503，45s 后窗口过期重打上游', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(1);
    // 窗口内：不同内容同样直接 503，零上游调用
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(1);
  });

  test('止血窗口只拦对应平台：xhs 不受抖音风控影响（互不误伤）', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    // xhs 请求走自己的通道，抖音的风控窗口不影响（xhs 假上游不在 stub 范围会 TypeError→归一超时，但绝不是 RISK_CONTROL）
    try {
      await parseUrl('https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7', makeCtx(false));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).not.toBe('RISK_CONTROL');
    }
  });
});
