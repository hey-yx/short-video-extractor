import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/** GraphQL media 对象（只声明用到的字段，多余字段 fixture 原样保留） */
interface IgVideoVersion {
  url?: string;
  width?: number;
  height?: number;
  type?: number;
}

interface IgImageCandidate {
  url?: string;
  width?: number;
  height?: number;
}

interface IgMedia {
  code?: string;
  pk?: string;
  id?: string;
  media_type?: number;
  product_type?: string;
  /** DASH manifest（XML 字符串）；Reels 的总时长只在 MPD 的 mediaPresentationDuration 属性里 */
  video_dash_manifest?: string;
  video_versions?: IgVideoVersion[];
  image_versions2?: { candidates?: IgImageCandidate[] };
  carousel_media?: IgMedia[];
  carousel_media_count?: number;
  original_width?: number;
  original_height?: number;
  taken_at?: number;
  user?: { username?: string; full_name?: string; profile_pic_url?: string; pk?: string };
  caption?: { text?: string } | null;
}

/** fetch() 产出的复合载荷（fixture 可录制回放） */
interface InstagramPayload {
  /** 本条请求注入的 doc_id（轮换归因用） */
  docId: string;
  data: { xdt_api__v1__media__shortcode__web_info?: { items?: IgMedia[] } } | null;
  errors?: Array<{ message?: string; path?: string[] }>;
}

/** execution error：无效/已删 shortcode 的失败态（HTTP 仍 200，调研 05 §2.3） */
const EXECUTION_ERROR_PATH = 'xdt_api__v1__media__shortcode__web_info';

/** ISO-8601 时长（PT33.034481S）→ 毫秒；解析不出返回 undefined */
export function isoDurationToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(
    /^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  if (!m) return undefined;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0));
  const total = ((d ?? 0) * 24 + (h ?? 0)) * 3600 + (min ?? 0) * 60 + (s ?? 0);
  return total > 0 ? Math.round(total * 1000) : undefined;
}

/** fbcdn 直链 oe= 参数是过期时刻的十六进制 Unix 秒（实测 6AE0B1E9 → 2026-10-27）；读不出返回 undefined */
export function urlExpiry(url: string): number | undefined {
  const m = url.match(/[?&]oe=([0-9A-Fa-f]+)(?:[&#]|$)/);
  if (!m?.[1]) return undefined;
  const ts = Number.parseInt(m[1], 16);
  return Number.isFinite(ts) && ts > 1e9 && ts < 1e11 ? ts : undefined;
}

function mediaItems(payload: InstagramPayload, id: string): IgMedia {
  if (payload.errors?.some((e) => e.path?.includes(EXECUTION_ERROR_PATH))) {
    throw new AppError('CONTENT_NOT_FOUND', 'Instagram 作品不存在或已删除', { shortcode: id });
  }
  const item = payload.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
  if (!item) {
    throw new AppError('UPSTREAM_CHANGED', 'Instagram 响应缺少 media items（结构可能已变化）', {
      shortcode: id,
    });
  }
  return item;
}

function bestImage(media: IgMedia): IgImageCandidate | undefined {
  return media.image_versions2?.candidates?.find((c) => !!c.url);
}

/** 视频档位：全列表去空按分辨率降序；同分辨率多档（type 101/102/103）取首个 */
function videoVariants(media: IgMedia, excludeHeight?: number): AssetVariant[] {
  const byTier = new Map<number, IgVideoVersion>();
  for (const v of media.video_versions ?? []) {
    if (!v.url) continue;
    const key = v.height ?? -1;
    if (key === excludeHeight) continue;
    if (!byTier.has(key)) byTier.set(key, v);
  }
  return [...byTier.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((v) => ({
      ratio: v.height ? `${v.height}p` : 'origin',
      url: v.url!,
      width: v.width,
      height: v.height,
      watermark: false,
    }));
}

function videoAssetOf(media: IgMedia): MediaAsset {
  const versions = (media.video_versions ?? []).filter((v) => !!v.url);
  if (versions.length === 0) {
    throw new AppError('CONTENT_NOT_FOUND', 'Instagram 作品没有可用视频流', { shortcode: media.code });
  }
  // video_versions 实测按分辨率降序（首档最高）；Progressive mp4 直链
  const primary = versions[0]!;
  const cover = bestImage(media);
  const asset: MediaAsset = {
    type: 'video',
    url: primary.url!,
    width: primary.width ?? media.original_width,
    height: primary.height ?? media.original_height,
    durationMs: isoDurationToMs(
      media.video_dash_manifest?.match(/mediaPresentationDuration="([^"]+)"/)?.[1] ??
        media.video_dash_manifest?.match(/duration="([^"]+)"/)?.[1],
    ),
    coverUrl: cover?.url,
    variants: videoVariants(media, primary.height),
  };
  const expiries = versions.map((v) => urlExpiry(v.url!)).filter((t): t is number => t !== undefined);
  if (expiries.length > 0) asset.expiresAt = Math.min(...expiries);
  return asset;
}

function imageAssetOf(media: IgMedia): MediaAsset {
  const img = bestImage(media);
  if (!img?.url) {
    throw new AppError('CONTENT_NOT_FOUND', 'Instagram 作品没有可用图片', { shortcode: media.code });
  }
  return {
    type: 'image',
    url: img.url,
    width: img.width ?? media.original_width,
    height: img.height ?? media.original_height,
  };
}

/** caption 首行截断做标题（与 twitter 同款约定）；caption 缺省给 `Instagram <code>` */
function splitTitle(text: string): { title: string; description: string } {
  const title = (text.split('\n')[0] ?? '').slice(0, 80).trim();
  return { title, description: text };
}

export function parseInstagram(raw: RawPayload, input: { id: string }): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `Instagram 解析收到未知载荷类型: ${raw.via}`);
  }
  const payload = raw.body as InstagramPayload | null;
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new AppError('UPSTREAM_CHANGED', 'Instagram 载荷缺少 GraphQL 响应');
  }
  const media = mediaItems(payload, input.id);

  const captionText = media.caption?.text ?? '';
  const { title, description } = splitTitle(captionText);

  // 图集（media_type 8）：子项含视频时给视频（Reels 混排图集），纯图给图片
  const carousel = media.carousel_media ?? [];
  let assets: MediaAsset[];
  let kind: ParseResult['kind'];
  if (carousel.length > 0) {
    kind = 'album';
    assets = carousel.map((sub) => (sub.media_type === 2 ? videoAssetOf(sub) : imageAssetOf(sub)));
  } else if (media.media_type === 2 || (media.video_versions?.length ?? 0) > 0) {
    kind = 'video';
    assets = [videoAssetOf(media)];
  } else {
    kind = 'album';
    assets = [imageAssetOf(media)];
  }

  const expiresAt = assets
    .map((a) => a.expiresAt)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)[0];

  return {
    platform: 'instagram',
    id: media.code ?? input.id,
    kind,
    title: title || `Instagram ${media.code ?? input.id}`,
    description: description || undefined,
    tags: [...captionText.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!).slice(0, 30),
    author: {
      name: media.user?.username ?? '',
      avatar: media.user?.profile_pic_url,
      id: media.user?.pk,
    },
    assets,
    expiresAt,
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}
