import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseKuaishou, extractPhotoJson } from '@/platforms/kuaishou/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';

const html = readFileSync(new URL('../fixtures/kuaishou/share-page.html', import.meta.url), 'utf8');

function payload(body: string): RawPayload {
  return { via: 'html-embedded-json', fetchedAt: 1_700_000_000, body };
}

describe('kuaishou parseKuaishou（真实分享页 fixture 回归）', () => {
  test('视频：manifest 最高档作主 URL + 元数据', () => {
    const r = parseKuaishou(payload(html));
    expect(r.platform).toBe('kuaishou');
    expect(r.id).toBe('5203346566089417256');
    expect(r.kind).toBe('video');
    expect(r.author.name).toBe('朵朵好物优选');
    // 头像字段实测是 headUrl/headUrls（2026-10-25），不是 headurl
    expect(r.author.avatar).toBeTruthy();
    expect(r.title).toContain('羽绒棉服');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    expect(asset.url).toMatch(/^https:\/\//);
    // 该样本只有 720p 一档：主 URL 即 manifest representation
    expect(asset.height).toBe(1280);
    expect(asset.width).toBe(720);
    expect(asset.durationMs).toBe(10533);
    expect(asset.coverUrl).toContain('yximgs.com');
    expect(asset.variants).toEqual([]);
  });

  test('无 manifest 时回落 mainMvUrls（无水印 _b_ 流）', () => {
    const photo = extractPhotoJson(html);
    const stripped = { ...photo, manifest: undefined };
    const r = parseKuaishou(payload(JSON.stringify({ photo: stripped })));
    expect(r.assets[0]!.url).toContain('_b_');
  });

  test('页面没有 photo 数据：UPSTREAM_CHANGED', () => {
    try {
      parseKuaishou(payload('<html><script>window.INIT_STATE = {"system":{}};</script></html>'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('photo JSON 里字符串含转义引号/花括号不影响括号配平', () => {
    const tricky =
      'window.INIT_STATE = {"photo":{"photoId":"p1","caption":"a \\"quote\\" and {} braces"},"z":1};';
    const photo = extractPhotoJson(tricky);
    expect(photo.photoId).toBe('p1');
    expect(photo.caption).toContain('"quote"');
    expect(photo.caption).toContain('{}');
  });

  test('资源全空：UPSTREAM_CHANGED（不许静默返回空数组）', () => {
    try {
      parseKuaishou(payload(JSON.stringify({ photo: { photoId: 'p2', caption: 'x' } })));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('非 html-embedded-json 载荷拒绝', () => {
    try {
      parseKuaishou({ via: 'api', fetchedAt: 1, body: {} });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });
});
