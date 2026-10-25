import { Elysia, t } from 'elysia';
import { ok } from '@/core/envelope';
import { parseUrl } from '@/services/parse.service';
import type { FetchCtx } from '@/types/platform';

/** 最小日志实现（P5 换 pino，接口先冻结） */
const consoleCtx = (): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  logger: {
    info: (m, d) => console.log(`[info] ${m}`, d ?? ''),
    warn: (m, d) => console.warn(`[warn] ${m}`, d ?? ''),
    error: (m, d) => console.error(`[error] ${m}`, d ?? ''),
  },
});

export const parseRoutes = new Elysia({ prefix: '/parse' })
  .post(
    '/',
    async ({ body }) => ok(await parseUrl(body.url, consoleCtx())),
    { body: t.Object({ url: t.String({ minLength: 8 }) }) },
  )
  .get('/', async ({ query }) => ok(await parseUrl(query.url, consoleCtx())), {
    query: t.Object({ url: t.String({ minLength: 8 }) }),
  });
