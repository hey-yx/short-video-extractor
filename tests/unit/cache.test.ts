import { describe, expect, test } from 'bun:test';

import { AppError } from '@/core/errors';
import { cacheKey, ParseCache, ttlFor } from '@/services/cache';
import type { ParseResult } from '@/types/platform';

function result(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    platform: 'douyin',
    id: '7142091187963399427',
    kind: 'video',
    title: '测试',
    author: { name: '李子尘' },
    assets: [],
    parsedAt: Math.floor(Date.now() / 1000),
    via: 'http',
    ...overrides,
  };
}

describe('cache TTL', () => {
  test('无 expiresAt：默认 10min', () => {
    const now = 1_700_000_000_000;
    const ttl = ttlFor(result(), now);
    expect(ttl).toBe(10 * 60 * 1000);
  });

  test('有 expiresAt：min(剩余寿命, 30min)', () => {
    const now = 1_700_000_000_000;
    const in20min = now / 1000 + 20 * 60;
    const ttl = ttlFor(result({ expiresAt: in20min }), now);
    expect(ttl).toBe(20 * 60 * 1000);
  });

  test('长寿命直链封顶 30min', () => {
    const now = 1_700_000_000_000;
    const in6h = now / 1000 + 6 * 3600;
    expect(ttlFor(result({ expiresAt: in6h }), now)).toBe(30 * 60 * 1000);
  });

  test('已过期直链：TTL 0（不缓存死链）', () => {
    const now = 1_700_000_000_000;
    const past = now / 1000 - 60;
    expect(ttlFor(result({ expiresAt: past }), now)).toBe(0);
  });
});

describe('cache 命中与负缓存', () => {
  test('set 后 get 命中，值一致', () => {
    const c = new ParseCache();
    const r = result();
    c.set('douyin:1', r);
    expect(c.get('douyin:1')).toBe(r);
  });

  test('过死链不进缓存', () => {
    const c = new ParseCache();
    const past = Math.floor((Date.now() - 60 * 1000) / 1000);
    c.set('douyin:1', result({ expiresAt: past }));
    expect(c.get('douyin:1')).toBeUndefined();
  });

  test('负缓存：CONTENT_NOT_FOUND 十分钟内直接抛同 code', async () => {
    const c = new ParseCache();
    let calls = 0;
    const loader = async (): Promise<ParseResult> => {
      calls += 1;
      throw new AppError('CONTENT_NOT_FOUND', '作品不存在或已删除');
    };
    await expect(c.wrap('douyin:404', loader)).rejects.toBeInstanceOf(AppError);
    await expect(c.wrap('douyin:404', loader)).rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND' });
    expect(calls).toBe(1);
    expect(c.getError('douyin:404')).toBeDefined();
  });

  test('CONTENT_RESTRICTED 同样负缓存', async () => {
    const c = new ParseCache();
    const loader = async (): Promise<ParseResult> => {
      throw new AppError('CONTENT_RESTRICTED', '仅自己可见');
    };
    await expect(c.wrap('douyin:restricted', loader)).rejects.toBeInstanceOf(AppError);
    await expect(c.wrap('douyin:restricted', loader)).rejects.toMatchObject({ code: 'CONTENT_RESTRICTED' });
  });

  test('非稳定失败（风控/超时）不负缓存', async () => {
    const c = new ParseCache();
    const loader = async (): Promise<ParseResult> => {
      throw new AppError('RISK_CONTROL', '风控拦截');
    };
    await expect(c.wrap('douyin:risk', loader)).rejects.toBeInstanceOf(AppError);
    expect(c.getError('douyin:risk')).toBeUndefined();
  });
});

describe('singleflight', () => {
  test('同 key 并发只放一个请求去上游，结果共享', async () => {
    const c = new ParseCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loader = async (): Promise<ParseResult> => {
      calls += 1;
      await gate;
      return result({ id: 'sf' });
    };

    const [a, b, d] = await (async () => {
      const promises = [
        c.wrap('douyin:sf', loader),
        c.wrap('douyin:sf', loader),
        c.wrap('douyin:sf', loader),
      ];
      release();
      return Promise.all(promises);
    })();

    expect(calls).toBe(1);
    expect(a!.cached).toBe(false);
    expect(b!.cached).toBe(false);
    expect(d!.result.id).toBe('sf');

    // 飞行结束后再请求 = 缓存命中
    const e = await c.wrap('douyin:sf', loader);
    expect(e.cached).toBe(true);
    expect(calls).toBe(1);
  });

  test('不同 key 互不影响', async () => {
    const c = new ParseCache();
    const ids = ['a', 'b'];
    let calls = 0;
    const outcomes = await Promise.all(
      ids.map((id) =>
        c.wrap(`douyin:${id}`, async () => {
          calls += 1;
          return result({ id });
        }),
      ),
    );
    expect(calls).toBe(2);
    expect(outcomes.map((o) => o.result.id)).toEqual(['a', 'b']);
  });
});

describe('cacheKey', () => {
  test('platform:id 形态，与原始 URL 无关', () => {
    expect(cacheKey('douyin', '7142091187963399427', 'https://v.douyin.com/abc/')).toBe(
      'douyin:7142091187963399427',
    );
    // 同一视频两次分享 URL 参数全变，key 不变
    expect(cacheKey('douyin', '7142091187963399427', 'https://www.douyin.com/video/7142091187963399427?x=1')).toBe(
      'douyin:7142091187963399427',
    );
  });
});
