import { describe, expect, test } from 'bun:test';
import { weiboAdapter } from '@/platforms/weibo/adapter';

const u = (s: string) => new URL(s);

describe('weibo match（纯函数）', () => {
  test('m 站长链 /status/<数字 mid>', () => {
    const m = weiboAdapter.match(u('https://m.weibo.cn/status/5339931342014513'));
    expect(m?.platform).toBe('weibo');
    expect(m?.id).toBe('5339931342014513');
    expect(m?.kind).toBe('unknown');
    expect(m?.needsResolve).toBe(false);
  });

  test('m 站 /detail/<mid> 同样命中（yt-dlp 同款路径）', () => {
    const m = weiboAdapter.match(u('https://m.weibo.cn/detail/5357208410000267'));
    expect(m?.id).toBe('5357208410000267');
  });

  test('m 站分享页 /2/detail/<mid> 取末段（App 分享常见形态）', () => {
    const m = weiboAdapter.match(u('https://m.weibo.cn/2/detail/5356869863344787'));
    expect(m?.id).toBe('5356869863344787');
    expect(m?.needsResolve).toBe(false);
  });

  test('weibo.com/<uid>/<bid>：bid 原样进 id（接口自己解码）', () => {
    const m = weiboAdapter.match(u('https://weibo.com/3161347567/RgKNo8s49'));
    expect(m?.id).toBe('RgKNo8s49');
    expect(m?.kind).toBe('unknown');
    expect(m?.needsResolve).toBe(false);
  });

  test('视频直链页 video.weibo.com/show?fid=1034:…（32 位 hex 形态）', () => {
    const m = weiboAdapter.match(u('https://video.weibo.com/show?fid=1034:633c288cc043d0ca7808030f1157da64'));
    expect(m?.platform).toBe('weibo');
    expect(m?.id).toBe('1034:633c288cc043d0ca7808030f1157da64');
    expect(m?.kind).toBe('video');
  });

  test('视频直链页数字 fid + /tv/show/<fid> 形态', () => {
    const m1 = weiboAdapter.match(u('https://video.weibo.com/show?fid=1034:5339930738753551'));
    expect(m1?.id).toBe('1034:5339930738753551');
    const m2 = weiboAdapter.match(u('https://weibo.com/tv/show/1034:5339930738753551'));
    expect(m2?.id).toBe('1034:5339930738753551');
    expect(m2?.kind).toBe('video');
  });

  test('t.cn 短链 → needsResolve', () => {
    const m = weiboAdapter.match(u('https://t.cn/AX0CCdCG'));
    expect(m?.id).toBe('AX0CCdCG');
    expect(m?.needsResolve).toBe(true);
  });

  test('无关路径返回 null（首页 / 用户主页 / 非微博域）', () => {
    expect(weiboAdapter.match(u('https://m.weibo.cn/'))).toBeNull();
    expect(weiboAdapter.match(u('https://weibo.com/u/3161347567'))).toBeNull();
    expect(weiboAdapter.match(u('https://weibo.com/3161347567'))).toBeNull();
    expect(weiboAdapter.match(u('https://example.com/status/5339931342014513'))).toBeNull();
    expect(weiboAdapter.match(u('https://t.cn/'))).toBeNull();
    expect(weiboAdapter.match(u('https://video.weibo.com/show'))).toBeNull();
    expect(weiboAdapter.match(u('https://video.weibo.com/show?fid=abc'))).toBeNull();
  });
});
