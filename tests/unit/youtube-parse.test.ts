import { describe, expect, test } from 'bun:test';
import { parseYoutube } from '@/platforms/youtube/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import merged from '../fixtures/youtube/player-merged-androidvr.json';
import dash from '../fixtures/youtube/player-dash-ios.json';
import short from '../fixtures/youtube/player-dash-short-ios.json';
import loginRequired from '../fixtures/youtube/player-login-required.json';

const FETCHED_AT = 1_700_000_000;

function payload(player: unknown, client = 'ANDROID_VR'): RawPayload {
  return { via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body: { client, player } };
}

describe('youtube parseYoutube（真实 player 响应 fixture 回归）', () => {
  test('进度性合并档优先：itag 18 单 URL 直出，DASH 音轨与档位照给', () => {
    const r = parseYoutube(payload(merged), { id: 'dQw4w9WgXcQ' });
    expect(r.platform).toBe('youtube');
    expect(r.id).toBe('dQw4w9WgXcQ');
    expect(r.kind).toBe('video');
    expect(r.via).toBe('http');
    expect(r.parsedAt).toBe(FETCHED_AT);
    expect(r.title).toContain('Never Gonna Give You Up');
    expect(r.author.name).toBe('Rick Astley');
    expect(r.author.id).toBe('UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(r.description).toBeTruthy();

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    expect(asset.url).toContain('itag=18');
    expect(asset.width).toBe(640);
    expect(asset.height).toBe(360);
    expect(asset.durationMs).toBe(213_000);
    expect(asset.coverUrl).toContain('ytimg.com');
    // DASH 伴音轨（mp4a 优先）与主 URL 分开给，供高清档位合成
    expect(asset.audioUrl).toContain('itag=140');
    // 主档位（360p）不重复进 variants；2160p mp4 档位压顶
    expect(asset.variants!.map((v) => v.ratio)).not.toContain('360p');
    expect(asset.variants![0]!.ratio).toBe('2160p');
    expect(asset.variants![0]!.url).toContain('itag=401');
    expect(asset.variants!.every((v) => v.watermark === false)).toBe(true);
    // 时效双源取最早：expire=1893456000 与 fetchedAt+21540
    expect(asset.expiresAt).toBe(FETCHED_AT + 21_540);
    expect(r.expiresAt).toBe(FETCHED_AT + 21_540);
  });

  test('无合并档走 DASH：视频直链 + 音轨 audioUrl，1080p mp4 主档', () => {
    const r = parseYoutube(payload(dash, 'IOS'), { id: '9bZkp7q19f0' });
    expect(r.id).toBe('9bZkp7q19f0');
    expect(r.title).toContain('GANGNAM STYLE');
    expect(r.author.name).toBe('officialpsy');

    const asset = r.assets[0]!;
    expect(asset.url).toMatch(/itag=(137|399)/);
    expect(asset.url).not.toContain('itag=18');
    expect(asset.width).toBe(1920);
    expect(asset.height).toBe(1080);
    expect(asset.audioUrl).toContain('itag=140');
    expect(asset.durationMs).toBe(252_000);
    // 主档位 1080p 不重复；其余档位从高到低
    expect(asset.variants!.map((v) => v.ratio)).not.toContain('1080p');
    expect(asset.variants![0]!.ratio).toBe('720p');
  });

  test('Shorts：竖屏 1080×1920，重复 itag 去重成一档一位', () => {
    const r = parseYoutube(payload(short, 'IOS'), { id: 'pjWY5NkjsrY' });
    expect(r.id).toBe('pjWY5NkjsrY');
    expect(r.kind).toBe('video');
    expect(r.author.name).toBe('Cadel and Mia');
    const asset = r.assets[0]!;
    expect(asset.width).toBe(1080);
    expect(asset.height).toBe(1920);
    expect(asset.durationMs).toBe(20_000);
    const ratios = asset.variants!.map((v) => v.ratio);
    expect(new Set(ratios).size).toBe(ratios.length);
  });

  test('bot 检查（LOGIN_REQUIRED）→ RISK_CONTROL', () => {
    try {
      parseYoutube(payload(loginRequired), { id: 'pjWY5NkjsrY' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('RISK_CONTROL');
      expect((e as AppError).message).toContain('风控');
    }
  });

  test('只有 signatureCipher（需解扰）→ UPSTREAM_CHANGED', () => {
    const player = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: 'x'.repeat(11), title: 't', lengthSeconds: '1' },
      streamingData: {
        adaptiveFormats: [{ itag: 137, signatureCipher: 's=abc&sp=sig&url=https%3A%2F%2Fex.com' }],
      },
    };
    try {
      parseYoutube(payload(player), { id: 'x'.repeat(11) });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('载荷缺 player / via 不对 → UPSTREAM_CHANGED', () => {
    expect(() => parseYoutube({ via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body: null }, { id: 'x' })).toThrow(
      /UPSTREAM_CHANGED|载荷/,
    );
    expect(() =>
      parseYoutube(
        { via: 'html-embedded-json', channel: 'http', fetchedAt: FETCHED_AT, body: { client: 'IOS', player: {} } },
        { id: 'x' },
      ),
    ).toThrow(AppError);
  });
});
