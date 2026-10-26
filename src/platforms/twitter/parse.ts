import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/**
 * syndication tweet-result 载荷解析（纯函数，fixture 离线回归）。
 * 字段以 2026-10-26 真实响应为准（tests/fixtures/twitter/，脱敏录制）。
 */

interface TweetUser {
  id_str?: string;
  name?: string;
  screen_name?: string;
  profile_image_url_https?: string;
}

interface TweetEntities {
  hashtags?: Array<{ text?: string }>;
}

interface TweetMedia {
  type?: string;
  media_url_https?: string;
  original_info?: { width?: number; height?: number };
  video_info?: {
    duration_millis?: number;
    variants?: Array<{
      content_type?: string;
      bitrate?: number;
      url?: string;
    }>;
  };
}

export interface TweetResult {
  id_str?: string;
  text?: string;
  created_at?: string;
  user?: TweetUser;
  entities?: TweetEntities;
  mediaDetails?: TweetMedia[];
}

/** fetch() 产出的载荷形态：body 即 syndication JSON（fixture 可录制回放） */
export type TwitterPayload = TweetResult;

/** pbs.twimg.com 图片的原图参数（实测 base 96KB vs ?name=orig 439KB） */
const ORIG_SUFFIX = '?name=orig';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** syndication 对已删除/受保护推文返回 HTML 错误页而非 JSON（research/02 §8.3 实测坑） */
export function parseTweetResultJson(text: string, tweetId: string): TweetResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('UPSTREAM_CHANGED', 'syndication 返回非 JSON（疑似错误页）', { tweetId });
  }
  if (!isRecord(json)) {
    throw new AppError('UPSTREAM_CHANGED', 'syndication 返回了非对象 JSON', { tweetId });
  }
  if (Object.keys(json).length === 0) {
    // 无 token/无效 id 的空对象响应
    throw new AppError('CONTENT_NOT_FOUND', '推文不存在或 syndication 未返回数据', { tweetId });
  }
  const typename = str(json.__typename);
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
    throw new AppError('CONTENT_NOT_FOUND', '推文已删除或不可见', { tweetId, typename });
  }
  if (typename !== 'Tweet' || !isRecord(json.user)) {
    throw new AppError('UPSTREAM_CHANGED', 'syndication 载荷结构变化（缺 __typename=user）', {
      tweetId,
      typename,
    });
  }
  return json as unknown as TweetResult;
}

/** 视频档名：bitrate → 与 B 站 qualityName 同风格的可读档位 */
function bitrateName(bitrate: number | undefined, url: string): string {
  const m = url.match(/\/vid\/[^/]+\/(\d+x\d+)\//);
  if (m?.[1]) return m[1];
  if (bitrate === undefined) return 'hls';
  return `${Math.round(bitrate / 1000)}kbps`;
}

function videoVariants(media: TweetMedia): {
  main: AssetVariant | null;
  rest: AssetVariant[];
  cover: string;
} {
  const variants = (media.video_info?.variants ?? []).filter((v) => str(v.url) !== '');
  const mp4 = variants
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const main = mp4[0];
  const cover = str(media.media_url_https);
  if (!main?.url) return { main: null, rest: [], cover };
  const rest = mp4.slice(1).map((v) => ({
    ratio: bitrateName(v.bitrate, str(v.url)),
    url: str(v.url),
    watermark: false,
  }));
  const hls = variants.find((v) => v.content_type === 'application/x-mpegURL');
  if (hls?.url) {
    rest.push({ ratio: 'hls', url: hls.url, watermark: false });
  }
  return {
    main: { ratio: bitrateName(main.bitrate, main.url), url: main.url, watermark: false },
    rest,
    cover,
  };
}

function mediaAssets(mediaDetails: TweetMedia[]): MediaAsset[] {
  const assets: MediaAsset[] = [];
  for (const media of mediaDetails) {
    const type = str(media.type);
    if (type === 'photo') {
      const url = str(media.media_url_https);
      if (!url) continue;
      const info = media.original_info;
      assets.push({
        type: 'image',
        url: `${url}${ORIG_SUFFIX}`,
        width: info?.width,
        height: info?.height,
        backups: [url],
      });
      continue;
    }
    if (type === 'video' || type === 'animated_gif') {
      const { main, rest, cover } = videoVariants(media);
      if (!main) continue;
      const asset: MediaAsset = {
        type: 'video',
        url: main.url,
        width: media.original_info?.width,
        height: media.original_info?.height,
        durationMs: media.video_info?.duration_millis,
        coverUrl: cover || undefined,
        variants: rest.length > 0 ? rest : undefined,
      };
      assets.push(asset);
    }
  }
  return assets;
}

/** 正文首段做标题（与抖音/小红书同风格）；t.co 链接节点从正文剥离 */
function splitTitle(text: string): { title: string; description: string } {
  const description = text.trim();
  const title = (description.split('\n')[0] ?? '').slice(0, 80).trim();
  return { title, description };
}

export function parseTwitter(raw: RawPayload, input: { id: string }): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `X 解析收到未知载荷类型: ${raw.via}`);
  }
  const tweet = raw.body as TwitterPayload;
  if (!tweet || !tweet.user) {
    throw new AppError('UPSTREAM_CHANGED', 'X 载荷缺少推文数据');
  }

  const assets = mediaAssets(tweet.mediaDetails ?? []);
  if (assets.length === 0) {
    throw new AppError('UNSUPPORTED_CONTENT', '推文没有可下载的视频或图片', {
      tweetId: tweet.id_str ?? input.id,
    });
  }

  const { title, description } = splitTitle(str(tweet.text));
  const tags = (tweet.entities?.hashtags ?? []).map((h) => str(h.text)).filter((t) => t !== '');

  return {
    platform: 'twitter',
    id: tweet.id_str ?? input.id,
    kind: assets[0]?.type === 'video' ? 'video' : 'album',
    title: title || `X post ${tweet.id_str ?? input.id}`,
    description: description || undefined,
    tags: tags.length > 0 ? tags : undefined,
    author: {
      name: str(tweet.user.name) || str(tweet.user.screen_name),
      id: str(tweet.user.id_str) || undefined,
      avatar: str(tweet.user.profile_image_url_https) || undefined,
    },
    assets,
    // syndication 不给媒体过期时刻；twimg 直链无时效签名，不编 expiresAt
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}
