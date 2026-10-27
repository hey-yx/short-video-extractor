import { beforeEach, describe, expect, test } from 'bun:test';

import {
  breakerSnapshot,
  recordHttpRiskControl,
  recordHttpSuccess,
  resetChannelPolicyForTests,
  shouldSkipHttp,
} from '@/infra/channel-policy';

/**
 * 通道熔断粘性状态机离线用例：连续风控 → 熔断（粘浏览器）→ 探针回切 → 成功清除。
 * 时间用注入 now 控制，不真实 sleep。
 */

const now = { t: 1_700_000_000_000 };
const tick = (ms: number) => {
  now.t += ms;
};

beforeEach(() => {
  resetChannelPolicyForTests();
});

/** 用注入时钟记账（与 shouldSkipHttp 的 now 同源，测试不依赖真时钟） */
const riskAt = (platform: Parameters<typeof recordHttpRiskControl>[0]) =>
  recordHttpRiskControl(platform, now.t);

describe('熔断粘性状态机', () => {
  test('初始状态：不跳过 HTTP', () => {
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
  });

  test('1 次风控未达阈值：不熔断', () => {
    riskAt('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
  });

  test('连续 2 次风控：熔断粘住浏览器', () => {
    riskAt('douyin');
    riskAt('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(true);
  });

  test('其他平台互不影响', () => {
    riskAt('douyin');
    riskAt('douyin');
    expect(shouldSkipHttp('xhs', now.t)).toBe(false);
    expect(shouldSkipHttp('kuaishou', now.t)).toBe(false);
  });

  test('半开态：探针周期到点放行一次 HTTP 试探', () => {
    riskAt('douyin');
    riskAt('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(true);
    // 60s 探针窗口到点：放行
    tick(60_001);
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
    // 窗口内后续请求视为仍在试探周期：继续放行（recordHttpRiskControl 会重新熔断若失败）
  });

  test('探针试探失败：重新熔断，回到粘浏览器', () => {
    riskAt('douyin');
    riskAt('douyin');
    tick(60_001);
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
    riskAt('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(true);
  });

  test('探针试探成功：清零计数与熔断', () => {
    riskAt('douyin');
    riskAt('douyin');
    tick(60_001);
    recordHttpSuccess('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
    expect(breakerSnapshot().get('douyin')?.openedAt).toBeNull();
    expect(breakerSnapshot().get('douyin')?.consecutiveFailures).toBe(0);
  });

  test('熔断未到探针周期：成功也会清除（HTTP 全程成功路径兜底）', () => {
    riskAt('douyin');
    riskAt('douyin');
    recordHttpSuccess('douyin');
    expect(shouldSkipHttp('douyin', now.t)).toBe(false);
  });
});
