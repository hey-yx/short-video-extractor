/**
 * 令牌桶限流：按客户端 IP，30 req/min/IP，超限 RATE_LIMITED(429)。
 * 反代（nginx 等）后 remote 是 127.0.0.1，客户端 IP 从 X-Real-IP 取。
 */

const CAPACITY = 30;
const REFILL_PER_MS = CAPACITY / 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class IpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity = CAPACITY,
    private readonly refillPerMs = REFILL_PER_MS,
  ) {}

  /** 取一个令牌；false = 超限 */
  take(ip: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(ip) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      this.buckets.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(ip, bucket);

    // 空桶数量控制：只在不影响本次判定时惰性清理
    if (this.buckets.size > 10_000) {
      this.sweep(now);
    }
    return true;
  }

  private sweep(now: number): void {
    for (const [ip, b] of this.buckets) {
      if (b.tokens >= this.capacity) {
        this.buckets.delete(ip);
      } else {
        b.tokens = Math.min(this.capacity, b.tokens + (now - b.updatedAt) * this.refillPerMs);
        b.updatedAt = now;
        if (b.tokens >= this.capacity) this.buckets.delete(ip);
      }
    }
  }
}

export const ipRateLimiter = new IpRateLimiter();

/**
 * 可信代理：同机回环 / 内网地址（1Panel nginx、docker 网桥都落在这里）。
 * 只有直连对端是可信代理时才采信转发头，否则公网客户端伪造 X-Real-IP / X-Forwarded-For
 * 就能给自己换新桶绕过限流。
 */
function isTrustedProxy(addr: string): boolean {
  // IPv4-mapped IPv6（::ffff:127.0.0.1）归一到 IPv4 再判
  const ip = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m && +m[1]! >= 16 && +m[1]! <= 31) return true;
  // IPv6 ULA（fc00::/7）与链路本地（fe80::/10）
  return /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip);
}

/** X-Real-IP（反代注入）优先，其次 X-Forwarded-For 第一跳。转发头只在直连对端是可信代理时采信；
 * 对端地址拿不到（unix socket / 无 server）时按旧口径信头。 */
export function clientIp(
  headers: Headers,
  request: Request,
  server?: { requestIP(request: Request): unknown } | null,
): string {
  const info = server?.requestIP(request);
  const peer = info && typeof info === 'object' && 'address' in info ? String(info.address) : undefined;
  if (peer === undefined || isTrustedProxy(peer)) {
    const real = headers.get('x-real-ip');
    if (real) return real;
    const xff = headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
  }
  return peer ?? 'unknown';
}
