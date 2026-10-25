import { Elysia } from 'elysia';
import { listAdapters } from '@/platforms/registry';

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
  // 平台自描述（调试与文档用）
  .get('/platforms', () =>
    listAdapters().map((a) => ({
      platform: a.platform,
      description: a.description,
      hosts: a.hosts,
      capabilities: a.capabilities,
    })),
  );
