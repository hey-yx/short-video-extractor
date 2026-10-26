import { AppError } from '@/core/errors';
import type { AssetVariant, MediaAsset, ParseResult, RawPayload } from '@/types/platform';

/**
 * 微博 statuses/show（m 站）+ tv/api/component 复合载荷解析（纯函数）。
 * 两通道字段形态实测（2026-10-26）：
 *  - show.urls 英文键（mp4_720p_mp4 / mp4_hd_mp4 / mp4_ld_mp4）+ stream_url(_hd)
 *  - component.urls 中文键（高清 1080P / 高清 720P / 标清 480P），档位比 show 更全
 *  - 图集在 show.pics[]（large.url 为 mw2000 全尺寸），weibo.com 侧的 pic_infos 对应同构
 */

export interface WeiboShowPayload {
  ok: number;
  errno?: string;
  msg?: string;
  data?: WeiboStatus;
}

export interface WeiboComponentPayload {
  code: string;
  data?: { Component_Play_Playinfo?: WeiboPlayInfo };
}

export interface WeiboPayload {
  show: WeiboShowPayload;
  component?: WeiboComponentPayload;
}

interface WeiboStatus {
  id?: string | number;
  mid?: string | number;
  bid?: string;
  text?: string;
  user?: { id?: number; screen_name?: string; avatar_hd?: string };
  page_info?: {
    type?: string;
    title?: string;
    page_title?: string;
    page_pic?: { url?: string };
    video_orientation?: string;
    media_info?: {
      duration?: number;
      stream_url?: string;
      stream_url_hd?: string;
    };
    urls?: Record<string, string>;
  };
  pics?: Array<{
    pid?: string;
    url?: string;
    large?: { url?: string; geo?: { width?: string | number; height?: string | number } };
  }>;
  pic_infos?: Record<
    string,
    { large?: { url?: string; geo?: { width?: string | number; height?: string | number } } }
  >;
}

interface WeiboPlayInfo {
  mid?: number | string;
  duration_time?: number;
  cover_image?: string;
  stream_url?: string;
  urls?: Record<string, string>;
  topics?: Array<{ content?: string }>;
}

interface WeiboStream {
  url: string;
  ratio: string;
  width?: number;
  height?: number;
}

/** 定宽尺寸从 URL template=720x1280.24.0 参数读出 */
function templateDims(url: string): { width?: number; height?: number } {
  const m = url.match(/[?&]template=(\d+)x(\d+)/);
  return { width: m?.[1] ? Number(m[1]) : undefined, height: m?.[2] ? Number(m[2]) : undefined };
}

/** 直链时效：URL 的 Expires= 参数是过期 Unix 秒（10 位） */
function urlExpiry(url: string): number | undefined {
  const m = url.match(/[?&](?:Expires|expires)=(\d{9,11})(?:[&#]|$)/);
  const ts = m?.[1] ? Number(m[1]) : undefined;
  return ts !== undefined && ts > 1e9 && ts < 1e11 ? ts : undefined;
}

/** protocol-relative（//host/...）补 https: */
function absUrl(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u;
}

/** show.urls 英文键 → 档名（mp4_720p_mp4 → 720p；mp4_hd_mp4 → hd） */
function showRatio(key: string): string {
  const k = key.replace(/^mp4_/, '').replace(/_mp4$/, '');
  return k === 'hd' ? 'hd' : k === 'ld' ? 'ld' : k;
}

/** component.urls 中文键 → 档名（高清 1080P → 1080P） */
function componentRatio(key: string): string {
  const m = key.match(/(\d+)\s*[Pp]/);
  return m?.[1] ? `${m[1]}P` : key.trim();
}

function streamFromUrl(url: string, ratio: string): WeiboStream {
  const { width, height } = templateDims(url);
  return { url: absUrl(url), ratio, width, height };
}

/** 所有可用视频档位：component.urls（中文键）优先，其次 show.urls（英文键），最后 stream_url(_hd) */
function collectStreams(status: WeiboStatus, play?: WeiboPlayInfo): WeiboStream[] {
  const streams: WeiboStream[] = [];
  const seen = new Set<string>();
  const push = (url: string, ratio: string) => {
    const abs = absUrl(url);
    if (!abs.startsWith('http') || seen.has(abs)) return;
    seen.add(abs);
    streams.push(streamFromUrl(abs, ratio));
  };
  for (const [key, url] of Object.entries(play?.urls ?? {})) {
    if (url) push(url, componentRatio(key));
  }
  for (const [key, url] of Object.entries(status.page_info?.urls ?? {})) {
    if (url) push(url, showRatio(key));
  }
  const mi = status.page_info?.media_info;
  if (mi?.stream_url_hd) push(mi.stream_url_hd, 'hd');
  if (mi?.stream_url) push(mi.stream_url, 'sd');
  return streams;
}

/** 像素面积排序（竖屏 1080x1920 > 720x1280 > 540x960） */
function area(s: WeiboStream): number {
  return (s.width ?? 0) * (s.height ?? 0);
}

/** HTML 正文清洗：<br> 转行，去标签，解码常见实体 */
function cleanText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/** 微博话题：component.topics / 正文里的超话链接（href 含 extparam=/huati.weibo）/ #话题# 文本 */
function extractTags(text: string, play?: WeiboPlayInfo): string[] {
  const tags = new Set<string>();
  for (const t of play?.topics ?? []) {
    if (t.content) tags.add(t.content.replace(/\[超话\]$/, '').trim());
  }
  for (const m of text.matchAll(
    /<a[^>]*href="[^"]*(?:extparam=|huati\.weibo)[^"]*"[^>]*>[\s\S]*?<span[^>]*class="surl-text"[^>]*>([^<]+)<\/span>/g,
  )) {
    const tag = m[1]?.trim().replace(/\[超话\]$/, '');
    if (tag) tags.add(tag);
  }
  for (const m of text.matchAll(/#([^#\n]{1,40})#/g)) {
    const tag = m[1]?.replace(/\[超话\]$/, '').trim();
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/** 微博业务错误信封（ok:0）→ core/errors 分类：不存在/删除=CONTENT_NOT_FOUND、需登录/权限=CONTENT_RESTRICTED、风控=RISK_CONTROL */
function classifyEnvelope(show: WeiboShowPayload): AppError {
  const msg = show.msg ?? '';
  const detail = { errno: show.errno, msg: show.msg };
  if (show.errno === '20101' || /不存在|已删除/.test(msg)) {
    return new AppError('CONTENT_NOT_FOUND', `微博内容不存在（${msg}）`, detail);
  }
  if (/可见|权限|隐私|关注|登录|受限|仅粉丝|仅自己/.test(msg)) {
    return new AppError('CONTENT_RESTRICTED', `微博内容不可见（${msg}）`, detail);
  }
  if (/频繁|拥挤|稍后|风控/.test(msg)) {
    return new AppError('RISK_CONTROL', `微博风控拦截（${msg}）`, detail);
  }
  return new AppError('UPSTREAM_ERROR', `微博接口错误（${msg}）`, detail);
}

export function parseWeibo(raw: RawPayload): ParseResult {
  if (raw.via !== 'api') {
    throw new AppError('UPSTREAM_CHANGED', `微博解析收到未知载荷类型: ${raw.via}`);
  }
  const payload = raw.body as WeiboPayload;
  const show = payload?.show;
  if (!show || typeof show !== 'object') {
    throw new AppError('UPSTREAM_CHANGED', '微博载荷缺少 show 响应');
  }
  if (show.ok !== 1 || !show.data) {
    throw classifyEnvelope(show);
  }
  const status = show.data;
  const play = payload.component?.data?.Component_Play_Playinfo;
  const mi = status.page_info?.media_info;

  const assets: MediaAsset[] = [];
  const streams = collectStreams(status, play);
  if (streams.length > 0) {
    const sorted = [...streams].sort((a, b) => area(b) - area(a));
    const best = sorted[0]!;
    const variants: AssetVariant[] = sorted.slice(1).map((s) => ({
      ratio: s.ratio,
      url: s.url,
      width: s.width,
      height: s.height,
      watermark: false,
    }));
    const durationSec = mi?.duration ?? play?.duration_time;
    const asset: MediaAsset = {
      type: 'video',
      url: best.url,
      width: best.width,
      height: best.height,
      durationMs: durationSec ? Math.round(durationSec * 1000) : undefined,
      coverUrl: absUrl(status.page_info?.page_pic?.url ?? play?.cover_image ?? ''),
      variants,
    };
    const expiry = urlExpiry(asset.url);
    if (expiry) asset.expiresAt = expiry;
    assets.push(asset);
  }

  // 图集（m 站 pics[]，weibo.com 的 pic_infos 同构）：两字段都读，去重
  const pics = status.pics ?? [];
  const picInfos = Object.values(status.pic_infos ?? {});
  const imageSources = [
    ...pics.map((p) => ({ url: p.large?.url ?? p.url, geo: p.large?.geo })),
    ...picInfos.map((p) => ({ url: p.large?.url, geo: p.large?.geo })),
  ];
  for (const pic of imageSources) {
    if (!pic.url) continue;
    assets.push({
      type: 'image',
      url: absUrl(pic.url),
      width: pic.geo?.width !== undefined ? Number(pic.geo.width) : undefined,
      height: pic.geo?.height !== undefined ? Number(pic.geo.height) : undefined,
    });
  }

  if (assets.length === 0) {
    throw new AppError('CONTENT_NOT_FOUND', '微博内容不含可下载的媒体');
  }

  const text = cleanText(status.text ?? '');
  const title = text.split('\n')[0]?.trim() || status.page_info?.page_title || '微博';
  const expiries = assets.map((a) => a.expiresAt).filter((t): t is number => t !== undefined);

  return {
    platform: 'weibo',
    id: String(status.id ?? status.mid ?? ''),
    kind: streams.length > 0 ? 'video' : 'album',
    title,
    description: text || undefined,
    tags: extractTags(status.text ?? '', play),
    author: {
      name: status.user?.screen_name ?? '',
      id: status.user?.id !== undefined ? String(status.user.id) : undefined,
      avatar: status.user?.avatar_hd,
    },
    assets,
    expiresAt: expiries.length > 0 ? Math.min(...expiries) : undefined,
    parsedAt: raw.fetchedAt,
    via: 'http',
  } satisfies ParseResult;
}
