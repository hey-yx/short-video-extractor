import type { ParseResult } from '@/types/platform';
import { AppError } from '@/core/errors';
import { recordParseRetry } from '@/infra/metrics';
import { recordHttpRiskControl, recordHttpSuccess } from '@/infra/channel-policy';
import { dispatch, matchAdapter } from '@/platforms/registry';
import { cacheKey, parseCache } from '@/services/cache';
import type { FetchCtx } from '@/types/platform';

export interface ParseOutcome {
  result: ParseResult;
  /** true = 缓存直接返回，未打上游 */
  cached: boolean;
}

/** 只重试瞬态网络层失败（网络抖动/上游 5xx）；重试风控=加重风控，重试 404=浪费 */
const RETRYABLE_CODES = new Set(['UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR']);

/** 退避节奏（毫秒）：第 1 次重试前 500ms，第 2 次 1s（当前上限 1 次，留作节奏定义） */
const RETRY_BACKOFF_MS = [500, 1000];

/** 退避等待：受 ctx.signal 约束（15s 总上限到期立即放弃，不拖过请求时限） */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 解析编排：match（取缓存 key）→ 缓存/singleflight → dispatch（短链展开）→ fetch → parse。
 * 通道选择与降级在平台 adapter 内部声明；这里只管流程、缓存、瞬态重试与错误归一。
 */
export async function parseUrl(rawUrl: string, ctx: FetchCtx): Promise<ParseOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('INVALID_URL', `无法解析的链接: ${rawUrl.slice(0, 120)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', '仅支持 http(s) 链接');
  }

  const adapter = matchAdapter(url);
  if (!adapter) {
    throw new AppError('UNSUPPORTED_PLATFORM', `无法识别的平台: ${url.hostname}`, { host: url.hostname });
  }
  const matched = adapter.match(url);
  if (!matched) {
    throw new AppError('INVALID_URL', `链接格式不属于 ${adapter.platform}`, {
      url: url.href,
    });
  }
  const key = cacheKey(matched.platform, matched.id, url.href);

  const { cached, result } = await parseCache.wrap(key, async () => {
    // 平台风控止血窗口：无兜底可用时刚命中风控后，窗口内所有请求直接 503，不撞上游
    //（重试风控=加重风控）。放 loader 开头：缓存/负缓存/singleflight 命中都还能正常返回，
    // 只拦真正要打上游的请求。有浏览器兜底时不拦——降级在 adapter 内部消化，BROWSER_FALLBACK
    // 开关切换后（off→on）窗口自动失效，立即恢复降级链。
    const risk = parseCache.getPlatformRisk(adapter.platform);
    if (!ctx.browser && risk) throw new AppError('RISK_CONTROL', risk.message);

    const { adapter: finalAdapter, input, url: finalUrl } = await dispatch(url, ctx);
    const started = Date.now();
    let payload;
    try {
      payload = await finalAdapter.fetch(input, finalUrl, ctx);
    } catch (err) {
      // 瞬态失败重试 1 次（指数退避）；RISK_CONTROL / CONTENT_* / INVALID_* 一律不重试
      const retryable = err instanceof AppError && RETRYABLE_CODES.has(err.code) && !ctx.signal.aborted;
      if (!retryable) {
        // 真打了上游且最终风控：进熔断记账（半开态探针失败重新粘住）+ 平台止血窗口
        if (err instanceof AppError && err.code === 'RISK_CONTROL') {
          recordHttpRiskControl(finalAdapter.platform);
          parseCache.setPlatformRisk(finalAdapter.platform, err);
        }
        throw err;
      }
      ctx.logger.warn('transient upstream error, retrying once', {
        platform: finalAdapter.platform,
        code: err.code,
      });
      recordParseRetry(finalAdapter.platform);
      await backoff(RETRY_BACKOFF_MS[0]!, ctx.signal);
      try {
        payload = await finalAdapter.fetch(input, finalUrl, ctx);
      } catch (retryErr) {
        if (retryErr instanceof AppError && retryErr.code === 'RISK_CONTROL') {
          recordHttpRiskControl(finalAdapter.platform);
          parseCache.setPlatformRisk(finalAdapter.platform, retryErr);
        }
        throw retryErr;
      }
    }
    // 上游成功：只有 HTTP 主通道成功才清熔断计数（半开态探针试探成功 = 回到纯 HTTP）；
    // 浏览器兜底成功不清——L1 仍然是被风控状态，不能误清粘性
    if (payload.channel === 'http') recordHttpSuccess(finalAdapter.platform);
    const parsed = finalAdapter.parse(payload, input);
    // 短链 key 与展开后的稳定 id 不同：回填一份，长短链共享缓存
    const canonical = cacheKey(parsed.platform, parsed.id, finalUrl.href);
    if (canonical !== key) parseCache.set(canonical, parsed);
    ctx.logger.info('parse done', {
      platform: parsed.platform,
      id: parsed.id,
      assets: parsed.assets.length,
      ms: Date.now() - started,
    });
    return parsed;
  });
  return { result, cached };
}
