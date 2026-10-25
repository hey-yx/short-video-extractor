import { AppError } from '@/core/errors';
import type { FetchCtx, MatchResult, Platform, PlatformAdapter, RawPayload, ParseResult } from '@/types/platform';
import { findPlatform } from './hosts';

const adapters: PlatformAdapter[] = [];

/** 注册适配器（启动时调用；顺序即 match 优先级） */
export function register(adapter: PlatformAdapter): void {
  if (adapters.some((a) => a.platform === adapter.platform)) {
    throw new Error(`platform already registered: ${adapter.platform}`);
  }
  adapters.push(adapter);
}

export function listAdapters(): readonly PlatformAdapter[] {
  return adapters;
}

export function getAdapter(platform: Platform): PlatformAdapter {
  const a = adapters.find((x) => x.platform === platform);
  if (!a) throw new AppError('UNSUPPORTED_PLATFORM', `平台未注册: ${platform}`);
  return a;
}

/** 按域名找适配器 */
export function matchAdapter(url: URL): PlatformAdapter | null {
  return adapters.find((a) => findPlatform(url) === a.platform) ?? null;
}

/**
 * 短链 → 最终 URL → 再匹配；带深度上限防环。
 * 与 yt-dlp 的 url_result 委托语义一致：resolve 只负责一跳，不嵌套解析。
 */
export async function dispatch(
  url: URL,
  ctx: FetchCtx,
  depth = 0,
): Promise<{ adapter: PlatformAdapter; input: MatchResult; url: URL }> {
  if (depth > 3) {
    throw new AppError('INVALID_URL', '短链跳转超过 3 层，疑似循环', { url: url.href });
  }
  const adapter = matchAdapter(url);
  if (!adapter) {
    throw new AppError('UNSUPPORTED_PLATFORM', `无法识别的平台: ${url.hostname}`, { host: url.hostname });
  }
  const input = adapter.match(url);
  if (!input) {
    throw new AppError('INVALID_URL', `链接格式不属于 ${adapter.platform}`, { url: url.href });
  }
  if (!input.needsResolve || !adapter.resolve) {
    return { adapter, input, url };
  }
  const finalUrl = await adapter.resolve(url, ctx);
  const next = matchAdapter(finalUrl);
  if (!next) {
    throw new AppError('UNSUPPORTED_PLATFORM', `短链展开后无法识别: ${finalUrl.hostname}`, {
      host: finalUrl.hostname,
    });
  }
  return dispatch(finalUrl, ctx, depth + 1);
}

/** 完整解析：fetch + parse */
export async function resolvePayload(
  adapter: PlatformAdapter,
  input: MatchResult,
  url: URL,
  ctx: FetchCtx,
): Promise<RawPayload> {
  return adapter.fetch(input, url, ctx);
}

export type { ParseResult };
