import { describe, expect, test } from 'bun:test';
import { parseTiktok, urlExpiry, mapTikwmFailure } from '@/platforms/tiktok/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import videoFixture from '../fixtures/tiktok/tikwm-video.json';
import albumFixture from '../fixtures/tiktok/tikwm-album.json';

const FETCHED_AT = 1_792_991_772;

function payload(body: unknown): RawPayload {
  return { via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body };
}

describe('tiktok parseTiktok（真实 tikwm 响应 fixture 回归）', () => {
  test('视频：play 主档（无水印）+ hd/wm 变体 + 音乐 + 直链时效', () => {
    const r = parseTiktok(payload(videoFixture), { id: '7665075736742530317' });
    expect(r.platform).toBe('tiktok');
    expect(r.id).toBe('7665075736742530317');
    expect(r.kind).toBe('video');
    expect(r.via).toBe('http');
    expect(r.parsedAt).toBe(FETCHED_AT);
    expect(r.title).toContain('Something big');
    expect(r.author.name).toBe('NASA');
    expect(r.author.id).toBe('7664638705177150477');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    expect(asset.url).toContain('v16m.tiktokcdn-us.com');
    expect(asset.durationMs).toBe(25_000);
    expect(asset.size).toBe(3_356_735);
    expect(asset.coverUrl).toContain('tiktokcdn-us.com');
    expect(asset.audioUrl).toContain('ies-music.tiktokcdn-us.com');
    // 变体：hd 无水印 + wm 带水印（实测 wmplay 下载为 MP4，mark 字段如实标）
    const ratios = asset.variants!.map((v) => v.ratio);
    expect(ratios).toContain('hd');
    expect(ratios).toContain('sd');
    const wm = asset.variants!.find((v) => v.ratio === 'sd')!;
    expect(wm.watermark).toBe(true);
    expect(wm.size).toBe(3_152_325);
    const hd = asset.variants!.find((v) => v.ratio === 'hd')!;
    expect(hd.watermark).toBe(false);
    expect(hd.size).toBe(3_054_949);
    // 直链时效：fixture path hex 段 6adf3694 = 1793013396 = fetchedAt+21624（未来 6h）→ 如实读出
    expect(asset.expiresAt).toBe(1_793_013_396);
    expect(r.expiresAt).toBe(1_793_013_396);
  });

  test('图集：images[] 为主资源，play==music 不当视频给', () => {
    const r = parseTiktok(payload(albumFixture), { id: '7398188624526724358' });
    expect(r.platform).toBe('tiktok');
    expect(r.kind).toBe('album');
    expect(r.assets.length).toBe(9);
    expect(r.assets.every((a) => a.type === 'image')).toBe(true);
    expect(r.assets[0]!.url).toContain('photomode');
    expect(r.author.name).toBeTruthy();
    // 图集无直链时效
    expect(r.expiresAt).toBeUndefined();
  });

  test('tikwm 相对路径 play/images → 补成 tikwm.com 中转域绝对地址', () => {
    const video = parseTiktok(
      payload({ code: 0, msg: 'success', data: { id: '1', title: 't', play: '/video/tos/x' } }),
      { id: '1' },
    );
    expect(video.assets[0]!.url).toBe('https://www.tikwm.com/video/tos/x');
    const album = parseTiktok(
      payload({
        code: 0,
        msg: 'success',
        data: { id: '1', title: 't', images: ['/image/tos/a', '/image/tos/b'] },
      }),
      { id: '1' },
    );
    expect(album.assets.map((a) => a.url)).toEqual([
      'https://www.tikwm.com/image/tos/a',
      'https://www.tikwm.com/image/tos/b',
    ]);
  });

  test('code=-1 → 按 msg 分类（链接无效 → CONTENT_NOT_FOUND）', () => {
    try {
      parseTiktok(payload({ code: -1, msg: 'Url parsing is failed! Please check url.' }), { id: '1' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('code=-1 限频 msg → RATE_LIMITED', () => {
    try {
      parseTiktok(payload({ code: -1, msg: 'Free Api Limit: 1 reqeust per second' }), { id: '1' });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('RATE_LIMITED');
    }
  });

  test('载荷异常 → UPSTREAM_CHANGED', () => {
    expect(() =>
      parseTiktok({ via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body: null }, { id: 'x' }),
    ).toThrow(/UPSTREAM_CHANGED|载荷/);
    expect(() =>
      parseTiktok(
        { via: 'html-embedded-json', channel: 'http', fetchedAt: FETCHED_AT, body: {} },
        { id: 'x' },
      ),
    ).toThrow(AppError);
    expect(() => parseTiktok(payload({ code: 0, msg: 'success', data: { id: '1' } }), { id: '1' })).toThrow(
      /可下载资源/,
    );
  });

  test('urlExpiry：path hex 段未来 6h 内 → 读出；过旧/过远/缺失 → undefined', () => {
    const ts = FETCHED_AT + 21_624;
    expect(urlExpiry(`https://v16m.tiktokcdn-us.com/sig/${ts.toString(16)}/video/tos/x`, FETCHED_AT)).toBe(
      ts,
    );
    expect(urlExpiry('https://v16m.tiktokcdn-us.com/sig/zzz/video/tos/x', FETCHED_AT)).toBeUndefined();
    // 早于 now 的 hex（10 位 8 hex 字符的过去时间戳）不算有效期
    expect(
      urlExpiry(
        `https://v16m.tiktokcdn-us.com/sig/${(FETCHED_AT - 1000).toString(16)}/video/tos/x`,
        FETCHED_AT,
      ),
    ).toBeUndefined();
  });

  test('mapTikwmFailure：未知 msg 兜底 UPSTREAM_ERROR', () => {
    expect(mapTikwmFailure(-1, 'some unknown', '1').code).toBe('UPSTREAM_ERROR');
  });
});
