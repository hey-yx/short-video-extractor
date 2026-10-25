import { describe, expect, test } from 'bun:test';
import { bilibiliAdapter } from '@/platforms/bilibili/adapter';

const u = (s: string) => new URL(s);

describe('bilibili match（纯函数）', () => {
  test('长链 /video/BV… → 直取 BV 号', () => {
    const m = bilibiliAdapter.match(u('https://www.bilibili.com/video/BV1GJ411x7h7'));
    expect(m?.platform).toBe('bilibili');
    expect(m?.id).toBe('BV1GJ411x7h7');
    expect(m?.kind).toBe('video');
    expect(m?.needsResolve).toBe(false);
  });

  test('多 P 链接带 ?p=2 不影响 match（全 P 都出 asset）', () => {
    const m = bilibiliAdapter.match(
      u('https://www.bilibili.com/video/BV1bK411W797?p=2&spm_id_from=333.999.0.0'),
    );
    expect(m?.id).toBe('BV1bK411W797');
    expect(m?.needsResolve).toBe(false);
  });

  test('短链 b23.tv → needsResolve', () => {
    const m = bilibiliAdapter.match(u('https://b23.tv/AbCdEfG'));
    expect(m?.id).toBe('AbCdEfG');
    expect(m?.needsResolve).toBe(true);
  });

  test('老 .av 链接 → __av_ 标记（fetch 用 aid 查）', () => {
    const m = bilibiliAdapter.match(u('https://www.bilibili.com/video/av170001'));
    expect(m?.id).toBe('__av_170001');
    expect(m?.needsResolve).toBe(false);
  });

  test('番剧/非视频路径返回 null', () => {
    expect(bilibiliAdapter.match(u('https://www.bilibili.com/bangumi/play/ep123456'))).toBeNull();
    expect(bilibiliAdapter.match(u('https://example.com/video/BV1GJ411x7h7'))).toBeNull();
    expect(bilibiliAdapter.match(u('https://b23.tv/'))).toBeNull();
  });
});
