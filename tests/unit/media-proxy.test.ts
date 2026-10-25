import { describe, expect, test } from 'bun:test';

import { AppError } from '@/core/errors';
import {
  assertSafeHost,
  fetchUpstream,
  isProxyConfigured,
  mediaConcurrency,
  signMediaUrl,
  verifyMediaSignature,
} from '@/services/media-proxy';
import { IpRateLimiter } from '@/services/limiter';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

describe('签名', () => {
  test('未配置 PROXY_SECRET：signMediaUrl 抛错，verify 走 501 路径', () => {
    delete process.env.PROXY_SECRET;
    expect(isProxyConfigured()).toBe(false);
    expect(() => signMediaUrl('https://www.douyin.com/aweme/v1/play/?video_id=x')).toThrow(/PROXY_SECRET/);
    try {
      verifyMediaSignature({ u: b64url('https://www.douyin.com/x'), exp: '9999999999', sig: 'a'.repeat(32) });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('MEDIA_PROXY_DISABLED');
      expect((e as AppError).httpStatus).toBe(501);
    }
  });

  test('配置后签名可验证', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'https://www.douyin.com/aweme/v1/play/?video_id=abc&ratio=1080p';
    const { url, exp, sig } = signMediaUrl(target);
    expect(url).toBe(target);
    const verified = verifyMediaSignature({ u: b64url(url), exp: String(exp), sig });
    expect(verified.url).toBe(target);
  });

  test('篡改 sig → 403 MEDIA_BAD_SIGNATURE', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'https://www.douyin.com/aweme/v1/play/?video_id=abc';
    const { url, exp, sig } = signMediaUrl(target);
    const bad = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    try {
      verifyMediaSignature({ u: b64url(url), exp: String(exp), sig: bad });
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe('MEDIA_BAD_SIGNATURE');
      expect(err.httpStatus).toBe(403);
    }
  });

  test('篡改 URL（用另一条链接的签名）→ 403', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const signed = signMediaUrl('https://www.douyin.com/aweme/v1/play/?video_id=aaa');
    const forged = 'https://www.douyin.com/aweme/v1/play/?video_id=bbb';
    try {
      verifyMediaSignature({ u: b64url(forged), exp: String(signed.exp), sig: signed.sig });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('MEDIA_BAD_SIGNATURE');
    }
  });

  test('过期签名 → 410 MEDIA_LINK_EXPIRED', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'https://www.douyin.com/aweme/v1/play/?video_id=abc';
    const { url, exp, sig } = signMediaUrl(target, Math.floor(Date.now() / 1000) - 700);
    try {
      verifyMediaSignature({ u: b64url(url), exp: String(exp), sig });
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe('MEDIA_LINK_EXPIRED');
      expect(err.httpStatus).toBe(410);
    }
  });

  test('非平台域名（SSRF 内网目标）→ 403', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'https://127.0.0.1/secret';
    const { url, exp, sig } = signMediaUrl(target);
    try {
      verifyMediaSignature({ u: b64url(url), exp: String(exp), sig });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_RESTRICTED');
    }
  });

  test('evil-douyin.com 后缀不匹配，过不了白名单', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'https://evil-douyin.com/x.mp4';
    const { url, exp, sig } = signMediaUrl(target);
    expect(() => verifyMediaSignature({ u: b64url(url), exp: String(exp), sig })).toThrow(/允许列表/);
  });

  test('http 链接拒绝（只允许 https）', () => {
    process.env.PROXY_SECRET = 'test-secret';
    const target = 'http://www.douyin.com/x.mp4';
    const { url, exp, sig } = signMediaUrl(target);
    expect(() => verifyMediaSignature({ u: b64url(url), exp: String(exp), sig })).toThrow(/https/);
  });
});

describe('手动跟 302', () => {
  test('302 跳到白名单外域名 → SSRF 拦截（每跳重校验）', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      });
    }) as unknown as typeof fetch;
    try {
      await fetchUpstream('https://www.douyin.com/aweme/v1/play/?video_id=x', new Headers(), 'GET', [
        'douyin.com',
      ]);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_RESTRICTED');
      expect((e as AppError).detail?.host).toBe('169.254.169.254');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
  });

  test('302 跳白名单内域名 → 跟随并返回终响应', async () => {
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://v26-web.douyinvod.com/final.mp4' },
        });
      }
      return new Response('body', {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      });
    }) as unknown as typeof fetch;
    try {
      const res = await fetchUpstream(
        'https://www.douyin.com/aweme/v1/play/?video_id=x',
        new Headers(),
        'GET',
        ['douyin.com', 'douyinvod.com'],
      );
      expect(res.status).toBe(200);
      expect(n).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('白名单按 `.` 边界匹配', () => {
    expect(() => assertSafeHost('https://evil-douyin.com/x', ['douyin.com'])).toThrow(/允许列表/);
    expect(assertSafeHost('https://www.douyin.com/x', ['douyin.com']).hostname).toBe('www.douyin.com');
  });
});

describe('并发信号量', () => {
  test('上限 2：第三个请求等前两个完成才跑', async () => {
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    };
    await Promise.all([mediaConcurrency.run(task), mediaConcurrency.run(task), mediaConcurrency.run(task)]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('限流', () => {
  test('令牌桶 30 req/min/IP：第 31 次被拒', () => {
    const limiter = new IpRateLimiter(30, 30 / 60_000);
    const now = Date.now();
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.take('1.2.3.4', now)).toBe(true);
    }
    expect(limiter.take('1.2.3.4', now + 1)).toBe(false);
  });

  test('时间推进按速率回填令牌', () => {
    const limiter = new IpRateLimiter(30, 30 / 60_000);
    const now = Date.now();
    for (let i = 0; i < 30; i += 1) limiter.take('5.6.7.8', now);
    expect(limiter.take('5.6.7.8', now + 1000)).toBe(false);
    // 30/min = 0.5/s，2 秒回填 1 个令牌
    expect(limiter.take('5.6.7.8', now + 2000)).toBe(true);
  });

  test('不同 IP 独立配额', () => {
    const limiter = new IpRateLimiter(1, 1 / 60_000);
    const now = Date.now();
    expect(limiter.take('1.1.1.1', now)).toBe(true);
    expect(limiter.take('1.1.1.1', now)).toBe(false);
    expect(limiter.take('2.2.2.2', now)).toBe(true);
  });

  test('X-Real-IP 优先于 remote', async () => {
    const { clientIp } = await import('@/services/limiter');
    const headers = new Headers({ 'x-real-ip': '203.0.113.9' });
    const request = new Request('https://svc/parse');
    expect(clientIp(headers, request, null)).toBe('203.0.113.9');
    const noProxy = clientIp(new Headers(), request, {
      requestIP: () => ({ address: '127.0.0.1', port: 12345 }),
    });
    expect(noProxy).toBe('127.0.0.1');
  });
});
