import { describe, expect, test } from 'bun:test';
import { kuaishouAdapter } from '@/platforms/kuaishou/adapter';

const u = (s: string) => new URL(s);

describe('kuaishou match（纯函数）', () => {
  test('短链 v.kuaishou.com/<code> → needsResolve', () => {
    const m = kuaishouAdapter.match(u('https://v.kuaishou.com/5hFdnB'));
    expect(m?.platform).toBe('kuaishou');
    expect(m?.id).toBe('5hFdnB');
    expect(m?.kind).toBe('unknown');
    expect(m?.needsResolve).toBe(true);
  });

  test('落地页 chenzhongtech /fw/photo/<photoId> → 直取 photoId', () => {
    const m = kuaishouAdapter.match(
      u('https://v.m.chenzhongtech.com/fw/photo/3x3nx2kzg3ve9ie?cc=share_copylink&shareToken=x'),
    );
    expect(m?.id).toBe('3x3nx2kzg3ve9ie');
    expect(m?.needsResolve).toBe(false);
  });

  test('实测跳转目标 c.kuaishou.com /fw/photo/<photoId>', () => {
    const m = kuaishouAdapter.match(
      u('https://c.kuaishou.com/fw/photo/3x3nx2kzg3ve9ie?utm_source=app_share'),
    );
    expect(m?.id).toBe('3x3nx2kzg3ve9ie');
    expect(m?.needsResolve).toBe(false);
  });

  test('兜底：query 里的 photoId', () => {
    const m = kuaishouAdapter.match(
      u('https://www.kuaishou.com/f/?photoId=3xzjbmsi3btw33k&cc=share_copylink'),
    );
    expect(m?.id).toBe('3xzjbmsi3btw33k');
    expect(m?.needsResolve).toBe(false);
  });

  test('非快手链接返回 null', () => {
    expect(kuaishouAdapter.match(u('https://example.com/fw/photo/3xabc'))).toBeNull();
    expect(kuaishouAdapter.match(u('https://v.kuaishou.com/'))).toBeNull();
  });

  test('桌面分享链接 /f/<code> → needsResolve（code 不是 photoId）', () => {
    const m = kuaishouAdapter.match(u('https://www.kuaishou.com/f/XXXXfake1Y1jU'));
    expect(m?.id).toBe('XXXXfake1Y1jU');
    expect(m?.needsResolve).toBe(true);
  });

  test('桌面分享页 /short-video/<photoId> 直取 photoId', () => {
    const m = kuaishouAdapter.match(
      u('https://www.kuaishou.com/short-video/3xfakeid45i26?authorId=abc&streamSource=find'),
    );
    expect(m?.id).toBe('3xfakeid45i26');
    expect(m?.needsResolve).toBe(false);
  });

  test('跳转落点 m.gifshow.com /fw/photo/<photoId> 也认', () => {
    const m = kuaishouAdapter.match(u('https://m.gifshow.com/fw/photo/3xfakeid45i26?cc=share_copylink'));
    expect(m?.id).toBe('3xfakeid45i26');
    expect(m?.needsResolve).toBe(false);
  });

  test('/f/?photoId= 仍走 query 兜底，不因 /f/ 规则变成 needsResolve', () => {
    const m = kuaishouAdapter.match(u('https://www.kuaishou.com/f/?photoId=3xzjbmsi3btw33k'));
    expect(m?.id).toBe('3xzjbmsi3btw33k');
    expect(m?.needsResolve).toBe(false);
  });
});
