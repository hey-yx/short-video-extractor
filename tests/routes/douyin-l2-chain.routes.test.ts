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
 * 抖音 L1 → L2 → L3 三级降级链离线用例（假上游 + 假 gateway，不碰真网/真 Chrome）：
 *  - L1 风控 → L2 签名通道成功（零浏览器）；
 *  - L1+L2 都挂 → 浏览器兜底；
 *  - L2 签名失效（403 / 200 空 body）归 UPSTREAM_CHANGED，与 L1 的 RISK_CONTROL 区分；
 *  - 熔断粘性兼容三通道：粘住后跳 L1 直走 L2。
 */

createApp();

const RISK_BODY = 'Blocked by ArgusSecurityPlugin Uifid Not Found';
const realFetch = globalThis.fetch;
let idSeq = 0;
const nextAwemeId = () => `760${String(++idSeq).padStart(16, '0')}`;

const UIFID = 'uifid-fixture-value'.padEnd(160, '0');
const TTWID = '1%7Cttwid-fixture%7C1793100000%7Cdeadbeef';

interface FakeGateway {
  interceptCalls: number;
}

let fakeGateway: FakeGateway | null = null;

/** withL2 = ctx 带 DOUYIN_UIFID/DOUYIN_TTWID 注入（等价 env 配好身份） */
function makeCtx(withBrowser: boolean, withL2 = false): FetchCtx {
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
    ...(withL2 ? { douyinUifid: UIFID, douyinTtwid: TTWID } : {}),
  };
}

interface DetailCall {
  kind: 'l1' | 'l2';
  url: string;
}

/**
 * detail 假上游：L2 请求带 x-secsdk-web-signature，L1 不带；
 * handler 按通道分别响应（throw 模拟网络层失败）。
 */
function stubDetail(
  handler: (call: DetailCall) => Response | Promise<Response>,
): { calls: () => DetailCall[]; byKind: (kind: 'l1' | 'l2') => number } {
  const calls: DetailCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      const kind: 'l1' | 'l2' = url.includes('x-secsdk-web-signature=') ? 'l2' : 'l1';
      calls.push({ kind, url });
      return handler({ kind, url });
    }
    throw new TypeError(`fetch failed (unexpected url: ${url})`);
  }) as typeof fetch;
  return {
    calls: () => calls,
    byKind: (kind) => calls.filter((c) => c.kind === kind).length,
  };
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
  resetChannelPolicyForTests();
  parseCache.resetForTests();
  fakeGateway = { interceptCalls: 0 };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('L1 → L2 降级（L2 成功，零浏览器）', () => {
  test('L1 风控 → L2 成功：via=http-l2，不打浏览器，降级打点 http-l1→http-l2', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : okDetail(detailId),
    );
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(true, true));
    const result = outcome.result as unknown as { via: string; id: string };
    expect(result.via).toBe('http-l2');
    expect(result.id).toBe(detailId);
    expect(upstream.byKind('l1')).toBe(1);
    expect(upstream.byKind('l2')).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(0);
    const text = metrics.render();
    expect(text).toContain('channel_downgrade_total{platform="douyin",from="http-l1",to="http-l2"} 1');
    expect(text).not.toContain('to="browser"');
  });

  test('L2 请求带完整配方：uifid + timestamp + 签名 + ttwid cookie（无 a_bogus/msToken）', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : okDetail(detailId),
    );
    await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(false, true));
    const l2 = upstream.calls().find((c) => c.kind === 'l2')!;
    expect(l2.url).toContain(`uifid=${UIFID}`);
    expect(l2.url).toContain('timestamp=');
    expect(l2.url).toMatch(/x-secsdk-web-signature=[0-9a-f]{32}/);
    expect(l2.url).not.toContain('msToken=');
    expect(l2.url).not.toContain('a_bogus=');
    expect(l2.url).toContain('device_platform=webapp');
    expect(l2.url).toContain(`aweme_id=${detailId}`);
  });

  test('L1 正常路径不受影响：via=http，不打 L2', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? okDetail(detailId) : new Response('L2 should not be called', { status: 500 }),
    );
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(true, true));
    expect((outcome.result as unknown as { via: string }).via).toBe('http');
    expect(upstream.byKind('l1')).toBe(1);
    expect(upstream.byKind('l2')).toBe(0);
  });
});

describe('L2 失效 → 浏览器兜底（L3）', () => {
  test('L1 风控 + L2 403 Sign Invalid → 浏览器兜底，两级降级打点各一', async () => {
    const detailId = nextAwemeId();
    stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : new Response('Blocked by ArgusSecurityPlugin Sign Invalid', { status: 403 }),
    );
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(true, true));
    expect((outcome.result as unknown as { via: string }).via).toBe('browser');
    expect(fakeGateway!.interceptCalls).toBe(1);
    const text = metrics.render();
    expect(text).toContain('channel_downgrade_total{platform="douyin",from="http-l1",to="http-l2"} 1');
    expect(text).toContain('channel_downgrade_total{platform="douyin",from="http-l2",to="browser"} 1');
  });

  test('L2 200 + 空 body（静默拒绝）→ 当失败落浏览器，不误判成功', async () => {
    const detailId = nextAwemeId();
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : new Response('', { status: 200 }),
    );
    const outcome = await parseUrl(`https://www.douyin.com/video/${detailId}`, makeCtx(true, true));
    expect((outcome.result as unknown as { via: string }).via).toBe('browser');
    expect(upstream.byKind('l2')).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(1);
  });
});

describe('L2 签名失效分类（与 L1 风控信号区分）', () => {
  test('L1 风控 + L2 403 + 无浏览器：UPSTREAM_CHANGED 原样上抛（不是 RISK_CONTROL）', async () => {
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : new Response('Blocked by ArgusSecurityPlugin Sign Invalid', { status: 403 }),
    );
    const err = await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false, true)),
      'UPSTREAM_CHANGED',
    );
    expect(err.message).toContain('L2 签名失效');
    expect(upstream.byKind('l2')).toBe(1);
    expect(fakeGateway!.interceptCalls).toBe(0);
  });

  test('L2 200 空 body + 无浏览器：UPSTREAM_CHANGED（静默拒绝归签名失效）', async () => {
    stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : new Response('', { status: 200 }),
    );
    await expectAppError(
      parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false, true)),
      'UPSTREAM_CHANGED',
    );
  });
});

describe('熔断粘性兼容三通道', () => {
  test('连续 2 次 L1 风控（L2 成功）后：第 3 次跳过 L1 直走 L2', async () => {
    const upstream = stubDetail((call) =>
      call.kind === 'l1' ? new Response(RISK_BODY, { status: 403 }) : okDetail(nextAwemeId()),
    );
    await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false, true));
    await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false, true));
    // 前两次：L1 403 + L2 成功，各 2 记
    expect(upstream.byKind('l1')).toBe(2);
    expect(upstream.byKind('l2')).toBe(2);
    // 第三次：熔断粘性生效，L1 零调用，直接 L2
    const outcome = await parseUrl(`https://www.douyin.com/video/${nextAwemeId()}`, makeCtx(false, true));
    expect(upstream.byKind('l1')).toBe(2);
    expect(upstream.byKind('l2')).toBe(3);
    expect((outcome.result as unknown as { via: string }).via).toBe('http-l2');
    expect(fakeGateway!.interceptCalls).toBe(0);
  });
});
