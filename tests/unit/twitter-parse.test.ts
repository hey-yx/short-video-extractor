import { describe, expect, test } from 'bun:test';
import { parseTwitter, parseTweetResultJson } from '@/platforms/twitter/parse';
import { AppError } from '@/core/errors';
import type { RawPayload } from '@/types/platform';
import tweetVideo from '../fixtures/twitter/tweet-video.json';
import tweetGif from '../fixtures/twitter/tweet-gif.json';
import tweetAlbum from '../fixtures/twitter/tweet-album.json';
import tweetText from '../fixtures/twitter/tweet-text.json';

const FETCHED_AT = 1_700_000_000;

function payload(body: object): RawPayload {
  return { via: 'api', channel: 'http', fetchedAt: FETCHED_AT, body };
}

describe('twitter parseTweetResultJson（syndication 响应判别）', () => {
  test('正常 Tweet 载荷通过', () => {
    const t = parseTweetResultJson(JSON.stringify(tweetVideo), '2104732943457599638');
    expect(t.id_str).toBe('2104732943457599638');
  });

  test('空对象（无 token/无数据）→ CONTENT_NOT_FOUND', () => {
    try {
      parseTweetResultJson('{}', '1');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('HTML 错误页（已删除推文）→ UPSTREAM_CHANGED', () => {
    try {
      parseTweetResultJson('<!DOCTYPE html><html lang="en" class="dog">...', '1');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('墓碑载荷 → CONTENT_NOT_FOUND', () => {
    try {
      parseTweetResultJson(JSON.stringify({ __typename: 'TweetTombstone' }), '1');
      throw new Error('should throw');
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });
});

describe('twitter parseTwitter（真实 syndication fixture 回归）', () => {
  test('单视频：最高码率 mp4 主链 + 低档 variants + HLS + 封面', () => {
    const r = parseTwitter(payload(tweetVideo), { id: '2104732943457599638' });
    expect(r.platform).toBe('twitter');
    expect(r.id).toBe('2104732943457599638');
    expect(r.kind).toBe('video');
    expect(r.via).toBe('http');
    expect(r.author.name).toBe('Test User');
    expect(r.author.id).toBe('1000000');
    expect(r.parsedAt).toBe(FETCHED_AT);
    // syndication 不给过期时刻：不能编
    expect(r.expiresAt).toBeUndefined();

    expect(r.assets).toHaveLength(1);
    const a = r.assets[0]!;
    expect(a.type).toBe('video');
    // 主链 = 最高码率 mp4（fixture 内 256k/832k/2176k/10368k 四档 → 10.4M 那档 1920x1080）
    expect(a.url).toContain('/vid/avc1/1920x1080/');
    expect(a.width).toBe(1920);
    expect(a.height).toBe(1080);
    expect(a.durationMs).toBe(20_200);
    expect(a.coverUrl).toContain('pbs.twimg.com/amplify_video_thumb/');
    // 其余三档（尺寸档名）+ HLS 进 variants
    const ratios = a.variants!.map((v) => v.ratio);
    expect(ratios).toEqual(['1280x720', '640x360', '480x270', 'hls']);
    for (const v of a.variants!) expect(v.url).toMatch(/^https:\/\//);
    // watermark 语义：X 无水印概念，全 false
    expect(a.variants!.every((v) => v.watermark === false)).toBe(true);
  });

  test('GIF → mp4：单档 bitrate=0 主链，无 variants', () => {
    const r = parseTwitter(payload(tweetGif), { id: '2107578945742987490' });
    expect(r.kind).toBe('video');
    expect(r.assets).toHaveLength(1);
    const a = r.assets[0]!;
    expect(a.type).toBe('video');
    expect(a.url).toContain('video.twimg.com/tweet_video/');
    expect(a.variants).toBeUndefined();
    // GIF 的 video_info 不给 duration_millis：不编
    expect(a.durationMs).toBeUndefined();
  });

  test('4 图图集：album，主链 ?name=orig 原图，backups 留无参链', () => {
    const r = parseTwitter(payload(tweetAlbum), { id: '2112763635378663468' });
    expect(r.kind).toBe('album');
    expect(r.assets).toHaveLength(4);
    for (const a of r.assets) {
      expect(a.type).toBe('image');
      expect(a.url).toContain('pbs.twimg.com/media/');
      expect(a.url.endsWith('?name=orig')).toBe(true);
      expect(a.backups).toHaveLength(1);
      expect(a.backups![0]).not.toContain('?name=orig');
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
    }
  });

  test('标题 = 正文首行，tags 来自 hashtags', () => {
    const r = parseTwitter(payload(tweetText), { id: '2114261795426963926' });
    expect(r.title).toBe('Example tweet text with media');
    expect(r.description).toBe('Example tweet text with media');
    // tags 来自 entities.hashtags（真实字段保留在脱敏 fixture 里）
    expect(r.tags).toEqual(['Russia', 'Ukraine', 'Kupiansk', 'Kharkiv']);
  });

  test('纯文本推（无媒体）→ UNSUPPORTED_CONTENT', () => {
    const bare = { ...tweetText, mediaDetails: undefined, photos: undefined };
    try {
      parseTwitter(payload(bare), { id: '2114261795426963926' });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('UNSUPPORTED_CONTENT');
    }
  });

  test('载荷缺 user → UPSTREAM_CHANGED', () => {
    try {
      parseTwitter(payload({ __typename: 'Tweet' }), { id: '1' });
      throw new Error('should throw');
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('via 非 api → UPSTREAM_CHANGED', () => {
    try {
      parseTwitter(
        { via: 'browser-intercept', channel: 'browser', fetchedAt: 0, body: tweetVideo },
        { id: '1' },
      );
      throw new Error('should throw');
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });
});
