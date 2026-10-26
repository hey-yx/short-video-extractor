import { describe, expect, test } from 'bun:test';
import { tiktokAdapter } from '@/platforms/tiktok/adapter';
import { findPlatform } from '@/platforms/hosts';

const u = (s: string) => new URL(s);

describe('tiktok match（纯函数）', () => {
  test('/@user/video/<id> 长链直取 id', () => {
    const m = tiktokAdapter.match(u('https://www.tiktok.com/@nasa/video/7665075736742530317'));
    expect(m).toEqual({
      platform: 'tiktok',
      id: '7665075736742530317',
      kind: 'unknown',
      needsResolve: false,
    });
  });

  test('/@user/photo/<id>（图集）与 /video/ 同 id 空间', () => {
    const m = tiktokAdapter.match(u('https://www.tiktok.com/@dx_r13/photo/7398188624526724358'));
    expect(m?.id).toBe('7398188624526724358');
    expect(m?.needsResolve).toBe(false);
  });

  test('query 参数与 m.tiktok.com 子域不影响 match', () => {
    const m = tiktokAdapter.match(
      u('https://www.tiktok.com/@nasa/video/7665075736742530317?is_from_webapp=1&sender_device=pc'),
    );
    expect(m?.id).toBe('7665075736742530317');
    expect(tiktokAdapter.match(u('https://m.tiktok.com/@nasa/video/7665075736742530317'))?.id).toBe(
      '7665075736742530317',
    );
  });

  test('vm./vt. 短链 needsResolve', () => {
    const m1 = tiktokAdapter.match(u('https://vm.tiktok.com/ZMkHSh5t1/'));
    const m2 = tiktokAdapter.match(u('https://vt.tiktok.com/ZSjSKrdXn/'));
    expect(m1?.platform).toBe('tiktok');
    expect(m1?.needsResolve).toBe(true);
    expect(m1?.id).toBe('ZMkHSh5t1');
    expect(m2?.needsResolve).toBe(true);
  });

  test('短链 302 展开出的空用户名形态 /@/video/<id>、/@/photo/<id> 也匹配', () => {
    expect(tiktokAdapter.match(u('https://www.tiktok.com/@/video/7430175321334369537?_r=1'))?.id).toBe(
      '7430175321334369537',
    );
    expect(tiktokAdapter.match(u('https://www.tiktok.com/@/photo/7430175321334369537'))?.id).toBe(
      '7430175321334369537',
    );
  });

  test('非作品路径与外域返回 null', () => {
    expect(tiktokAdapter.match(u('https://www.tiktok.com/@nasa'))).toBeNull();
    expect(tiktokAdapter.match(u('https://www.tiktok.com/foryou'))).toBeNull();
    expect(tiktokAdapter.match(u('https://www.tiktok.com/@nasa/video/notanumber'))).toBeNull();
    expect(tiktokAdapter.match(u('https://www.youtube.com/@nasa/video/7665075736742530317'))).toBeNull();
    expect(tiktokAdapter.match(u('https://vm.tiktok.com/'))).toBeNull();
  });

  test('hosts.ts 域名归属：vm./vt. 短链都归 tiktok', () => {
    expect(findPlatform(u('https://www.tiktok.com/@nasa/video/7665075736742530317'))).toBe('tiktok');
    expect(findPlatform(u('https://vm.tiktok.com/ZMkHSh5t1/'))).toBe('tiktok');
    expect(findPlatform(u('https://vt.tiktok.com/ZSjSKrdXn/'))).toBe('tiktok');
  });
});
