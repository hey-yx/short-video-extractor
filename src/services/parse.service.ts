import type { ParseResult } from '@/types/platform';
import { AppError } from '@/core/errors';
import { dispatch, matchAdapter } from '@/platforms/registry';
import { cacheKey, parseCache } from '@/services/cache';
import type { FetchCtx } from '@/types/platform';

export interface ParseOutcome {
  result: ParseResult;
  /** true = 缓存直接返回，未打上游 */
  cached: boolean;
}

/**
 * 解析编排：match（取缓存 key）→ 缓存/singleflight → dispatch（短链展开）→ fetch → parse。
 * 通道选择与降级在平台 adapter 内部声明；这里只管流程、缓存与错误归一。
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
    const { adapter: finalAdapter, input, url: finalUrl } = await dispatch(url, ctx);
    const started = Date.now();
    const payload = await finalAdapter.fetch(input, finalUrl, ctx);
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
