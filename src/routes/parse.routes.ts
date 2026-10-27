import { Elysia, t } from 'elysia';
import { ok } from '@/core/envelope';
import { parseUrl } from '@/services/parse.service';
import { browserGateway } from '@/infra/browser';
import { AppError } from '@/core/errors';
import { clientIp, ipRateLimiter } from '@/services/limiter';
import { asFetchLogger, requestLogger } from '@/infra/logger';
import { observeParseDuration, recordCacheHit, recordParse, recordUpstreamError } from '@/infra/metrics';
import { findPlatform } from '@/platforms/hosts';
import { resolveProxy } from '@/infra/proxy';
import { signIpBoundLinks } from '@/services/media-proxy';
import type { FetchCtx, Platform } from '@/types/platform';

/** 浏览器兜底开关：默认开；BROWSER_FALLBACK=off（大小写不敏感）时全平台纯 HTTP */
export function browserFallbackEnabled(): boolean {
  return (process.env.BROWSER_FALLBACK ?? '').trim().toLowerCase() !== 'off';
}

/** 解析通道上下文：pino 子 logger（带 requestId），浏览器能力由 infra 注入 */
const httpCtx = (request: Request, platform: Platform | null): FetchCtx => ({
  signal: AbortSignal.timeout(15_000),
  channel: 'http',
  // 需要浏览器的平台（小红书）从这里拿页面操作能力；平台包不见 puppeteer。
  // BROWSER_FALLBACK=off：不注入浏览器能力，风控走 503 如实报错（纯 HTTP 部署，
  // 免 Chrome 常驻内存；幂等读 env，测试里改环境变量后仍生效）
  browser: browserFallbackEnabled() ? browserGateway : undefined,
  logger: asFetchLogger(requestLogger(request)),
  // 海外平台出站代理（PROXY_<PLATFORM> → HTTPS_PROXY 兜底）；
  // YouTube 直链绑 IP，/media 中转经 resolveProxy 同源取值；平台包不读 env
  proxyUrl: platform ? resolveProxy(platform) : undefined,
  // Instagram 匿名 GraphQL doc_id（轮换配置，平台包不读 env）；未配置时 IG adapter 给可懂报错
  instagramDocId: process.env.IG_GRAPHQL_DOC_ID || undefined,
});

const UPSTREAM_CODES = new Set(['UPSTREAM_ERROR', 'UPSTREAM_CHANGED', 'UPSTREAM_TIMEOUT', 'RISK_CONTROL']);

/** 错误路径的平台归因：match 层拿不到 platform，从域名尽力识别 */
function guessPlatform(rawUrl: string): Platform | null {
  try {
    return findPlatform(new URL(rawUrl));
  } catch {
    return null;
  }
}

async function handleParse(
  rawUrl: string,
  request: Request,
  server?: { requestIP(request: Request): unknown } | null,
): Promise<{ success: boolean; data: unknown; cached?: boolean }> {
  const ctx = httpCtx(request, guessPlatform(rawUrl));
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
    // 绑 IP 直链（googlevideo）改写为签名 /media 链接：必须在缓存之后（签名 600s TTL，进缓存会存死）；
    // 未配 PROXY_SECRET 或无绑 IP 直链时原样返回，直链主路径不受影响
    const out = signIpBoundLinks(result, new URL(request.url).origin);
    return { ...ok(out), cached };
  } catch (error) {
    const platform = guessPlatform(rawUrl) ?? 'unknown';
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    recordParse(platform, code);
    observeParseDuration(platform, performance.now() - startedAt);
    if (UPSTREAM_CODES.has(code)) recordUpstreamError(platform, code);
    throw error;
  }
}

export const parseRoutes = new Elysia({ prefix: '/parse' })
  .post('/', ({ body, request, server }) => handleParse(body.url, request, server), {
    body: t.Object({ url: t.String({ minLength: 8 }) }),
  })
  .get('/', ({ query, request, server }) => handleParse(query.url, request, server), {
    query: t.Object({ url: t.String({ minLength: 8 }) }),
  });
