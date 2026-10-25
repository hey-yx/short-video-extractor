import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParsedAuthor, ParseResult } from '@/types/platform';
import type { RawPayload } from '@/types/platform';

/**
 * 快手分享页 INIT_STATE 解析（纯函数）。
 * 页面结构：window.INIT_STATE = {...}，外层 key 做了 ASCII+1 混淆，
 * 内层 photo JSON 的 key 是明文，按子串定位（见 docs/research/02 §2.3）。
 */

interface KwaiRepresentation {
  url?: string;
  backupUrl?: string[];
  qualityType?: string;
  width?: number;
  height?: number;
  fileSize?: number;
}

interface KwaiPhoto {
  photoId?: string;
  caption?: string;
  mainMvUrls?: Array<{ url?: string; cdn?: string }>;
  manifest?: { adaptationSet?: Array<{ representation?: KwaiRepresentation[] }> };
  coverUrls?: Array<{ url?: string }>;
  duration?: number;
  width?: number;
  height?: number;
  likeCount?: string | number;
  viewCount?: string | number;
  userName?: string;
  headUrl?: string;
  headUrls?: Array<{ url?: string }>;
  picUrls?: Array<{ url?: string; cdn?: string }>; // 图集（字段名未核验，做兼容）
}

/** 从 HTML 里抠出 photo JSON（不依赖外层混淆 key） */
export function extractPhotoJson(html: string): KwaiPhoto {
  // 定位 "photo":{...}：INIT_STATE 内层是明文 key
  const idx = html.indexOf('"photo":');
  if (idx < 0) {
    throw new AppError('UPSTREAM_CHANGED', '快手分享页未找到 photo 数据（页面结构可能已改版）');
  }
  // 从 "photo": 后的 { 开始做括号配平
  const start = html.indexOf('{', idx);
  if (start < 0) throw new AppError('UPSTREAM_CHANGED', '快手 photo 数据格式异常');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as KwaiPhoto;
        } catch (e) {
          throw new AppError('UPSTREAM_CHANGED', '快手 photo JSON 解析失败', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }
  throw new AppError('UPSTREAM_CHANGED', '快手 photo JSON 未闭合');
}

function sortRepresentations(reps: KwaiRepresentation[]): KwaiRepresentation[] {
  return [...reps].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

export function parseKuaishou(raw: RawPayload): ParseResult {
  if (raw.via !== 'html-embedded-json') {
    throw new AppError('UPSTREAM_CHANGED', `快手解析收到未知载荷类型: ${raw.via}`);
  }
  const photo = extractPhotoJson(raw.body as string);

  // 图集：picUrls 存在且无视频流
  const picUrls = (photo.picUrls ?? []).map((p) => p?.url).filter((u): u is string => !!u);
  const isAlbum = picUrls.length > 0 && !(photo.manifest || photo.mainMvUrls);

  let assets: MediaAsset[];
  if (isAlbum) {
    assets = picUrls.map((url) => ({ type: 'image', url }));
  } else {
    const reps = sortRepresentations(
      (photo.manifest?.adaptationSet ?? []).flatMap((s) => s.representation ?? []),
    );
    const main = photo.mainMvUrls?.[0]?.url;
    const best = reps[0];
    const primary = best?.url ?? main;
    if (!primary) {
      throw new AppError('UPSTREAM_CHANGED', '快手返回数据中无可下载资源');
    }
    // 最高档作主 URL，其余进 variants（快手 CDN 不校验 Referer/UA）
    const variants: AssetVariant[] = reps.slice(1).map((r) => ({
      ratio: r.qualityType ?? `${r.height ?? 0}p`,
      url: r.url ?? '',
      size: r.fileSize,
      width: r.width,
      height: r.height,
      watermark: false,
    }));
    assets = [
      {
        type: 'video',
        url: primary,
        size: best?.fileSize,
        width: best?.width,
        height: best?.height,
        durationMs: photo.duration,
        coverUrl: photo.coverUrls?.[0]?.url,
        variants,
      },
    ];
  }

  return {
    platform: 'kuaishou',
    id: photo.photoId ?? '',
    kind: isAlbum ? 'album' : 'video',
    title: (photo.caption ?? '').split('\n')[0] ?? '',
    description: photo.caption,
    author: { name: photo.userName ?? '', avatar: photo.headUrl ?? photo.headUrls?.[0]?.url },
    assets,
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult & { author: ParsedAuthor };
}
