import { describe, expect, test } from 'bun:test';
import { allowedHosts, signMediaUrl, verifyMediaSignature } from '@/services/media-proxy';

describe('media-proxy twimg 白名单（X 平台接入）', () => {
  test('CDN 白名单含 twimg.com（后缀匹配覆盖 pbs./video. 子域）', () => {
    expect(allowedHosts()).toContain('twimg.com');
  });

  test('pbs.twimg.com / video.twimg.com 直链可通过签名校验', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      for (const url of [
        'https://video.twimg.com/amplify_video/123/vid/avc1/1920x1080/abc.mp4',
        'https://pbs.twimg.com/media/ABC123.jpg?name=orig',
        'https://pbs.twimg.com/tweet_video_thumb/XYZ.jpg',
      ]) {
        const sig = signMediaUrl(url, 1_000);
        const v = verifyMediaSignature(
          { u: Buffer.from(url).toString('base64url'), exp: String(sig.exp), sig: sig.sig },
          1,
        );
        expect(v.url).toBe(url);
      }
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });

  test('twimg 之外的域仍被拒（SSRF 白名单不放大）', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const url = 'https://evil.example.com/amplify_video/123/vid/a.mp4';
      const sig = signMediaUrl(url, 1_000);
      expect(() =>
        verifyMediaSignature(
          { u: Buffer.from(url).toString('base64url'), exp: String(sig.exp), sig: sig.sig },
          1,
        ),
      ).toThrow();
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });
});
