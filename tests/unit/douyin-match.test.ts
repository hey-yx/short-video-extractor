import { describe, expect, test } from 'bun:test';
import { douyinAdapter } from '@/platforms/douyin/adapter';

const u = (s: string) => new URL(s);

describe('douyin match（纯函数）', () => {
  test('长链 /video/<id>', () => {
    const m = douyinAdapter.match(u('https://www.douyin.com/video/7142091187963399427'));
    expect(m?.id).toBe('7142091187963399427');
    expect(m?.needsResolve).toBe(false);
  });

  test('长链 /note/<id>（图集）', () => {
    const m = douyinAdapter.match(u('https://www.douyin.com/note/7668299666311970405'));
    expect(m?.id).toBe('7668299666311970405');
  });

  test('短链 v.douyin.com → needsResolve', () => {
    const m = douyinAdapter.match(u('https://v.douyin.com/iRNBho6u/'));
    expect(m?.needsResolve).toBe(true);
  });

  test('分享页 iesdouyin.com', () => {
    const m = douyinAdapter.match(u('https://www.iesdouyin.com/share/video/7142091187963399427/?Region=CN'));
    expect(m?.id).toBe('7142091187963399427');
  });

  test('modal_id 参数', () => {
    const m = douyinAdapter.match(u('https://www.douyin.com/discover?modal_id=7142091187963399427'));
    expect(m?.id).toBe('7142091187963399427');
  });

  test('非抖音链接返回 null', () => {
    expect(douyinAdapter.match(u('https://example.com/video/123'))).toBeNull();
  });
});
