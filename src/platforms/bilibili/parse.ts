import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/**
 * B 站 view + playurl 复合载荷解析（纯函数）。
 * 真实响应里流字段 snake/camel 双写（base_url 与 baseUrl 同时存在，2026-10-25 实测），
 * 但只有一侧有值，所以两个都读。
 */

interface BiliStream {
  id?: number;
  base_url?: string;
  baseUrl?: string;
  backup_url?: string[];
  backupUrl?: string[];
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  mimeType?: string;
}

interface BiliViewData {
  bvid?: string;
  aid?: number;
  cid?: number;
  videos?: number;
  title?: string;
  desc?: string;
  pic?: string;
  duration?: number;
  owner?: { mid?: number; name?: string; face?: string };
  pages?: Array<{
    cid?: number;
    page?: number;
    part?: string;
    duration?: number;
    dimension?: { width?: number; height?: number };
  }>;
  dimension?: { width?: number; height?: number };
}

/** fetch() 产出的复合载荷（fixture 可录制回放） */
interface BilibiliPayload {
  view: { code: number; message?: string; data: unknown };
  streams: Array<{
    page: number;
    cid: number | string;
    part?: string;
    videos: unknown[];
    audios: unknown[];
  }>;
}

function streamUrl(s: BiliStream): string {
  return s.base_url ?? s.baseUrl ?? '';
}

function streamBackups(s: BiliStream): string[] {
  const list = s.backup_url ?? s.backupUrl ?? [];
  return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
}

/** 清晰度档名：DASH id 120=4K, 116=1080P60, 112=1080P+, 80=1080P, 74=720P60, 64=720P, 32/16=480/360P */
function qualityName(id: number | undefined, w?: number, h?: number): string {
  const names: Record<number, string> = {
    127: '8K',
    126: '杜比视界',
    125: 'HDR',
    120: '4K',
    116: '1080P60',
    112: '1080P+',
    100: '智能修复',
    80: '1080P',
    74: '720P60',
    64: '720P',
    32: '480P',
    16: '360P',
  };
  if (id !== undefined && names[id]) return names[id]!;
  if (w && h) return `${h}p`;
  return `id${id ?? '?'}`;
}

function sortStreams(streams: BiliStream[]): BiliStream[] {
  return [...streams].sort((a, b) => {
    const hd = (b.height ?? 0) - (a.height ?? 0);
    if (hd !== 0) return hd;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

/** 直链时效：upos URL 的 deadline= 参数是过期 Unix 秒（10 位），读不出返回 undefined */
function urlExpiry(url: string): number | undefined {
  const m = url.match(/[?&](?:deadline|expires)=(\d{9,11})(?:[&#]|$)/);
  const ts = m?.[1] ? Number(m[1]) : undefined;
  return ts !== undefined && ts > 1e9 && ts < 1e11 ? ts : undefined;
}

export function parseBilibili(raw: RawPayload): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `B站解析收到未知载荷类型: ${raw.via}`);
  }
  const payload = raw.body as BilibiliPayload;
  if (!payload || !Array.isArray(payload.streams) || payload.streams.length === 0) {
    throw new AppError('UPSTREAM_CHANGED', 'B站载荷缺少 streams');
  }

  const viewData = (payload.view.data ?? {}) as BiliViewData;
  const pages = viewData.pages ?? [];
  const isMulti = (viewData.videos ?? pages.length) > 1;

  // 每个分 P 一个 asset；DASH 音视频分离，audio 直链注在 asset.audioUrl
  const assets: MediaAsset[] = payload.streams.map((stream, idx) => {
    const videos = sortStreams((stream.videos ?? []) as BiliStream[]);
    const audios = (stream.audios ?? []) as BiliStream[];
    const best = videos[0];
    if (!best || !streamUrl(best)) {
      throw new AppError('UPSTREAM_CHANGED', `B站 P${stream.page} 无可用视频流`);
    }
    // 音轨按码率取最高（bandwidth ≈ 音质）
    const bestAudio = [...audios].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];

    // 其余档进 variants：一档一位（同档位多编码 hevc/avc/av1 取 bandwidth 最高），
    // 主 URL 所在档位不再重复列出
    const byTier = new Map<number, BiliStream>();
    for (const s of videos) {
      if (s.id === best.id) continue;
      const key = s.id ?? -1;
      const cur = byTier.get(key);
      if (!cur || (s.bandwidth ?? 0) > (cur.bandwidth ?? 0)) byTier.set(key, s);
    }
    const variants: AssetVariant[] = [...byTier.values()].map((s) => ({
      ratio: qualityName(s.id, s.width, s.height),
      url: streamUrl(s),
      width: s.width,
      height: s.height,
      watermark: false,
    }));

    const pageInfo = pages.find((p) => p.page === stream.page) ?? pages[idx];
    const dim = pageInfo?.dimension ?? viewData.dimension;
    const part = stream.part ?? pageInfo?.part;

    const asset: MediaAsset = {
      type: 'video',
      url: streamUrl(best),
      width: best.width ?? dim?.width,
      height: best.height ?? dim?.height,
      durationMs: pageInfo?.duration
        ? pageInfo.duration * 1000
        : viewData.duration
          ? viewData.duration * 1000
          : undefined,
      backups: streamBackups(best),
      coverUrl: viewData.pic,
      variants,
    };
    const expiries = [urlExpiry(asset.url), bestAudio ? urlExpiry(streamUrl(bestAudio)) : undefined].filter(
      (t): t is number => t !== undefined,
    );
    if (expiries.length > 0) asset.expiresAt = Math.min(...expiries);
    if (bestAudio && streamUrl(bestAudio)) {
      asset.audioUrl = streamUrl(bestAudio);
    }
    if (isMulti && part) {
      asset.partTitle = part;
    }
    return asset;
  });

  return {
    platform: 'bilibili',
    id: viewData.bvid ?? '',
    kind: 'video',
    title:
      isMulti && viewData.title
        ? `${viewData.title}（共 ${payload.streams.length}P）`
        : (viewData.title ?? ''),
    description: viewData.desc,
    author: {
      name: viewData.owner?.name ?? '',
      id: viewData.owner?.mid !== undefined ? String(viewData.owner.mid) : undefined,
      avatar: viewData.owner?.face,
    },
    assets,
    expiresAt: minExpiry(assets),
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}

/** 所有 asset 里最早过期的时刻；全读不出则省略 */
function minExpiry(assets: MediaAsset[]): number | undefined {
  const list = assets.map((a) => a.expiresAt).filter((t): t is number => t !== undefined);
  return list.length > 0 ? Math.min(...list) : undefined;
}
