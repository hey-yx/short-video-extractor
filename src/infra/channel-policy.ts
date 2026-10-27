/**
 * 通道策略（research/04 §2 降级判定 + §6 熔断建议的落地）：
 *  1. 浏览器兜底总开关：BROWSER_FALLBACK=off 时 FetchCtx.browser 注入为 undefined，
 *     平台 adapter 检测到无浏览器能力后走「如实报错」路径，行为与无 puppeteer 部署一致。
 *  2. 平台级熔断粘性：HTTP 通道连续 N 次（默认 2）命中风控信号后，本周期内固定走浏览器，
 *     探针周期（默认 60s）到点放一个请求回 HTTP 通道试探——避免口子被堵期间每个请求都
 *     先吃一次 403 再冷启动浏览器（每请求 1–3s 冷启动 + 加重风控画像）。
 *
 * 状态放本模块内存：单进程 Bun 部署（README 部署章），多副本时各副本独立收敛，可接受。
 */

import type { Platform } from '@/types/platform';

/** 连续失败几次后熔断（research/04 建议：连续 2 次） */
const BREAKER_THRESHOLD = 2;
/** 熔断后探针回切周期（毫秒）：到点放一个请求回 HTTP 试探 */
const PROBE_INTERVAL_MS = 60_000;

interface BreakerState {
  /** 连续命中风控信号的次数（成功归零） */
  consecutiveFailures: number;
  /** 熔断开始时刻（毫秒）；null = 未熔断 */
  openedAt: number | null;
}

const breakers = new Map<Platform, BreakerState>();

function stateOf(platform: Platform): BreakerState {
  let s = breakers.get(platform);
  if (!s) {
    s = { consecutiveFailures: 0, openedAt: null };
    breakers.set(platform, s);
  }
  return s;
}

/**
 * HTTP 通道发请求前问一句：这个平台现在是不是处于「固定走浏览器」状态。
 * 半开态（探针周期到点）返回 false，放当前这个请求回 HTTP 试探。
 */
export function shouldSkipHttp(platform: Platform, now = Date.now()): boolean {
  const s = breakers.get(platform);
  if (!s || s.openedAt === null) return false;
  if (now - s.openedAt >= PROBE_INTERVAL_MS) {
    // 探针窗口：放行 HTTP 试探；失败会在 recordHttpRiskControl 里重新熔断
    s.openedAt = null;
    return false;
  }
  return true;
}

/** HTTP 通道命中风控信号（403 Argus / 登录墙连续拒）：计入并按阈值熔断；now 可注入（单测） */
export function recordHttpRiskControl(platform: Platform, now = Date.now()): void {
  const s = stateOf(platform);
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= BREAKER_THRESHOLD) {
    s.openedAt = now;
  }
}

/** HTTP 通道成功：计数清零（熔断打开时调用说明探针试探成功，回到纯 HTTP） */
export function recordHttpSuccess(platform: Platform): void {
  const s = stateOf(platform);
  s.consecutiveFailures = 0;
  s.openedAt = null;
}

/** 观测：/metrics 与调试用，读状态不改状态 */
export function breakerSnapshot(): ReadonlyMap<Platform, BreakerState> {
  return breakers;
}

/** 单测隔离用 */
export function resetChannelPolicyForTests(): void {
  breakers.clear();
}
