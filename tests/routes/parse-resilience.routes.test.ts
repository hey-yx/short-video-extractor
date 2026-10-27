import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { parseUrl } from '@/services/parse.service';
import { metrics } from '@/infra/metrics';
import { resetChannelPolicyForTests } from '@/infra/channel-policy';
import { parseCache } from '@/services/cache';
import { AppError } from '@/core/errors';
import type { FetchCtx } from '@/types/platform';
import fixture from '../fixtures/douyin/aweme-video.json';

/**
 * 稳定性加固离线用例：抖音 L1 风控 → 浏览器兜底降级 + 瞬态错误重试。
 * 走 parseUrl 服务层：fetch 打假上游，ctx.browser 注入假 gateway，全程不碰真网/真 Chrome。
 */

// 平台 adapter 在 createApp() 里注册进 registry；服务层直测同样要先注册
createApp();

interface EnvelopeResult {
  platform: string;
  via: string;
  id: string;
  assets: unknown[];
}

const RISK_BODY = 'Blocked by ArgusSecurityPlugin Uifid Not Found';

const realFetch = globalThis.fetch;
let idSeq = 0;

/** 假 aweme_id（19 位数字），每个用例独立防缓存串扰 */
const nextAwemeId = () => `740${String(++idSeq).padStart(16, '0')}`;

interface FakeGateway {
  interceptCalls: number;
  urls: string[];
}

let fakeGateway: FakeGateway | null = null;

/** 组装 FetchCtx：browser 传 null 表示「无浏览器环境」 */
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
              fakeGateway!.urls.push(url);
              return { aweme_detail: { ...fixture.aweme_detail, aweme_id: nextAwemeId() } };
            },
          }
        : undefined,
    logger: { info() {}, warn() {}, error() {} },
  };
}

/** detail 接口假上游；handler 返回 Response 或直接 throw（模拟网络层失败） */
function stubDetail(handler: (call: number) => Response | Promise<Response>): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      calls += 1;
      return handler(calls);
    }
    throw new TypeError(`fetch failed (unexpected url: ${url})`);
  }) as typeof fetch;
  return { calls: () => calls };
}

const okDetail = (id: string): Response =>
  new Response(JSON.stringify({ aweme_detail: { ...fixture.aweme_detail, aweme_id: id } }), { status: 200 });

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
  // 通道熔断与平台止血是跨用例共享的单例状态：不重置会串扰（前面用例的风控窗口
  // 让后面用例直接 503、上游 0 调用）
  resetChannelPolicyForTests();
  parseCache.resetForTests();
  fakeGateway = { interceptCalls: 0, urls: [] };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('抖音浏览器兜底降级（L1 风控）', () => {
  test('风控 + 浏览器可用：自动降级成功，via=browser，channel_downgrade_total=1', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    const ctx = makeCtx(true);
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, ctx);
    const result = outcome.result as unknown as EnvelopeResult;
    expect(result.platform).toBe('douyin');
    expect(result.via).toBe('browser');
    expect(result.assets.length).toBeGreaterThan(0);
    expect(upstream.calls()).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(1);
    expect(fakeGateway!.urls[0]).toContain('www.douyin.com');
    const text = metrics.render();
    expect(text).toContain('channel_downgrade_total{platform="douyin",from="http",to="browser"} 1');
  });

  test('风控 + 浏览器可用但通道失败：失败如实上抛，不静默吞掉', async () => {
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    // interceptJson 直接抛 AppError（UPSTREAM_CHANGED）：adapter 原样上抛，service 不重试
    fakeGateway = { interceptCalls: 0, urls: [] };
    const ctx = makeCtx(true);
    const gateway = ctx.browser!;
    gateway.interceptJson = async () => {
      fakeGateway!.interceptCalls += 1;
      throw new AppError('UPSTREAM_CHANGED', '浏览器未截到 detail XHR');
    };
    await expectAppError(parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, ctx), 'UPSTREAM_CHANGED');
    expect(upstream.calls()).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(1);
  });

  test('风控 + 无浏览器环境：RISK_CONTROL 原样返回（503），不降级', async () => {
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    const err = await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(err.message).toContain('风控');
    expect(upstream.calls()).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(0);
    expect(metrics.render()).not.toContain('channel_downgrade_total{platform="douyin"');
  });
});

describe('瞬态错误重试（parse.service 层）', () => {
  test('UPSTREAM_ERROR（上游 5xx）：重试 1 次后成功，parse_retry_total=1', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail((call) =>
      call === 1 ? new Response('boom', { status: 502 }) : okDetail(detailId),
    );
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false));
    expect((outcome.result as unknown as EnvelopeResult).id).toBe(detailId);
    expect(upstream.calls()).toBe(2);
    expect(metrics.render()).toContain('parse_retry_total{platform="douyin"} 1');
  });

  test('UPSTREAM_TIMEOUT：重试后仍失败，原码上抛且只重试一次', async () => {
    const upstream = stubDetail(() => new Response('gateway timeout', { status: 504 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'UPSTREAM_ERROR',
    );
    expect(upstream.calls()).toBe(2);
    expect(metrics.render()).toContain('parse_retry_total{platform="douyin"} 1');
  });

  test('网络层异常：归一 UPSTREAM_TIMEOUT 并重试 1 次', async () => {
    const upstream = stubDetail(() => {
      throw new TypeError('fetch failed');
    });
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'UPSTREAM_TIMEOUT',
    );
    expect(upstream.calls()).toBe(2);
    expect(metrics.render()).toContain('parse_retry_total{platform="douyin"} 1');
  });

  test('RISK_CONTROL 不重试：重试风控=加重风控', async () => {
    const upstream = stubDetail(() => new Response(RISK_BODY, { status: 403 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'RISK_CONTROL',
    );
    expect(upstream.calls()).toBe(1);
    expect(metrics.render()).not.toContain('parse_retry_total{platform=');
  });

  test('CONTENT_NOT_FOUND 不重试：稳定失败只打一次上游', async () => {
    const upstream = stubDetail(() => new Response(JSON.stringify({ aweme_detail: null }), { status: 200 }));
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false)),
      'CONTENT_NOT_FOUND',
    );
    expect(upstream.calls()).toBe(1);
  });

  test('signal 已取消：不重试，AbortError 原样上抛', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw controller.signal.reason ?? new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const ctx: FetchCtx = { ...makeCtx(false), signal: controller.signal };
    try {
      await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, ctx);
      expect.unreachable();
    } catch (e) {
      expect(e).not.toBeInstanceOf(AppError);
    }
    expect(calls).toBe(1);
  });
});
