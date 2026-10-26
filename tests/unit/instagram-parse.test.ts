import { describe, expect, test } from 'bun:test';
import { instagramAdapter } from '@/platforms/instagram/adapter';
import { isoDurationToMs, parseInstagram, urlExpiry } from '@/platforms/instagram/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import reelFixture from '../fixtures/instagram/graphql-reel.json';
import imageFixture from '../fixtures/instagram/graphql-image.json';
import carouselFixture from '../fixtures/instagram/graphql-carousel.json';
import notFoundFixture from '../fixtures/instagram/graphql-not-found.json';

const FETCHED_AT = 1_700_000_000;

function payload(body: unknown): RawPayload {
  return { via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body };
}

describe('instagram 纯函数', () => {
  test('isoDurationToMs：DASH manifest 的 ISO-8601 时长', () => {
    expect(isoDurationToMs('PT33.034481S')).toBe(33_034);
    expect(isoDurationToMs('PT1M2S')).toBe(62_000);
    expect(isoDurationToMs('PT1H2M3S')).toBe(3_723_000);
    expect(isoDurationToMs('')).toBeUndefined();
    expect(isoDurationToMs('not-a-duration')).toBeUndefined();
  });

  test('urlExpiry：fbcdn oe= 十六进制 Unix 秒', () => {
    expect(urlExpiry('https://x.fbcdn.net/a.mp4?oh=00_AQ&oe=6AE0B1E9')).toBe(0x6ae0b1e9);
    expect(urlExpiry('https://x.fbcdn.net/a.mp4?oe=zzzz')).toBeUndefined();
    expect(urlExpiry('https://x.fbcdn.net/a.mp4')).toBeUndefined();
  });
});

describe('instagram parseInstagram（真实 GraphQL 响应 fixture 回归）', () => {
  test('视频 Reel：直链/封面/时长/作者/caption/expiresAt', () => {
    const r = parseInstagram(payload(reelFixture), { id: 'C9z1OIUi8Yh' });
    expect(r.platform).toBe('instagram');
    expect(r.id).toBe('C9z1OIUi8Yh');
    expect(r.kind).toBe('video');
    expect(r.via).toBe('http');
    expect(r.parsedAt).toBe(FETCHED_AT);
    expect(r.title).toBe('fake caption line one');
    expect(r.description).toBe('fake caption line one\nline two #faketag');
    expect(r.tags).toContain('faketag');
    expect(r.author.name).toBe('fake.user');
    expect(r.author.avatar).toContain('cdn-fake.fbcdn.net');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    expect(asset.url).toMatch(/^https:\/\/cdn-fake\.fbcdn\.net\//);
    expect(asset.url).toContain('oe=6AF3C2C1');
    expect(asset.durationMs).toBe(33_034);
    expect(asset.coverUrl).toBeTruthy();
    // 真实样本三档 video_versions 同为 640×360（一档一位去重），variants 为空是如实行为
    expect(asset.variants).toEqual([]);
    // 多分辨率版本时一档一位：手造两档 payload 验证档位映射
    const twoTier = structuredClone(reelFixture) as typeof reelFixture;
    const item = twoTier.data.xdt_api__v1__media__shortcode__web_info.items[0]!;
    item.video_versions = [
      {
        url: 'https://cdn-fake.fbcdn.net/o1/v/fake/HIGH123.mp4?oe=6AF3C2C1',
        width: 1080,
        height: 1920,
        type: 101,
      },
      {
        url: 'https://cdn-fake.fbcdn.net/o1/v/fake/LOW123.mp4?oe=6AF3C2C1',
        width: 360,
        height: 640,
        type: 101,
      },
    ];
    const r2 = parseInstagram(payload(twoTier), { id: 'C9z1OIUi8Yh' });
    expect(r2.assets[0]!.url).toContain('HIGH123');
    expect(r2.assets[0]!.height).toBe(1920);
    expect(r2.assets[0]!.variants!.map((v) => v.ratio)).toEqual(['640p']);
    // oe=6AF3C2C1 = 1792780481，直链时效如实回填
    expect(asset.expiresAt).toBe(0x6af3c2c1);
    expect(r.expiresAt).toBe(0x6af3c2c1);
  });

  test('单图 post：image 资产、caption 缺省给占位标题', () => {
    const r = parseInstagram(payload(imageFixture), { id: 'Dar829LpJx_' });
    expect(r.kind).toBe('album');
    expect(r.assets[0]!.type).toBe('image');
    expect(r.assets[0]!.url).toContain('cdn-fake.fbcdn.net');
    expect(r.assets[0]!.width).toBeGreaterThan(0);
    expect(r.title).toBe('Instagram Dar829LpJx_');
    expect(r.expiresAt).toBeUndefined();
  });

  test('图集：carousel 子项全出、类型按子项 media_type 判', () => {
    const r = parseInstagram(payload(carouselFixture), { id: 'DdrJN5qjhJP' });
    expect(r.kind).toBe('album');
    expect(r.assets.length).toBe(2);
    expect(r.assets.every((a) => a.type === 'image')).toBe(true);
  });

  test('execution error 失败态：CONTENT_NOT_FOUND 而非 UPSTREAM_CHANGED', () => {
    expect(() => parseInstagram(payload(notFoundFixture), { id: 'C0ZxKJZsBmC' })).toThrow(
      new AppError('CONTENT_NOT_FOUND', 'Instagram 作品不存在或已删除', { shortcode: 'C0ZxKJZsBmC' }),
    );
  });

  test('图集含视频子项时给 video 资产', () => {
    const mixed = structuredClone(carouselFixture) as typeof carouselFixture;
    const sub = mixed.data.xdt_api__v1__media__shortcode__web_info.items[0]!
      .carousel_media[0]! as unknown as {
      media_type: number;
      video_versions?: Array<{ url: string; width: number; height: number; type: number }>;
    };
    sub.media_type = 2;
    sub.video_versions = [
      {
        url: 'https://cdn-fake.fbcdn.net/o1/v/fake/FAKEPATH.mp4?oe=6AF3C2C1',
        width: 640,
        height: 360,
        type: 101,
      },
    ];
    const r = parseInstagram(payload(mixed), { id: 'DdrJN5qjhJP' });
    expect(r.assets[0]!.type).toBe('video');
    expect(r.assets[0]!.durationMs).toBeUndefined();
    expect(r.assets[0]!.expiresAt).toBe(0x6af3c2c1);
  });

  test('未知载荷类型与坏结构给 UPSTREAM_CHANGED', () => {
    expect(() => parseInstagram({ ...payload(null), via: 'html-embedded-json' }, { id: 'x' })).toThrow(
      'Instagram 解析收到未知载荷类型',
    );
    expect(() => parseInstagram(payload({ data: null }), { id: 'x' })).toThrow(
      'Instagram 响应缺少 media items',
    );
    expect(() => parseInstagram(payload('string'), { id: 'x' })).toThrow('Instagram 载荷缺少 GraphQL 响应');
  });

  test('adapter 载荷契约：fetch 产出的 docId 字段可被 parse 忽略（fixture 形态一致）', () => {
    const withDocId = payload({ docId: '27128499623469141', ...reelFixture });
    const r = parseInstagram(withDocId, { id: 'C9z1OIUi8Yh' });
    expect(r.id).toBe('C9z1OIUi8Yh');
  });

  test('adapter 描述与声明', () => {
    expect(instagramAdapter.platform).toBe('instagram');
    expect(instagramAdapter.hosts).toContain('instagram.com');
    expect(instagramAdapter.capabilities.http).toBe(true);
    expect(instagramAdapter.capabilities.browser).toBe(false);
  });
});
