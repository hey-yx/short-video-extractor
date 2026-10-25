import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParsedAuthor, ParseResult } from '@/types/platform';
import type { RawPayload } from '@/types/platform';
import { buildPlayUrl } from './adapter';

/* ---------- aweme_detail 的最小类型视图（字段路径实测见 docs/research/01 §5） ---------- */

interface UrlList {
  uri?: string;
  url_list?: string[];
  data_size?: number;
  width?: number;
  height?: number;
}

interface AwemeImage {
  uri?: string;
  url_list?: string[];
  download_url_list?: string[];
  width?: number;
  height?: number;
  live_photo_type?: number;
  clip_type?: number;
  video?: { play_addr?: UrlList } | null;
}

interface AwemeDetail {
  aweme_id?: string;
  desc?: string;
  media_type?: number;
  create_time?: number;
  author?: { nickname?: string; sec_uid?: string; avatar_thumb?: UrlList };
  video?: {
    play_addr?: UrlList;
    download_addr?: UrlList;
    cover?: UrlList;
    duration?: number;
    bit_rate?: Array<{
      gear_name?: string;
      bit_rate?: number;
      is_h265?: boolean;
      play_addr?: UrlList;
    }>;
    cdn_url_expired?: number;
  };
  images?: AwemeImage[] | null;
  text_extra?: Array<{ hashtag_name?: string }>;
  filter_detail?: { filter_reason?: string; detail_msg?: string };
}

interface DetailResponse {
  aweme_detail?: AwemeDetail | null;
  filter_detail?: { filter_reason?: string; detail_msg?: string };
}

/* ---------- 工具 ---------- */

function firstUrl(u?: UrlList): string | undefined {
  return u?.url_list?.[0];
}

/** 直链 TTL：视频约 3h、图片约 30 天（实测）。取不到时按保守值 */
function expiresFromDetail(d: AwemeDetail): number | undefined {
  if (d.video?.cdn_url_expired && d.video.cdn_url_expired > 0) return d.video.cdn_url_expired;
  return undefined;
}

function authorOf(d: AwemeDetail): ParsedAuthor {
  return {
    name: d.author?.nickname ?? '',
    id: d.author?.sec_uid,
    avatar: firstUrl(d.author?.avatar_thumb),
  };
}

function tagsOf(d: AwemeDetail): string[] {
  return (d.text_extra ?? [])
    .map((t) => t.hashtag_name)
    .filter((n): n is string => !!n);
}

/* ---------- 视频：play 直链 + variants 档位 ---------- */

function videoAsset(d: AwemeDetail): MediaAsset | null {
  const v = d.video;
  const uri = v?.play_addr?.uri;
  if (!uri) return null;

  const variants: AssetVariant[] = [];
  // bit_rate 是服务端给的转码档（1080/720/540…）
  for (const g of v?.bit_rate ?? []) {
    const u = firstUrl(g.play_addr);
    if (!u) continue;
    variants.push({
      ratio: g.gear_name ?? 'unknown',
      // gear_name 形如 normal_1080_0；直链统一换 play 形态（空 Referer 可下）
      url: buildPlayUrl(uri, ratioFromGear(g.gear_name)),
      size: g.play_addr?.data_size,
      width: g.play_addr?.width,
      height: g.play_addr?.height,
      watermark: false,
    });
  }
  // 原片通道（QuickTime 容器，27MB 级，实测可下）
  variants.push({ ratio: 'origin', url: buildPlayUrl(uri, 'default'), watermark: false });
  // 带水印版（平台"保存"档）
  const dl = firstUrl(v?.download_addr);
  if (dl) variants.push({ ratio: 'watermarked_720p', url: dl, size: v?.download_addr?.data_size, watermark: true });

  // 主 URL：play 接口 1080p（实测空 Referer 200）
  return {
    type: 'video',
    url: buildPlayUrl(uri, '1080p'),
    size: v?.play_addr?.data_size,
    width: v?.play_addr?.width,
    height: v?.play_addr?.height,
    durationMs: v?.duration,
    coverUrl: firstUrl(v?.cover),
    variants,
  };
}

function ratioFromGear(gear?: string): string {
  const m = gear?.match(/(\d{3,4})/);
  return m?.[1] ? `${m[1]}p` : '1080p';
}

/* ---------- 图集 ---------- */

function imageAssets(d: AwemeDetail): MediaAsset[] {
  return (d.images ?? []).map((img) => {
    const url = img.url_list?.[0];
    const isLive = img.live_photo_type === 1 && img.clip_type === 5;
    return {
      type: 'image',
      url: url ?? '',
      width: img.width,
      height: img.height,
      // 实况照片的 5s 视频（720p 无水印）
      liveClipUrl: isLive ? firstUrl(img.video?.play_addr) : undefined,
      variants: (img.download_url_list?.[0]
        ? [{ ratio: 'watermarked', url: img.download_url_list[0]!, watermark: true }]
        : []) as AssetVariant[],
    } satisfies MediaAsset;
  });
}

/* ---------- 入口：纯函数 ---------- */

export function parseAweme(raw: RawPayload): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `抖音解析收到未知载荷类型: ${raw.via}`);
  }
  const body = raw.body as DetailResponse;
  const d: AwemeDetail | null | undefined = body.aweme_detail;
  if (!d) {
    const reason = body.filter_detail?.filter_reason;
    if (reason) {
      // 作品本身不可见（删除/私密/地域），重试无意义
      throw new AppError('CONTENT_RESTRICTED', body.filter_detail?.detail_msg || '作品不可见', { filter_reason: reason });
    }
    throw new AppError('CONTENT_NOT_FOUND', '作品不存在或已删除');
  }

  const isAlbum = d.media_type === 2 || (d.images?.length ?? 0) > 0;
  const assets = isAlbum ? imageAssets(d) : [videoAsset(d)].filter((a): a is MediaAsset => a !== null);

  if (assets.length === 0 || assets.every((a) => !a.url)) {
    throw new AppError('UPSTREAM_CHANGED', '抖音返回数据中无可下载资源', { media_type: d.media_type });
  }

  const expiresAt = expiresFromDetail(d);
  const desc = d.desc ?? '';
  return {
    platform: 'douyin',
    id: d.aweme_id ?? '',
    kind: isAlbum ? 'album' : 'video',
    title: desc.split('\n')[0] ?? '',
    description: desc,
    tags: tagsOf(d),
    author: authorOf(d),
    assets,
    expiresAt,
    parsedAt: raw.fetchedAt,
    via: 'http',
  };
}
