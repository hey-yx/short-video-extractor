import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '@/core/errors';
import { hostMatches, PLATFORM_HOSTS } from '@/platforms/hosts';

/**
 * /media 中转：HMAC 签名 + 手动跟 302（每跳 SSRF 校验）+ Range 透传。
 * 参考实现 docs/research/03 §4.3（已实测），按本项目 AppError/envelope 风格重写。
 * 三个实测坑照单全收：HEAD 显式注册、redirect:'manual'、accept-encoding: identity。
 */

/** 签名有效期（秒），PLAN §七：短时效防 token 进日志/Referer 后被刷 */
const SIGN_TTL_SECONDS = 600;
/** 上游重定向跳数上限 */
const MAX_REDIRECTS = 5;
/** 并发上限（PLAN §11.4：服务器带宽 2.7 Mbps，必须限流） */
const MAX_CONCURRENCY = 2;
/** 允许透传给上游的请求头（白名单，绝不整体复制） */
const PASSTHROUGH_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'] as const;
/** 逐跳头 + 由本服务重算的头，不透传回客户端 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-encoding',
]);

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 平台 CDN 域名（PLATFORM_HOSTS 只列分享域，媒体直链在 CDN 上） */
const CDN_HOSTS = [
  'douyinvod.com',
  'douyinpic.com',
  'snssdk.com',
  'zjcdn.com',
  'xhscdn.com',
  'kwimgs.com',
  'chenzhongtech.com',
  'gifshow.com',
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
];

/** SSRF 白名单：已注册平台的分享域 + 对应 CDN 域 */
export function allowedHosts(): string[] {
  return [...Object.values(PLATFORM_HOSTS).flat(), ...CDN_HOSTS];
}

/** 每个域名的上游请求头（research/03 §4.1 实测矩阵） */
const UPSTREAM_HEADERS: Array<{ match: string; referer?: string }> = [
  { match: 'douyinvod.com', referer: 'https://www.douyin.com/' },
  { match: 'douyin.com', referer: 'https://www.douyin.com/' },
  { match: 'douyinpic.com', referer: 'https://www.douyin.com/' },
  { match: 'snssdk.com', referer: 'https://www.douyin.com/' },
  { match: 'zjcdn.com', referer: 'https://www.douyin.com/' },
  { match: 'xhscdn.com', referer: undefined },
  { match: 'xiaohongshu.com', referer: undefined },
  { match: 'bilivideo.com', referer: 'https://www.bilibili.com' },
  { match: 'bilivideo.cn', referer: 'https://www.bilibili.com' },
  { match: 'hdslb.com', referer: 'https://www.bilibili.com' },
  { match: 'kuaishou.com', referer: undefined },
  { match: 'kwimgs.com', referer: undefined },
  { match: 'chenzhongtech.com', referer: undefined },
  { match: 'gifshow.com', referer: undefined },
];

function upstreamHeadersFor(host: string): Record<string, string> {
  const rule = UPSTREAM_HEADERS.find((r) => hostMatches(host, r.match));
  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept: '*/*',
    // 媒体不压缩，否则 Range 字节语义错乱（实测坑 3）
    'accept-encoding': 'identity',
  };
  if (rule?.referer) headers.referer = rule.referer;
  // 无 referer 规则 = 该 CDN 必须不携带（小红书实测：带本站 Referer 403）
  return headers;
}

function secret(): string {
  return process.env.PROXY_SECRET ?? '';
}

/** HMAC 输入是原始 URL 字符串 + exp */
function sign(rawUrl: string, exp: number): string {
  return createHmac('sha256', secret()).update(`${rawUrl}\n${exp}`).digest('hex').slice(0, 32);
}

export function isProxyConfigured(): boolean {
  return secret().length > 0;
}

export interface MediaSignature {
  url: string;
  exp: number;
  sig: string;
}

export function signMediaUrl(url: string, nowSec = Math.floor(Date.now() / 1000)): MediaSignature {
  if (!isProxyConfigured()) {
    throw new AppError('MEDIA_PROXY_DISABLED', 'PROXY_SECRET 未配置，/media 中转未启用');
  }
  const exp = nowSec + SIGN_TTL_SECONDS;
  return { url, exp, sig: sign(url, exp) };
}

export interface VerifiedMedia {
  url: string;
  exp: number;
}

/**
 * 校验签名：未配置 PROXY_SECRET → 501；过期 → 410；篡改 → 403；域名不在白名单 → 403。
 */
export function verifyMediaSignature(
  query: { u?: string; exp?: string; sig?: string },
  nowSec = Math.floor(Date.now() / 1000),
): VerifiedMedia {
  if (!isProxyConfigured()) {
    throw new AppError(
      'MEDIA_PROXY_DISABLED',
      'PROXY_SECRET 未配置，中转端点未启用（这是可选增强，见 PLAN §11.4）',
    );
  }
  const { u, exp, sig } = query;
  if (!u || !exp || !sig) {
    throw new AppError('INVALID_URL', '缺少签名参数（需要 u / exp / sig）');
  }
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    throw new AppError('INVALID_URL', 'exp 不是合法时间戳');
  }
  if (nowSec > expNum) {
    throw new AppError('MEDIA_LINK_EXPIRED', '媒体链接已过期，请重新解析获取新链接', { expiredAt: expNum });
  }
  // HMAC 输入是解码后的原始 URL（不是 base64 串）
  const rawUrl = Buffer.from(u, 'base64url').toString('utf8');
  const expected = sign(rawUrl, expNum);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('MEDIA_BAD_SIGNATURE', '签名校验失败');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('INVALID_URL', 'u 参数不是合法 URL');
  }
  if (url.protocol !== 'https:') {
    throw new AppError('CONTENT_RESTRICTED', '中转只允许 https 链接', {
      protocol: url.protocol,
    });
  }
  if (!allowedHosts().some((d) => hostMatches(url.hostname, d))) {
    throw new AppError('CONTENT_RESTRICTED', '目标域名不在允许列表', {
      host: url.hostname,
    });
  }
  return { url: url.href, exp: expNum };
}

/** SSRF：host 白名单按 `.` 边界 + hostname 解析（research/03 §4.6） */
export function assertSafeHost(rawUrl: string, allowlist: string[]): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AppError('INVALID_URL', '跳转地址不是合法 URL', {
      url: rawUrl.slice(0, 120),
    });
  }
  if (u.protocol !== 'https:') {
    throw new AppError('CONTENT_RESTRICTED', '中转只允许 https 链接', {
      protocol: u.protocol,
    });
  }
  if (!allowlist.some((d) => hostMatches(u.hostname, d))) {
    throw new AppError('CONTENT_RESTRICTED', '跳转域名不在允许列表', {
      host: u.hostname,
    });
  }
  return u;
}

/** 手动跟随 302：每一跳重新做 SSRF 校验 + 重新注入头（实测坑 2） */
export async function fetchUpstream(
  target: string,
  requestHeaders: Headers,
  method: 'GET' | 'HEAD',
  allowlist: string[],
  depth = 0,
): Promise<Response> {
  if (depth > MAX_REDIRECTS) {
    throw new AppError('UPSTREAM_ERROR', '上游重定向超过 5 跳', {
      url: target.slice(0, 120),
    });
  }
  const u = assertSafeHost(target, allowlist);
  const headers = new Headers(upstreamHeadersFor(u.hostname));
  for (const k of PASSTHROUGH_HEADERS) {
    const v = requestHeaders.get(k);
    if (v) headers.set(k, v);
  }

  const res = await fetch(u, { method, headers, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    await res.body?.cancel(); // 302 必须取消 body，防连接泄漏
    if (!loc) return res;
    return fetchUpstream(new URL(loc, u).href, requestHeaders, method, allowlist, depth + 1);
  }
  return res;
}

export function buildMediaResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of upstream) {
    const lk = k.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lk)) continue;
    if (lk === 'content-length') continue; // 由下面统一补
    out.set(k, v);
  }
  const cl = upstream.get('content-length');
  if (cl) out.set('content-length', cl);
  const ct = upstream.get('content-type');
  out.set('content-type', !ct || ct.includes('octet-stream') ? 'video/mp4' : ct);
  out.set('accept-ranges', 'bytes');
  out.set('cache-control', 'public, max-age=3600');
  // 浏览器跨域播放需要；Range 头不脱敏，前端才能算 seek
  out.set('access-control-allow-origin', '*');
  out.set('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges');
  return out;
}

/** 全局并发信号量（PLAN §11.4：中转并发上限 2） */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // 排队等前一个任务让出名额；名额直接转交，不再经过 active 计数
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  get size(): number {
    return this.active;
  }
}

export const mediaConcurrency = new Semaphore(MAX_CONCURRENCY);
