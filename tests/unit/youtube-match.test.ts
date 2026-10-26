import { describe, expect, test } from 'bun:test';
import { youtubeAdapter } from '@/platforms/youtube/adapter';

function m(href: string) {
  return youtubeAdapter.match(new URL(href));
}

describe('youtube match（URL 形态识别）', () => {
  test('/watch?v= 长链', () => {
    const r = m('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r).toEqual({ platform: 'youtube', id: 'dQw4w9WgXcQ', kind: 'video', needsResolve: false });
  });

  test('/watch 带多余参数与子域名（m.youtube.com）', () => {
    const r = m('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=30s');
    expect(r?.id).toBe('dQw4w9WgXcQ');
    expect(r?.needsResolve).toBe(false);
  });

  test('youtu.be 短链需要展开', () => {
    const r = m('https://youtu.be/dQw4w9WgXcQ?t=10');
    expect(r).toEqual({ platform: 'youtube', id: 'dQw4w9WgXcQ', kind: 'video', needsResolve: true });
  });

  test('/shorts/ 与普通视频同一接口', () => {
    const r = m('https://www.youtube.com/shorts/pjWY5NkjsrY');
    expect(r).toEqual({ platform: 'youtube', id: 'pjWY5NkjsrY', kind: 'video', needsResolve: false });
  });

  test('/embed/ /live/ /v/ 形态', () => {
    for (const path of ['embed/dQw4w9WgXcQ', 'live/dQw4w9WgXcQ', 'v/dQw4w9WgXcQ']) {
      const r = m(`https://www.youtube.com/${path}`);
      expect(r?.id).toBe('dQw4w9WgXcQ');
    }
  });

  test('youtube-nocookie.com 嵌入域', () => {
    const r = m('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(r?.id).toBe('dQw4w9WgXcQ');
  });

  test('非法 videoId 与非视频路径不匹配', () => {
    expect(m('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(m('https://www.youtube.com/watch?v=has+plus+sign')).toBeNull();
    expect(m('https://www.youtube.com/playlist?list=PL123')).toBeNull();
    expect(m('https://www.youtube.com/@somechannel')).toBeNull();
    expect(m('https://youtu.be/')).toBeNull();
    expect(m('https://www.youtube.com/')).toBeNull();
    expect(m('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
  });
});
