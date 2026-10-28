import { describe, expect, test } from 'bun:test';

import { IpRateLimiter, clientIp } from '@/services/limiter';

/**
 * 令牌桶限流离线用例：take() 的 now 可注入（不 mock Date），
 * sweep 惰性清理（buckets.size > 10000 才触发）用私有桶状态断言。
 */

interface BucketState {
  tokens: number;
  updatedAt: number;
}

const bucketsOf = (l: IpRateLimiter): Map<string, BucketState> =>
  (l as unknown as { buckets: Map<string, BucketState> }).buckets;

describe('IpRateLimiter 令牌桶', () => {
  test('桶容量耗尽后拒绝：容量 3 连过 3 次，第 4 次 false', () => {
    const l = new IpRateLimiter(3, 0);
    expect(l.take('1.1.1.1', 0)).toBe(true);
    expect(l.take('1.1.1.1', 0)).toBe(true);
    expect(l.take('1.1.1.1', 0)).toBe(true);
    expect(l.take('1.1.1.1', 0)).toBe(false);
  });

  test('按时间补给：容量 2、每毫秒 0.002 个，500ms 后回 1 个令牌', () => {
    const l = new IpRateLimiter(2, 0.002);
    expect(l.take('2.2.2.2', 0)).toBe(true);
    expect(l.take('2.2.2.2', 0)).toBe(true);
    expect(l.take('2.2.2.2', 0)).toBe(false);
    // 500ms × 0.002 = 1 个令牌
    expect(l.take('2.2.2.2', 500)).toBe(true);
    expect(l.take('2.2.2.2', 500)).toBe(false);
  });

  test('补给不超过容量上限：长期闲置后一次取用，桶余量 = 容量 - 1', () => {
    const l = new IpRateLimiter(2, 0.002);
    expect(l.take('3.3.3.3', 0)).toBe(true); // 余 1
    expect(l.take('3.3.3.3', 10_000_000)).toBe(true); // 补满 2 再减 1
    expect(bucketsOf(l).get('3.3.3.3')!.tokens).toBeCloseTo(1, 10);
  });

  test('不同 IP 互不影响：A 耗尽不拖累 B', () => {
    const l = new IpRateLimiter(1, 0);
    expect(l.take('4.4.4.4', 0)).toBe(true);
    expect(l.take('4.4.4.4', 0)).toBe(false);
    expect(l.take('5.5.5.5', 0)).toBe(true);
  });
});

describe('IpRateLimiter.sweep 惰性清理（>10000 桶触发）', () => {
  test('sweep 清掉满桶与补给到满的桶，保留刚取过的新桶', () => {
    const l = new IpRateLimiter(2, 0.002);
    // 10000 个桶各余 1 个令牌（不满）
    for (let i = 0; i < 10_000; i++) l.take(`ip-${i}`, 0);
    // 人工塞一个满桶（tokens === capacity，sweep 的直删分支）
    bucketsOf(l).set('full', { tokens: 2, updatedAt: 0 });
    expect(bucketsOf(l).size).toBe(10_001);

    // 第 10001 个 take 使 size > 10000 → sweep(now=1000)：
    // - 'full' 满桶直删；
    // - 10000 个余 1 桶补给 1000ms×0.002=2 → 到满即删；
    // - 'trigger' 新桶刚更新过，保留。
    expect(l.take('trigger', 1000)).toBe(true);

    expect(bucketsOf(l).size).toBe(1);
    expect(bucketsOf(l).has('trigger')).toBe(true);
  });

  test('sweep 保留未补满的桶并刷新 updatedAt', () => {
    const l = new IpRateLimiter(2, 0.002);
    for (let i = 0; i < 10_000; i++) l.take(`ip-${i}`, 0);

    // now=250：余 1 桶只补 0.5 → 1.5 < 2，保留
    expect(l.take('trigger', 250)).toBe(true);

    expect(bucketsOf(l).size).toBe(10_001);
    const kept = bucketsOf(l).get('ip-0')!;
    expect(kept.tokens).toBeCloseTo(1.5, 10);
    expect(kept.updatedAt).toBe(250);
    // 保留的桶不影响后续判定：再补 250ms 刚好满
    expect(bucketsOf(l).get('ip-0')!.tokens).toBeLessThan(2);
  });
});

describe('clientIp 取客户端 IP', () => {
  const req = new Request('http://localhost/parse');

  test('X-Real-IP 优先（1Panel 反代注入）', () => {
    const h = new Headers({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' });
    expect(clientIp(h, req)).toBe('9.9.9.9');
  });

  test('无 X-Real-IP 时 X-Forwarded-For 取第一段（去空格）', () => {
    const h = new Headers({ 'x-forwarded-for': ' 8.8.8.8 , 7.7.7.7' });
    expect(clientIp(h, req)).toBe('8.8.8.8');
  });

  test('都没有时退回 server.requestIP 的 address', () => {
    const server = { requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 1234 }) };
    expect(clientIp(new Headers(), req, server)).toBe('127.0.0.1');
  });

  test('server.requestIP 不可用 → unknown', () => {
    expect(clientIp(new Headers(), req, null)).toBe('unknown');
    expect(clientIp(new Headers(), req)).toBe('unknown');
  });
});

describe('clientIp 转发头可信代理校验（2026-10-28 修复）', () => {
  const req = new Request('http://localhost/parse');
  const peerOf = (address: string) => ({ requestIP: () => ({ address, family: 'IPv4', port: 1234 }) });

  test('公网直连伪造 X-Real-IP：忽略转发头，按连接地址计数（防换桶绕过限流）', () => {
    const h = new Headers({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' });
    expect(clientIp(h, req, peerOf('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(h, req, peerOf('2001:db8::1'))).toBe('2001:db8::1');
  });

  test('同机反代（127.0.0.1）注入 X-Real-IP：采信', () => {
    const h = new Headers({ 'x-real-ip': '9.9.9.9' });
    expect(clientIp(h, req, peerOf('127.0.0.1'))).toBe('9.9.9.9');
    expect(clientIp(h, req, peerOf('::ffff:127.0.0.1'))).toBe('9.9.9.9');
    expect(clientIp(h, req, peerOf('::1'))).toBe('9.9.9.9');
  });

  test('内网反代（docker 网桥 / LAN）注入转发头：采信', () => {
    const real = new Headers({ 'x-real-ip': '9.9.9.9' });
    expect(clientIp(real, req, peerOf('172.18.0.5'))).toBe('9.9.9.9');
    expect(clientIp(real, req, peerOf('10.11.11.11'))).toBe('9.9.9.9');
    expect(clientIp(real, req, peerOf('192.168.1.2'))).toBe('9.9.9.9');
    const xff = new Headers({ 'x-forwarded-for': '8.8.8.8 , 7.7.7.7' });
    expect(clientIp(xff, req, peerOf('172.31.255.254'))).toBe('8.8.8.8');
  });

  test('公网对端无转发头：按连接地址计数（与旧行为一致）', () => {
    expect(clientIp(new Headers(), req, peerOf('203.0.113.7'))).toBe('203.0.113.7');
  });
});
