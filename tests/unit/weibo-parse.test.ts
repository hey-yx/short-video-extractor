import { afterEach, describe, expect, test } from 'bun:test';
import { parseWeibo, type WeiboPayload } from '@/platforms/weibo/parse';
import { weiboAdapter } from '@/platforms/weibo/adapter';
import { AppError } from '@/core/errors';
import type { MatchResult, RawPayload } from '@/types/platform';

// 真实响应脱敏录制（2026-10-26）：视频帖 mid=5339931342014513、图集帖 mid=5357208410000267（9 图）
// 脱敏尺度：URL 里的 ssig 签名替换为 {{SECRET_ssig}}，结构参数（Expires/template/label）保留
const videoShow = (await Bun.file('tests/fixtures/weibo/show-video.json').json()) as WeiboPayload['show'];
const albumShow = (await Bun.file('tests/fixtures/weibo/show-album.json').json()) as WeiboPayload['show'];
const missingShow = (await Bun.file('tests/fixtures/weibo/show-missing.json').json()) as WeiboPayload['show'];
const component = (await Bun.file(
  'tests/fixtures/weibo/component-playinfo.json',
).json()) as WeiboPayload['component'];

const payload = (body: unknown): RawPayload => ({
  via: 'api',
  channel: 'http',
  fetchedAt: 1_700_000_000,
  body,
});

describe('weibo parseWeibo（真实响应 fixture 回归）', () => {
  test('视频帖：三档 urls，主 URL 取最大像素，variants 收其余档', () => {
    const r = parseWeibo(payload({ show: videoShow }));
    expect(r.platform).toBe('weibo');
    expect(r.id).toBe('5339931342014513');
    expect(r.kind).toBe('video');
    expect(r.via).toBe('http');
    expect(r.parsedAt).toBe(1_700_000_000);
    expect(r.author.name).toBe('AKB48通讯社');
    expect(r.author.id).toBe('3161347567');
    expect(r.title).toContain('双子感覚');
    expect(r.tags).toContain('AKB48');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    // 主 URL 是 720x1280 档（三档里面积最大：720p 921600 > 540x960 518400 > 360x640 230400）
    expect(asset.url).toContain('template=720x1280');
    expect(asset.width).toBe(720);
    expect(asset.height).toBe(1280);
    expect(asset.durationMs).toBe(11215);
    expect(asset.coverUrl).toContain('sinaimg.cn');
    // 真实响应里 mp4_ld_mp4 与 mp4_hd_mp4 是同一 URL（上游未给独立 ld 档），去重后只剩 hd 一档进 variants
    expect(asset.variants).toHaveLength(1);
    expect(asset.variants![0]!.ratio).toBe('hd');
    // 直链时效从 URL 的 Expires= 参数读出（fixture 保留真实值）
    expect(asset.expiresAt).toBe(1792949535);
    expect(r.expiresAt).toBe(1792949535);
  });

  test('fid 通道复合载荷：component 的 1080P 档压过 show 的 540p', () => {
    const r = parseWeibo(payload({ show: videoShow, component }));
    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    // 主 URL 是 1080x1920 档（component 四档里面积最大）
    expect(asset.url).toContain('template=1080x1920');
    expect(asset.width).toBe(1080);
    expect(asset.height).toBe(1920);
    // 主档（1080P）不在 variants 里；其余去重档进 variants
    const ratios = asset.variants!.map((v) => v.ratio);
    expect(ratios).not.toContain('1080P');
    expect(ratios).toContain('720P');
    expect(ratios).toContain('480P');
  });

  test('图集帖：pics[].large 逐张出 image asset', () => {
    const r = parseWeibo(payload({ show: albumShow }));
    expect(r.kind).toBe('album');
    expect(r.id).toBe('5357208410000267');
    expect(r.author.name).toBe('回忆专用小马甲');
    expect(r.assets).toHaveLength(9);
    for (const a of r.assets) {
      expect(a.type).toBe('image');
      expect(a.url).toContain('mw2000');
      expect(a.width).toBe(941);
      expect(a.height).toBeGreaterThanOrEqual(1671);
      expect(a.height).toBeLessThanOrEqual(1672);
    }
    expect(r.title).toContain('舒适');
  });

  test('ok:0 errno=20101 → CONTENT_NOT_FOUND', () => {
    try {
      parseWeibo(payload({ show: missingShow }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('错误信封分类：需登录=CONTENT_RESTRICTED、风控=RISK_CONTROL', () => {
    try {
      parseWeibo(payload({ show: { ok: 0, errno: '1', msg: '仅粉丝可见' } }));
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_RESTRICTED');
    }
    try {
      parseWeibo(payload({ show: { ok: 0, errno: '1', msg: '操作频繁，请稍后再试' } }));
    } catch (e) {
      expect((e as AppError).code).toBe('RISK_CONTROL');
    }
    try {
      parseWeibo(payload({ show: { ok: 0, errno: '1', msg: '内部错误' } }));
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
    }
  });

  test('无媒体内容（无 stream 无 pics）→ CONTENT_NOT_FOUND', () => {
    expect(() => parseWeibo(payload({ show: { ok: 1, data: { id: '1', text: '纯文字' } } }))).toThrow(
      AppError,
    );
  });
});

describe('weibo fetch 边界（mock fetch）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const input: MatchResult = {
    platform: 'weibo',
    id: '5339931342014513',
    kind: 'unknown',
    needsResolve: false,
  };
  const ctx = {
    signal: new AbortController().signal,
    channel: 'http' as const,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  test('200 + 空 body 必须当失败（UPSTREAM_CHANGED）', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch;
    await expect(
      weiboAdapter.fetch(input, new URL('https://m.weibo.cn/status/5339931342014513'), ctx),
    ).rejects.toThrow(/空 body/);
  });

  test('302 到 passport → CONTENT_RESTRICTED', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('', { status: 302, headers: { location: 'https://passport.weibo.com/x' } }),
      )) as unknown as typeof fetch;
    try {
      await weiboAdapter.fetch(input, new URL('https://m.weibo.cn/status/5339931342014513'), ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONTENT_RESTRICTED');
    }
  });

  test('429 → RISK_CONTROL', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('', { status: 429 }))) as unknown as typeof fetch;
    try {
      await weiboAdapter.fetch(input, new URL('https://m.weibo.cn/status/5339931342014513'), ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('RISK_CONTROL');
    }
  });
});
