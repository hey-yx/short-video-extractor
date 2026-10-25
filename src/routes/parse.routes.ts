import { Elysia, t } from 'elysia';
import { ok } from '@/core/envelope';
import { parseUrl } from '@/services/parse.service';
import { browserGateway } from '@/infra/browser';
import { AppError } from '@/core/errors';
import { clientIp, ipRateLimiter } from '@/services/limiter';
import { asFetchLogger, requestLogger } from '@/infra/logger';
import {
  observeParseDuration,
  recordCacheHit,
  recordParse,
  recordUpstreamError,
} from '@/infra/metrics';
import { findPlatform } from '@/platforms/hosts';
import type { FetchCtx } from '@/types/platform';

/** 解析通道上下文：pino 子 logger（带 requestId），浏览器能力由 infra 注入 */
const httpCtx = (request: Request): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  // 需要浏览器的平台（小红书）从这里拿页面操作能力；平台包不见 puppeteer
  browser: browserGateway,
  logger: asFetchLogger(requestLogger(request)),
});

const UPSTREAM_CODES = new Set(['UPSTREAM_ERROR', 'UPSTREAM_CHANGED', 'UPSTREAM_TIMEOUT', 'RISK_CONTROL']);

/** 错误路径的平台归因：match 层拿不到 platform，从域名尽力识别 */
function guessPlatform(rawUrl: string): string {
  try {
    return findPlatform(new URL(rawUrl)) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function handleParse(
  rawUrl: string,
  request: Request,
  server?: { requestIP(request: Request): unknown } | null,
): Promise<{ success: boolean; data: unknown; cached?: boolean }> {
  const ctx = httpCtx(request);
  const ip = clientIp(request.headers, request, server);
  if (!ipRateLimiter.take(ip)) {
    throw new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', { ip });
  }
  const startedAt = performance.now();
  try {
    // 缓存/singleflight 在 parseUrl 内部（cache.wrap 包住上游 fetch+parse）
    const { result, cached } = await parseUrl(rawUrl, ctx);
    recordParse(result.platform, 'ok');
    observeParseDuration(result.platform, performance.now() - startedAt);
    if (cached) recordCacheHit();
    return { ...ok(result), cached };
  } catch (error) {
    const platform = guessPlatform(rawUrl);
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    recordParse(platform, code);
    observeParseDuration(platform, performance.now() - startedAt);
    if (UPSTREAM_CODES.has(code)) recordUpstreamError(platform, code);
    throw error;
  }
}

export const parseRoutes = new Elysia({ prefix: '/parse' })
  .post(
    '/',
    ({ body, request, server }) => handleParse(body.url, request, server),
    { body: t.Object({ url: t.String({ minLength: 8 }) }) },
  )
  .get('/', ({ query, request, server }) => handleParse(query.url, request, server), {
    query: t.Object({ url: t.String({ minLength: 8 }) }),
  });
