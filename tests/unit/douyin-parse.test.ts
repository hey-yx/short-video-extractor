import { describe, expect, test } from 'bun:test';
import { parseAweme } from '@/platforms/douyin/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import video from '../fixtures/douyin/aweme-video.json';
import album from '../fixtures/douyin/aweme-album.json';
import filtered from '../fixtures/douyin/aweme-filtered.json';

function payload(body: unknown): RawPayload {
  return { via: 'api', fetchedAt: 1_700_000_000, body };
}

describe('douyin parseAweme（fixture 回归）', () => {
  test('视频：play 直链 + variants 档位 + 元数据', () => {
    const r = parseAweme(payload(video));
    expect(r.platform).toBe('douyin');
    expect(r.id).toBe('7142091187963399427');
    expect(r.kind).toBe('video');
    expect(r.author.name).toBe('李子尘');
    expect(r.author.id).toStartWith('MS4wLjAB');
    expect(r.title).toContain('救赎之道');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    // 主 URL 必须是 play 接口形态（空 Referer 可下）
    expect(asset.url).toContain('/aweme/v1/play/?video_id=');
    expect(asset.url).toContain('ratio=1080p');
    expect(asset.durationMs).toBe(14929);
    expect(asset.coverUrl).toBeTruthy();

    // variants：origin 必在，带水印档必在
    const ratios = asset.variants!.map((v) => v.ratio);
    expect(ratios).toContain('origin');
    expect(ratios).toContain('watermarked_720p');
    const wm = asset.variants!.find((v) => v.ratio === 'watermarked_720p')!;
    expect(wm.watermark).toBe(true);
    // 带水印直链不得作为主 URL
    expect(asset.url).not.toContain('/mps/logo/');
  });

  test('图集：40 张图 + 无水印主图 + 带水印 variant', () => {
    const r = parseAweme(payload(album));
    expect(r.kind).toBe('album');
    expect(r.assets).toHaveLength(40);
    const first = r.assets[0]!;
    expect(first.type).toBe('image');
    expect(first.url).toContain('douyinpic.com');
    // 主图无水印模板
    expect(first.url).toContain('tplv-dy-aweme-images');
    const wmVariant = first.variants?.find((v) => v.ratio === 'watermarked');
    expect(wmVariant).toBeDefined();
    expect(wmVariant!.url).toContain('tplv-dy-water');
  });

  test('不可见作品：CONTENT_RESTRICTED + filter_reason', () => {
    try {
      parseAweme(payload(filtered));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('CONTENT_RESTRICTED');
      expect(err.detail?.filter_reason).toBe('status_self_see');
    }
  });

  test('aweme_detail 为 null 且无 filter：CONTENT_NOT_FOUND', () => {
    try {
      parseAweme(payload({ aweme_detail: null, status_code: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('资源全空：UPSTREAM_CHANGED（不许静默返回空数组）', () => {
    try {
      parseAweme(payload({ aweme_detail: { aweme_id: '1', media_type: 4, images: null, video: {} }, status_code: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });
});
