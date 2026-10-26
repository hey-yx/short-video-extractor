import { describe, expect, test } from 'bun:test';
import { instagramAdapter } from '@/platforms/instagram/adapter';

function m(href: string) {
  return instagramAdapter.match(new URL(href));
}

describe('instagram match（URL 形态识别）', () => {
  test('/reel/<id> 视频 reels', () => {
    const r = m('https://www.instagram.com/reel/C9z1OIUi8Yh/');
    expect(r).toEqual({ platform: 'instagram', id: 'C9z1OIUi8Yh', kind: 'video', needsResolve: false });
  });

  test('/reels/<id>（复数形态）', () => {
    const r = m('https://www.instagram.com/reels/C9z1OIUi8Yh/?igsh=abc');
    expect(r?.id).toBe('C9z1OIUi8Yh');
    expect(r?.kind).toBe('video');
  });

  test('/p/<id> 图文 post', () => {
    const r = m('https://www.instagram.com/p/Dar829LpJx_/');
    expect(r).toEqual({ platform: 'instagram', id: 'Dar829LpJx_', kind: 'unknown', needsResolve: false });
  });

  test('/tv/<id> IGTV', () => {
    const r = m('https://www.instagram.com/tv/CTHksdJEMvi/');
    expect(r?.id).toBe('CTHksdJEMvi');
    expect(r?.kind).toBe('video');
  });

  test('/p/ 无尾斜杠与带 query', () => {
    expect(m('https://www.instagram.com/p/DbvrVR4ms2b?img_index=2')?.id).toBe('DbvrVR4ms2b');
  });

  test('instagr.am 短域', () => {
    const r = m('https://instagr.am/p/C9z1OIUi8Yh/');
    expect(r?.id).toBe('C9z1OIUi8Yh');
    expect(r?.platform).toBe('instagram');
  });

  test('子域名（www / m）', () => {
    expect(m('https://m.instagram.com/reel/C9z1OIUi8Yh/')?.id).toBe('C9z1OIUi8Yh');
  });

  test('非内容路径与外域不匹配', () => {
    expect(m('https://www.instagram.com/just.rawphotos/')).toBeNull();
    expect(m('https://www.instagram.com/explore/tags/driftcar/')).toBeNull();
    expect(m('https://www.instagram.com/')).toBeNull();
    expect(m('https://www.youtube.com/reel/C9z1OIUi8Yh/')).toBeNull();
  });
});
