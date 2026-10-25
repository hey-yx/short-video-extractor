import { Elysia } from 'elysia';
import { listAdapters } from '@/platforms/registry';
import { ok } from '@/core/envelope';
import { metrics } from '@/infra/metrics';

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
      })),
    ),
  )
  // Prometheus 文本格式指标（自写渲染，PLAN §14）
  .get('/metrics', ({ set }) => {
    set.headers['content-type'] = 'text/plain; version=0.0.4; charset=utf-8';
    return metrics.render();
  });
