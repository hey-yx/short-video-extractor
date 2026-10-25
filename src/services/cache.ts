import { LRUCache } from 'lru-cache';

import { AppError } from '@/core/errors';
import type { ParseResult } from '@/types/platform';

/**
 * 解析结果缓存：LRU + 直链 expiresAt 语义 + 负缓存 + singleflight。
 * key 用 `platform:id`（research/03 §5.4：同一内容 URL 参数全变，原始 URL 不是稳定 key）。
 */

/** 直链最长按 30min 信任 */
const MAX_TTL_MS = 30 * 60 * 1000;
/** 读不出 expiresAt 时的默认 TTL */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** 负缓存（稳定失败）TTL */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
/** LRU 容量（research/03 §5.1：起步 max 5000） */
const MAX_ENTRIES = 5000;

/** 负缓存只收「重试也不会变结果」的稳定失败；风控/超时绝不缓存 */
const NEGATIVE_CODES = new Set(['CONTENT_NOT_FOUND', 'CONTENT_RESTRICTED']);

interface ValueEntry {
  kind: 'value';
  result: ParseResult;
}

interface ErrorEntry {
  kind: 'error';
  code: 'CONTENT_NOT_FOUND' | 'CONTENT_RESTRICTED';
  message: string;
}

type Entry = ValueEntry | ErrorEntry;

export interface CacheOutcome {
  /** true = 缓存直接返回，未打上游 */
  cached: boolean;
  result: ParseResult;
}

/** TTL = min(资源 expiresAt - now, 30min)；无 expiresAt 时 10min；≤0 = 直链已死不缓存 */
export function ttlFor(result: ParseResult, now = Date.now()): number {
  if (!result.expiresAt) return DEFAULT_TTL_MS;
  const remain = result.expiresAt * 1000 - now;
  return remain <= 0 ? 0 : Math.min(remain, MAX_TTL_MS);
}

const isNegativeCode = (code: string): code is ErrorEntry['code'] => NEGATIVE_CODES.has(code);

function negativeOf(err: unknown): ErrorEntry | null {
  if (err instanceof AppError && isNegativeCode(err.code)) {
    return { kind: 'error', code: err.code, message: err.message };
  }
  return null;
}

export class ParseCache {
  private readonly store = new LRUCache<string, Entry>({ max: MAX_ENTRIES });
  /** singleflight：同 key 并发只有一个在途解析 */
  private readonly inflight = new Map<string, Promise<ParseResult>>();

  get(key: string): ParseResult | undefined {
    const e = this.store.get(key);
    return e?.kind === 'value' ? e.result : undefined;
  }

  getError(key: string): ErrorEntry | undefined {
    const e = this.store.get(key);
    return e?.kind === 'error' ? e : undefined;
  }

  set(key: string, result: ParseResult): void {
    const ttl = ttlFor(result);
    if (ttl <= 0) return;
    this.store.set(key, { kind: 'value', result }, { ttl });
  }

  setNegative(key: string, err: unknown): void {
    const negative = negativeOf(err);
    if (!negative) return;
    this.store.set(key, negative, { ttl: NEGATIVE_TTL_MS });
  }

  /** 缓存命中 → 直接返回；未命中 → singleflight 只放一个请求去上游 */
  async wrap(key: string, loader: () => Promise<ParseResult>): Promise<CacheOutcome> {
    const hit = this.get(key);
    if (hit) return { cached: true, result: hit };

    const neg = this.getError(key);
    if (neg) throw new AppError(neg.code, neg.message);

    const pending = this.inflight.get(key);
    if (pending) return { cached: false, result: await pending };

    const flight = loader()
      .then((result) => {
        this.set(key, result);
        return result;
      })
      .catch((err: unknown) => {
        this.setNegative(key, err);
        throw err;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, flight);

    try {
      return { cached: false, result: await flight };
    } catch (err) {
      const negEntry = this.getError(key);
      if (negEntry) throw new AppError(negEntry.code, negEntry.message);
      throw err;
    }
  }
}

export const parseCache = new ParseCache();

/** `platform:id`；id 为空退回 URL（保证 key 非空且同一内容稳定） */
export function cacheKey(platform: string, id: string, fallbackUrl: string): string {
  const identity = id || fallbackUrl;
  return `${platform}:${identity}`;
}
