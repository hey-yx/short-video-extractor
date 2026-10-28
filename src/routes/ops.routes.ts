import { Elysia } from 'elysia';
import { listAdapters } from '@/platforms/registry';
import { listSigners } from '@/core/signers';
import { ok } from '@/core/envelope';
import { metrics, recordChannelBreaker } from '@/infra/metrics';
import { breakerSnapshot } from '@/infra/channel-policy';
import type { Platform } from '@/types/platform';

const ALL_PLATFORMS: Platform[] = [
  'douyin',
  'xhs',
  'kuaishou',
  'bilibili',
  'weibo',
  'twitter',
  'youtube',
  'instagram',
  'tiktok',
];

/** 熔断状态刷进 gauge：开着的记 1，关着的记 0（保证 Prometheus 抓得到回落） */
function publishBreakerGauges(): void {
  const snapshot = breakerSnapshot();
  for (const p of ALL_PLATFORMS) {
    const s = snapshot.get(p);
    recordChannelBreaker(p, s?.openedAt !== undefined && s.openedAt !== null);
  }
}

export const opsRoutes = new Elysia()
  // 存活探针：进程活着就 200，不查外部依赖（防外部抖动引发连环重启）
  .get('/health', () => ({ status: 'ok', uptime: process.uptime() }))
  // 就绪探针：平台注册齐才 200
  .get('/ready', ({ set }) => {
    const n = listAdapters().length;
    if (n === 0) {
      set.status = 503;
      return { status: 'degraded', platforms: 0 };
    }
    return { status: 'ready', platforms: n };
  })
  // 平台自描述（调试与文档用；统一信封）
  .get('/platforms', () =>
    ok(
      listAdapters().map((a) => ({
        platform: a.platform,
        description: a.description,
        hosts: a.hosts,
        capabilities: a.capabilities,
        // 签名器自述：签名失效（403 Sign Invalid）时先看这里的 name/version/available
        signers: listSigners(a.platform).map((s) => ({
          name: s.name,
          version: s.version,
          available: s.isAvailable(),
        })),
      })),
    ),
  )
  // Prometheus 文本格式指标（自写渲染）
  .get('/metrics', ({ set }) => {
    set.headers['content-type'] = 'text/plain; version=0.0.4; charset=utf-8';
    publishBreakerGauges();
    return metrics.render();
  });
