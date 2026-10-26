import { describe, expect, test } from 'bun:test';
import { allowedHosts, signMediaUrl, verifyMediaSignature } from '@/services/media-proxy';

const NOW = 1_700_000_000;

describe('media-proxy IG CDN 白名单', () => {
  test('fbcdn.net / cdninstagram.com 在允许列表（后缀匹配覆盖 *.fna.fbcdn.net）', () => {
    const hosts = allowedHosts();
    expect(hosts).toContain('fbcdn.net');
    expect(hosts).toContain('cdninstagram.com');
  });

  test('IG 直链签名中转可校验通过', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const url = 'https://instagram.fhkg4-2.fna.fbcdn.net/o1/v/fake/FAKE.mp4?oe=6AF3C2C1';
      const { url: signed, exp, sig } = signMediaUrl(url, NOW);
      const verified = verifyMediaSignature(
        { u: Buffer.from(signed).toString('base64url'), exp: String(exp), sig },
        NOW + 1,
      );
      expect(verified.url).toBe(url);
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });

  test('IG 直链外的陌生域仍被拒', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const url = 'https://evil.example.com/video.mp4';
      const { url: signed, exp, sig } = signMediaUrl(url, NOW);
      expect(() =>
        verifyMediaSignature(
          { u: Buffer.from(signed).toString('base64url'), exp: String(exp), sig },
          NOW + 1,
        ),
      ).toThrow('目标域名不在允许列表');
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });
});
