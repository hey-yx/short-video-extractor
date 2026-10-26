import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/**
 * tikwm /api/ 响应解析（纯函数，fixture 离线回归）。
 * 字段以 2026-10-26 真实响应为准（tests/fixtures/tiktok/，脱敏录制，字段名照实）：
 *   code=0 成功；code=-1 失败（msg 见 mapTikwmFailure）。
 *   视频：play（无水印 SD）/ hdplay（无水印 HD）/ wmplay（带水印）/ music / cover。
 *   图集：images[]（无水印原图）；此时 play/hdplay/wmplay 与 music 同值（无视频流）。
 *   直链 path 第二段 hex 是过期 Unix 秒（实测 now+21624s），读不出则不编 expiresAt。
 */

interface TikwmAuthor {
  id?: string;
  unique_id?: string;
  nickname?: string;
  avatar?: string;
}

interface TikwmMusicInfo {
  id?: string;
  title?: string;
  play?: string;
  cover?: string;
  duration?: number;
}

interface TikwmData {
  id?: string;
  title?: string;
  cover?: string;
  origin_cover?: string;
  duration?: number;
  size?: number;
  wm_size?: number;
  hd_size?: number;
  play?: string;
  wmplay?: string;
  hdplay?: string;
  images?: string[];
  music?: string;
  music_info?: TikwmMusicInfo;
  author?: TikwmAuthor;
  create_time?: number;
}

/** fetch() 产出的载荷形态：body 即 tikwm 响应 JSON（fixture 可录制回放） */
export interface TikwmPayload {
  code?: number;
  msg?: string;
  data?: TikwmData;
}

/** 直链 path 的 /<hex>/ 段是过期 Unix 秒（8 位 hex，略晚于请求时刻才算数） */
export function urlExpiry(url: string, nowSec: number): number | undefined {
  const seg = url
    .split('?')[0]
    ?.split('/')
    .find((s) => /^[0-9a-f]{8,11}$/.test(s));
  const ts = seg ? Number.parseInt(seg, 16) : NaN;
  return Number.isFinite(ts) && ts > nowSec && ts < nowSec + 30 * 86400 ? ts : undefined;
}

/** tikwm 偶发回相对路径（/video/tos/...），补成 tikwm.com 中转域 */
function absUrl(u: string): string {
  return u ? (u.startsWith('/') ? `https://www.tikwm.com${u}` : u) : u;
}

/**
 * tikwm 失败形态 → AppError（fetch 与 parse 共用，纯函数）。
 * code=-1 是唯一失败码，具体原因只能从 msg 区分；限频响应无 JSON（HTTP 429/HTML）由 fetch 层处理。
 */
export function mapTikwmFailure(
  code: number | undefined,
  msg: string | undefined,
  videoId: string,
): AppError {
  const detail = { videoId, code, msg };
  const m = (msg ?? '').toLowerCase();
  if (m.includes('frequent') || m.includes('rate') || m.includes('limit') || m.includes('too many')) {
    return new AppError('RATE_LIMITED', `tikwm 限频（${msg ?? code}）`, detail);
  }
  if (m.includes('parsing') || m.includes('invalid') || m.includes('check url')) {
    return new AppError('CONTENT_NOT_FOUND', `TikTok 作品不存在或链接无法识别（${msg ?? code}）`, detail);
  }
  return new AppError('UPSTREAM_ERROR', `tikwm 返回失败（${msg ?? code}）`, detail);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function authorOf(data: TikwmData, videoId: string): ParsedAuthorOf {
  return {
    name: str(data.author?.nickname) || str(data.author?.unique_id),
    id: str(data.author?.id) || undefined,
    avatar: str(data.author?.avatar) || undefined,
  };
}

interface ParsedAuthorOf {
  name: string;
  id?: string;
  avatar?: string;
}

/** 标题：tikwm 的 title 就是完整文案（tag 含在内），不再另拆 description */
function splitTitle(title: string): { title: string; tags: string[] } {
  const tags = [...title.matchAll(/#([^\s#]+)/g)].map((m) => m[1] ?? '').filter((t) => t !== '');
  return { title: title.trim().slice(0, 80) || 'TikTok 视频', tags };
}

function videoAsset(data: TikwmData, nowSec: number): MediaAsset {
  const play = absUrl(str(data.play));
  const hdplay = absUrl(str(data.hdplay));
  const variants: AssetVariant[] = [];
  // 主档 play（无水印 SD）；HD 进 variants；wmplay 如实标 watermark
  if (hdplay) {
    variants.push({ ratio: 'hd', url: hdplay, size: data.hd_size, watermark: false });
  }
  if (str(data.wmplay)) {
    variants.push({ ratio: 'sd', url: absUrl(str(data.wmplay)), size: data.wm_size, watermark: true });
  }
  const expiries = [urlExpiry(play, nowSec), ...variants.map((v) => urlExpiry(v.url, nowSec))].filter(
    (t): t is number => t !== undefined,
  );
  const asset: MediaAsset = {
    type: 'video',
    url: play,
    durationMs: data.duration && data.duration > 0 ? data.duration * 1000 : undefined,
    size: data.size,
    coverUrl: absUrl(str(data.origin_cover)) || absUrl(str(data.cover)) || undefined,
    variants: variants.length > 0 ? variants : undefined,
  };
  if (expiries.length > 0) {
    asset.expiresAt = Math.min(...expiries);
  }
  const music = str(data.music);
  if (music) {
    asset.audioUrl = absUrl(music);
  }
  return asset;
}

function albumAssets(data: TikwmData): MediaAsset[] {
  const images = (data.images ?? []).filter((u) => typeof u === 'string' && u !== '');
  return images.map((url) => ({
    type: 'image' as const,
    url: absUrl(url),
  }));
}

export function parseTiktok(raw: RawPayload, input: { id: string }): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `TikTok 解析收到未知载荷类型: ${raw.via}`);
  }
  const payload = raw.body as TikwmPayload | null;
  if (!payload || typeof payload !== 'object') {
    throw new AppError('UPSTREAM_CHANGED', 'TikTok 载荷缺少 tikwm 响应');
  }
  if (payload.code !== 0) {
    throw mapTikwmFailure(payload.code, payload.msg, input.id);
  }
  const data = payload.data;
  if (!data) {
    throw new AppError('UPSTREAM_CHANGED', 'tikwm 响应缺少 data', { videoId: input.id });
  }
  const id = str(data.id) || input.id;

  const hasImages = (data.images ?? []).length > 0;
  const play = str(data.play);
  if (!play && !hasImages) {
    throw new AppError('UPSTREAM_CHANGED', 'tikwm 响应没有可下载资源（既无 play 也无 images）', {
      videoId: id,
    });
  }
  // 图集响应里 play 与 music 同值（无视频流），只有 images[] 是真资源
  const isAlbum = hasImages && (!play || play === str(data.music));

  const assets = isAlbum || (hasImages && !play) ? albumAssets(data) : [videoAsset(data, raw.fetchedAt)];
  if (assets.length === 0) {
    throw new AppError('UPSTREAM_CHANGED', 'tikwm 响应没有可下载资源（既无 play 也无 images）', {
      videoId: id,
    });
  }

  const { title, tags } = splitTitle(str(data.title));
  const expiresAt = assets.map((a) => a.expiresAt).filter((t): t is number => t !== undefined);

  return {
    platform: 'tiktok',
    id,
    kind: assets[0]!.type === 'video' ? 'video' : 'album',
    title,
    tags: tags.length > 0 ? tags : undefined,
    author: authorOf(data, id),
    assets,
    expiresAt: expiresAt.length > 0 ? Math.min(...expiresAt) : undefined,
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}
