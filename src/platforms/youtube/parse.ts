import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/** innertube /player 响应（只声明用到的字段，多余字段 fixture 原样保留） */
interface YtFormat {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  audioQuality?: string;
  contentLength?: string;
  fps?: number;
}

interface YtPlayer {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    expiresInSeconds?: string | number;
    formats?: YtFormat[];
    adaptiveFormats?: YtFormat[];
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    shortDescription?: string;
    author?: string;
    channelId?: string;
    lengthSeconds?: string;
    thumbnail?: { thumbnails?: Array<{ url?: string; width?: number; height?: number }> };
  };
}

/** fetch() 产出的复合载荷（fixture 可录制回放） */
interface YoutubePayload {
  /** 实际成功的 innertube client（ANDROID_VR / IOS），降级归因用 */
  client: string;
  player: YtPlayer;
}

/**
 * playabilityStatus → AppError 的映射（fetch 换 client 与 parse 校验共用，纯函数）。
 * LOGIN_REQUIRED 是 bot 检查（「Sign in to confirm you're not a bot」），不是内容不可用。
 */
export function mapPlayability(status: string | undefined, reason: string | undefined): AppError {
  const detail = { status, reason };
  if (status === 'LOGIN_REQUIRED') {
    return new AppError('RISK_CONTROL', `YouTube 风控拦截（${reason ?? status}）`, detail);
  }
  if (status === 'UNPLAYABLE' || status === 'AGE_CHECK_REQUIRED' || status === 'CONTENT_CHECK_REQUIRED') {
    return new AppError('CONTENT_RESTRICTED', `YouTube 视频受限（${reason ?? status}）`, detail);
  }
  if (status === 'ERROR' || status === 'VIDEO_UNAVAILABLE') {
    return new AppError('CONTENT_NOT_FOUND', `YouTube 视频不可用（${reason ?? status}）`, detail);
  }
  return new AppError('UPSTREAM_ERROR', `YouTube 播放状态异常: ${status ?? '未知'}`, detail);
}

function isMp4(f: YtFormat): boolean {
  return (f.mimeType ?? '').startsWith('video/mp4');
}

function hasAudio(f: YtFormat): boolean {
  return f.audioQuality !== undefined;
}

function fmtUrl(f: YtFormat): string {
  return f.url ?? '';
}

/** 同档位多编码（avc1/vp9/av1）取 mp4 优先、其次码率最高 */
function pickBest(list: YtFormat[]): YtFormat | undefined {
  return [...list].sort((a, b) => {
    const mp4 = Number(isMp4(b)) - Number(isMp4(a));
    if (mp4 !== 0) return mp4;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  })[0];
}

/** googlevideo 直链的 expire= 参数是过期 Unix 秒（10 位），读不出返回 undefined */
function urlExpiry(url: string): number | undefined {
  const m = url.match(/[?&]expire=(\d{9,11})(?:[&#]|$)/);
  const ts = m?.[1] ? Number(m[1]) : undefined;
  return ts !== undefined && ts > 1e9 && ts < 1e11 ? ts : undefined;
}

export function parseYoutube(raw: RawPayload, input: { id: string }): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `YouTube 解析收到未知载荷类型: ${raw.via}`);
  }
  const payload = raw.body as YoutubePayload | null;
  if (!payload || typeof payload.client !== 'string' || !payload.player) {
    throw new AppError('UPSTREAM_CHANGED', 'YouTube 载荷缺少 player 响应');
  }
  const player = payload.player;
  const ps = player.playabilityStatus;
  if (ps?.status !== 'OK') {
    throw mapPlayability(ps?.status, ps?.reason);
  }
  const details = player.videoDetails;
  const sd = player.streamingData;
  if (!details || !sd) {
    throw new AppError('UPSTREAM_CHANGED', 'YouTube 响应缺少 videoDetails/streamingData');
  }

  const all = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])].filter((f) => fmtUrl(f));
  if (all.length === 0) {
    const ciphered = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])];
    if (ciphered.length > 0) {
      throw new AppError('UPSTREAM_CHANGED', 'YouTube 只返回加密直链（signatureCipher），解析需更新');
    }
    throw new AppError('UPSTREAM_CHANGED', 'YouTube 响应没有可用格式');
  }

  // 进度性合并档（含音轨的 mp4，免合成直出）优先；否则 DASH 视频 + 伴音轨
  const muxed = all.filter((f) => isMp4(f) && hasAudio(f));
  const videoOnly = all.filter((f) => !hasAudio(f));
  const audioOnly = all.filter((f) => (f.mimeType ?? '').startsWith('audio/'));

  let primary: YtFormat | undefined;
  if (muxed.length > 0) {
    primary = pickBest(muxed);
  } else {
    primary = pickBest(videoOnly);
  }
  if (!primary || !fmtUrl(primary)) {
    throw new AppError('UPSTREAM_CHANGED', 'YouTube 无可用视频流');
  }

  // 伴音轨（DASH 音视频分离）：mp4a 优先、码率最高；进度性主档不依赖它，但 DASH 档位需要
  const bestAudio = [...audioOnly].sort((a, b) => {
    const mp4 =
      Number((b.mimeType ?? '').startsWith('audio/mp4')) - Number((a.mimeType ?? '').startsWith('audio/mp4'));
    if (mp4 !== 0) return mp4;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  })[0];

  // 其余清晰度进 variants：一档一位（同档位多编码取 mp4/bitrate 最高），主 URL 所在档位不重复
  const byTier = new Map<number, YtFormat>();
  for (const f of [...muxed, ...videoOnly]) {
    const key = f.height ?? -1;
    if (key === (primary.height ?? -1)) continue;
    const cur = byTier.get(key);
    if (
      !cur ||
      Number(isMp4(f)) > Number(isMp4(cur)) ||
      (isMp4(f) === isMp4(cur) && (f.bitrate ?? 0) > (cur.bitrate ?? 0))
    ) {
      byTier.set(key, f);
    }
  }
  const variants: AssetVariant[] = [...byTier.values()]
    .filter((f) => fmtUrl(f))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((f) => ({
      ratio: f.height ? `${f.height}p` : `itag${f.itag ?? '?'}`,
      url: fmtUrl(f),
      width: f.width,
      height: f.height,
      watermark: false,
    }));

  const durationSec = Number(details.lengthSeconds ?? 0);
  const thumbs = details.thumbnail?.thumbnails ?? [];
  const cover = [...thumbs].reverse().find((t) => typeof t.url === 'string');

  const asset: MediaAsset = {
    type: 'video',
    url: fmtUrl(primary),
    width: primary.width,
    height: primary.height,
    durationMs: Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : undefined,
    size: primary.contentLength ? Number(primary.contentLength) : undefined,
    coverUrl: cover?.url,
    variants,
  };
  if (bestAudio && fmtUrl(bestAudio)) {
    asset.audioUrl = fmtUrl(bestAudio);
    if (asset.size !== undefined && bestAudio.contentLength) {
      asset.size += Number(bestAudio.contentLength);
    }
  }

  // 直链时效：URL expire= 与 expiresInSeconds 双源取最早
  const expiresSec = Number(sd.expiresInSeconds ?? 0);
  const expiries = [
    urlExpiry(asset.url),
    asset.audioUrl ? urlExpiry(asset.audioUrl) : undefined,
    Number.isFinite(expiresSec) && expiresSec > 0 ? raw.fetchedAt + expiresSec : undefined,
  ].filter((t): t is number => t !== undefined);
  if (expiries.length > 0) {
    asset.expiresAt = Math.min(...expiries);
  }

  return {
    platform: 'youtube',
    id: details.videoId ?? input.id,
    kind: 'video',
    title: details.title ?? '',
    description: details.shortDescription || undefined,
    author: {
      name: details.author ?? '',
      id: details.channelId,
    },
    assets: [asset],
    expiresAt: asset.expiresAt,
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}
