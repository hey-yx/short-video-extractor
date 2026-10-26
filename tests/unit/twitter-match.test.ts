import { describe, expect, test } from 'bun:test';
import { twitterAdapter } from '@/platforms/twitter/adapter';
import { findPlatform } from '@/platforms/hosts';

const u = (s: string) => new URL(s);

describe('twitter match（纯函数）', () => {
  test('x.com /<user>/status/<id> → 直取 tweet id', () => {
    const m = twitterAdapter.match(u('https://x.com/JeffLadish/status/2104732943457599638'));
    expect(m?.platform).toBe('twitter');
    expect(m?.id).toBe('2104732943457599638');
    expect(m?.needsResolve).toBe(false);
  });

  test('带 /video/1、/photo/2 后缀与 query 不影响 match', () => {
    const m1 = twitterAdapter.match(u('https://x.com/Wallface/status/2107578945742987490/video/1'));
    const m2 = twitterAdapter.match(u('https://x.com/SpacesFuture/status/2110212153802436637/photo/2?s=20'));
    expect(m1?.id).toBe('2107578945742987490');
    expect(m2?.id).toBe('2110212153802436637');
    expect(m1?.needsResolve).toBe(false);
  });

  test('twitter.com / mobile.twitter.com / v.x.com 全部识别', () => {
    expect(twitterAdapter.match(u('https://twitter.com/user/status/2104732943457599638'))?.id).toBe(
      '2104732943457599638',
    );
    expect(twitterAdapter.match(u('https://mobile.twitter.com/user/status/2104732943457599638'))?.id).toBe(
      '2104732943457599638',
    );
    expect(twitterAdapter.match(u('https://v.x.com/user/status/2104732943457599638'))?.id).toBe(
      '2104732943457599638',
    );
  });

  test('/i/status/<id>（站内短路径）也识别', () => {
    expect(twitterAdapter.match(u('https://x.com/i/status/2104732943457599638'))?.id).toBe(
      '2104732943457599638',
    );
  });

  test('短链 t.co → needsResolve', () => {
    const m = twitterAdapter.match(u('https://t.co/4NNIMDP3TO'));
    expect(m?.platform).toBe('twitter');
    expect(m?.id).toBe('4NNIMDP3TO');
    expect(m?.needsResolve).toBe(true);
  });

  test('非推文路径与外域返回 null', () => {
    expect(twitterAdapter.match(u('https://x.com/someuser'))).toBeNull();
    expect(twitterAdapter.match(u('https://x.com/someuser/following'))).toBeNull();
    expect(twitterAdapter.match(u('https://x.com/i/status/notanumber'))).toBeNull();
    expect(twitterAdapter.match(u('https://t.co/'))).toBeNull();
    expect(twitterAdapter.match(u('https://example.com/user/status/2104732943457599638'))).toBeNull();
  });

  test('hosts.ts 域名归属：x.com/twitter.com/t.co → twitter', () => {
    expect(findPlatform(u('https://x.com/user/status/2104732943457599638'))).toBe('twitter');
    expect(findPlatform(u('https://mobile.twitter.com/user/status/1'))).toBe('twitter');
    expect(findPlatform(u('https://t.co/abc'))).toBe('twitter');
  });
});
