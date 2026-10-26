import { describe, expect, test } from 'bun:test';
import { parseBilibili } from '@/platforms/bilibili/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import viewVideo from '../fixtures/bilibili/view-video.json';
import viewMulti from '../fixtures/bilibili/view-multi.json';
import playurlDash from '../fixtures/bilibili/playurl-dash.json';

const FETCHED_AT = 1_700_000_000;

function singlePayload(): RawPayload {
  const data = viewVideo.data;
  const dash = playurlDash.data.dash;
  return {
    via: 'api',
    fetchedAt: FETCHED_AT,
    channel: 'http',
    body: {
      view: { code: 0, message: 'OK', data },
      streams: [
        {
          page: 1,
          cid: data.cid,
          part: data.pages[0]!.part,
          videos: dash.video,
          audios: dash.audio,
        },
      ],
    },
  };
}

function multiPayload(): RawPayload {
  const data = viewMulti.data;
  const dash = playurlDash.data.dash;
  return {
    via: 'api',
    fetchedAt: FETCHED_AT,
    channel: 'http',
    body: {
      view: { code: 0, message: 'OK', data },
      streams: data.pages.map((p, i) => ({
        page: p.page,
        cid: p.cid,
        part: p.part,
        videos: dash.video,
        audios: dash.audio,
      })),
    },
  };
}

describe('bilibili parseBilibili（真实 view/playurl fixture 回归）', () => {
  test('单 P：1080P 主 URL + DASH 音轨直链 + 档位 variants', () => {
    const r = parseBilibili(singlePayload());
    expect(r.platform).toBe('bilibili');
    expect(r.id).toBe('BV1GJ411x7h7');
    expect(r.kind).toBe('video');
    expect(r.author.name).toBe('索尼音乐中国');
    expect(r.author.id).toBe('486906719');
    expect(r.title).toContain('Never Gonna Give You Up');
    expect(r.via).toBe('http');

    expect(r.assets).toHaveLength(1);
    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    // 最高档 1080P（id=80）三编码里 bandwidth 最高者作主 URL
    expect(asset.width).toBe(1920);
    expect(asset.height).toBe(1080);
    expect(asset.url).toMatch(/^https:\/\//);
    expect(asset.coverUrl).toContain('hdslb.com');
    // durationMs 来自 pages[0].duration（秒）×1000
    expect(asset.durationMs).toBeGreaterThan(200_000);
    expect(asset.durationMs).toBeLessThan(220_000);

    // DASH 音视频分离：audio 直链注在 asset 上，取最高码率音轨
    expect(asset.audioUrl).toMatch(/^https:\/\//);
    const bestAudio = playurlDash.data.dash.audio.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b));
    expect(asset.audioUrl).toBe(bestAudio.base_url);

    // 其余档进 variants：一档一位（fixture 全量 12 条流收敛为 720/480/360 三档）
    const ratios = asset.variants!.map((v) => v.ratio);
    expect(ratios).toContain('720P');
    expect(ratios).toContain('480P');
    expect(ratios).toContain('360P');
    expect(asset.variants!.length).toBe(3);
    expect(new Set(ratios).size).toBe(ratios.length);

    // 直链时效：upos URL 的 deadline= 过期时刻 → asset.expiresAt
    expect(asset.expiresAt).toBeGreaterThan(1_700_000_000);
    expect(r.expiresAt).toBe(asset.expiresAt);
  });

  test('多 P：每 P 一个 asset，分 P 标题注在 asset.partTitle', () => {
    const r = parseBilibili(multiPayload());
    expect(r.id).toBe('BV1bK411W797');
    expect(r.title).toContain('（共 23P）');
    expect(r.assets).toHaveLength(23);
    for (const [i, asset] of r.assets.entries()) {
      expect(asset.type).toBe('video');
      expect(asset.url).toMatch(/^https:\/\//);
      expect(asset.audioUrl).toBeTruthy();
      expect(asset.partTitle).toBe(viewMulti.data.pages[i]!.part);
    }
    expect(r.assets[0]!.partTitle).toBe('Staple Stable/战场原+羽川');
    expect(r.assets[22]!.partTitle).toBe(viewMulti.data.pages[22]!.part);
  });

  test('单 P 不加（共 N P）后缀、不带 partTitle', () => {
    const r = parseBilibili(singlePayload());
    expect(r.title).not.toContain('（共');
    expect(r.assets[0]!.partTitle).toBeUndefined();
  });

  test('载荷缺 streams：UPSTREAM_CHANGED（不许静默返回空数组）', () => {
    try {
      parseBilibili({
        via: 'api',
        fetchedAt: FETCHED_AT,
        channel: 'http',
        body: { view: { code: 0, data: viewVideo.data }, streams: [] },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('视频流无直链：UPSTREAM_CHANGED', () => {
    try {
      parseBilibili({
        via: 'api',
        fetchedAt: FETCHED_AT,
        channel: 'http',
        body: {
          view: { code: 0, data: viewVideo.data },
          streams: [
            {
              page: 1,
              cid: 1,
              videos: [{ id: 80, codecs: 'avc1' }],
              audios: [],
            },
          ],
        },
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('非 api 载荷拒绝', () => {
    try {
      parseBilibili({
        via: 'html-embedded-json',
        fetchedAt: FETCHED_AT,
        channel: 'http',
        body: {},
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });
});
