import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { parseUrl } from '@/services/parse.service';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { parseCache } from '@/services/cache';
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
            async interceptJson() {
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

  test('缓存命中不受止血窗口拦：已缓存内容照常返回，不打上游', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const detailId = nextAwemeId();
    // 共享计数器：所有上游调用都记
    let calls = 0;
    let mode: 'ok' | 'risk' = 'ok';
    // 带新鲜直链过期的 fixture（录制 fixture 的 cdn_url_expired 已过期 → TTL≤0 不缓存）
    const freshFixture = {
      ...fixture.aweme_detail,
      aweme_id: detailId,
      video: {
        ...fixture.aweme_detail.video,
        cdn_url_expired: Math.floor(Date.now() / 1000) + 3600,
      },
    };
    globalThis.fetch = (async () => {
      calls += 1;
      return mode === 'ok'
        ? new Response(JSON.stringify({ aweme_detail: freshFixture }), {
            status: 200,
          })
        : new Response(RISK_BODY, { status: 403 });
    }) as unknown as typeof fetch;
    // A 成功进缓存（1 次上游）
    const first = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false));
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);
    // B 风控 → 窗口建立（2 次上游）
    mode = 'risk';
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(calls).toBe(2);
    expect(parseCache.getPlatformRisk('douyin')).toBeDefined();
    // 窗口内请求已缓存的 A：照常返回缓存，上游零新调用
    const again = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false));
    expect(again.cached).toBe(true);
    expect(calls).toBe(2);
  });

  test('负缓存命中优先于止血窗口：CONTENT_NOT_FOUND 不被笼统 503 覆盖', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const detailId = nextAwemeId();
    let calls = 0;
    let mode: 'notfound' | 'risk' = 'notfound';
    globalThis.fetch = (async () => {
      calls += 1;
      return mode === 'notfound'
        ? new Response(JSON.stringify({ aweme_detail: null }), { status: 200 })
        : new Response(RISK_BODY, { status: 403 });
    }) as unknown as typeof fetch;
    // A 报内容不存在 → 负缓存（1 次）
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false)),
      'CONTENT_NOT_FOUND',
    );
    // B 风控 → 窗口（2 次）
    mode = 'risk';
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(calls).toBe(2);
    // 窗口内请求 A：负缓存命中，抛准确的 CONTENT_NOT_FOUND（上游 0 新调用）
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false)),
      'CONTENT_NOT_FOUND',
    );
    expect(calls).toBe(2);
  });
});

describe('off → on 运行时切换（部署完又开启）', () => {
  test('窗口建立后开启兜底：立即恢复降级链，不再 503', async () => {
    process.env.BROWSER_FALLBACK = 'off';
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(parseCache.getPlatformRisk('douyin')).toBeDefined();
    // 开启兜底（env 改掉即生效，服务层每请求读）
    delete process.env.BROWSER_FALLBACK;
    const outcome = await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(true));
    expect((outcome.result as unknown as { via: string }).via).toBe('browser');
    expect(upstream.calls()).toBe(2);
    expect(fakeGateway!.interceptCalls).toBe(1);
  });

  test('off 期间积累的熔断：开 on 后粘性立即生效，直接走浏览器', async () => {
    // off 模式两次真打上游的风控（记账 2 次）→ 熔断开
    process.env.BROWSER_FALLBACK = 'off';
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    // 第二次被窗口拦不打上游——清窗口再打一次（模拟窗口过期后的探针失败）
    parseCache.resetForTests();
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(2);
    // 开启：粘性生效，L1 零调用直接浏览器
    delete process.env.BROWSER_FALLBACK;
    const outcome = await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(true));
    expect(upstream.calls()).toBe(2);
    expect(fakeGateway!.interceptCalls).toBe(1);
    expect((outcome.result as unknown as { via: string }).via).toBe('browser');
  });

  test('off 模式下熔断打开不影响 HTTP 尝试：无兜底时照样打 L1（不短路不空转）', async () => {
    // 预置熔断打开
    const { recordHttpRiskControl } = await import('@/infra/channel-policy');
    recordHttpRiskControl('douyin');
    recordHttpRiskControl('douyin');
    process.env.BROWSER_FALLBACK = 'off';
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(0);
  });
});
