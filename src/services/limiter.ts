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

/** X-Real-IP（1Panel 反代注入）优先，缺省退回 Bun server 的 remoteAddress */
export function clientIp(
  headers: Headers,
  request: Request,
  server?: { requestIP(request: Request): unknown } | null,
): string {
  const real = headers.get('x-real-ip');
  if (real) return real;
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const info = server?.requestIP(request);
  if (info && typeof info === 'object' && 'address' in info) {
    return String(info.address);
  }
  return 'unknown';
}
