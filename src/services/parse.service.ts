import type { ParseResult } from '@/types/platform';
import { AppError } from '@/core/errors';
import { dispatch } from '@/platforms/registry';
import type { FetchCtx } from '@/types/platform';

/**
 * 解析编排：dispatch（短链展开）→ fetch → parse。
 * 通道选择与降级在平台 adapter 内部声明；这里只管流程与错误归一。
 */
export async function parseUrl(rawUrl: string, ctx: FetchCtx): Promise<ParseResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('INVALID_URL', `无法解析的链接: ${rawUrl.slice(0, 120)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', '仅支持 http(s) 链接');
  }

  const { adapter, input, url: finalUrl } = await dispatch(url, ctx);
  const started = Date.now();
  const payload = await adapter.fetch(input, finalUrl, ctx);
  const result = adapter.parse(payload, input);
  ctx.logger.info('parse done', {
    platform: result.platform,
    id: result.id,
    assets: result.assets.length,
    ms: Date.now() - started,
  });
  return result;
}
