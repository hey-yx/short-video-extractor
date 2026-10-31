import { describe, expect, test } from 'bun:test';

import { signIpBoundLinks, verifyMediaSignature } from '@/services/media-proxy';
import type { ParseResult } from '@/types/platform';

/** /parse 响应改写：绑 IP 直链 → 签名 /media 链接（接线回归） */

const NOW = 1_700_000_000;
const ORIGIN = 'https://allparse.example.com';

function ytResult(): ParseResult {
  return {
    platform: 'youtube',
    id: 'dQw4w9WgXcQ',
    kind: 'video',
    title: 'Test Video',
    author: { name: 'u' },
    assets: [
      {
        type: 'video',
        url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?a=1',
        audioUrl: 'https://rr3---sn-abc.googlevideo.com/videoplayback?a=2',
        coverUrl: 'https://i.ytimg.com/vi/x/hq.jpg',
        variants: [{ ratio: '720p', url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?a=3' }],
      },
    ],
    parsedAt: NOW,
    via: 'http',
  };
}

function douyinResult(): ParseResult {
  return {
    platform: 'douyin',
    id: '7000',
    kind: 'video',
    title: '抖音视频',
    author: { name: 'u' },
    assets: [{ type: 'video', url: 'https://v3-web.douyinvod.com/abc.mp4' }],
    parsedAt: NOW,
    via: 'http',
  };
}

describe('signIpBoundLinks（/parse 响应改写接线）', () => {
  test('未配 PROXY_SECRET：原样返回同一对象（直链主路径）', () => {
    delete process.env.PROXY_SECRET;
    const r = ytResult();
    expect(signIpBoundLinks(r, ORIGIN, NOW)).toBe(r);
  });

  test('配 PROXY_SECRET + googlevideo：url/audioUrl/variants 全改写为签名 /media 链接', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const out = signIpBoundLinks(ytResult(), ORIGIN, NOW);
      const a = out.assets[0]!;
      for (const u of [a.url, a.audioUrl!, a.variants![0]!.url]) {
        expect(u).toStartWith(`${ORIGIN}/media?`);
        const q = new URL(u).searchParams;
        const verified = verifyMediaSignature(
          { u: q.get('u')!, exp: q.get('exp')!, sig: q.get('sig')! },
          NOW + 1,
        );
        expect(verified.exp).toBe(NOW + 600);
      }
      // 签名可还原出原始直链
      const q = new URL(a.url).searchParams;
      expect(Buffer.from(q.get('u')!, 'base64url').toString('utf8')).toBe(
        'https://rr3---sn-abc.googlevideo.com/videoplayback?a=1',
      );
      // title 进 query（强制下载文件名）
      expect(q.get('title')).toBe('Test Video');
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });

  test('coverUrl（ytimg 不绑 IP）与非绑 IP 平台保持直链', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const out = signIpBoundLinks(ytResult(), ORIGIN, NOW);
      expect(out.assets[0]!.coverUrl).toBe('https://i.ytimg.com/vi/x/hq.jpg');
      const d = signIpBoundLinks(douyinResult(), ORIGIN, NOW);
      expect(d.assets[0]!.url).toBe('https://v3-web.douyinvod.com/abc.mp4');
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });

  test('缓存安全：原对象不被改写（deep 冻结后调用不抛）', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const r = ytResult();
      const before = JSON.stringify(r);
      signIpBoundLinks(r, ORIGIN, NOW);
      expect(JSON.stringify(r)).toBe(before);
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });

  test('expiresAt 落到签名 exp（600s）；多资产 title 带序号', () => {
    process.env.PROXY_SECRET = 'test-secret';
    try {
      const r = ytResult();
      r.assets.push({ type: 'audio', url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?a=4' });
      const out = signIpBoundLinks(r, ORIGIN, NOW);
      expect(out.expiresAt).toBe(NOW + 600);
      expect(out.assets[0]!.expiresAt).toBe(NOW + 600);
      const q1 = new URL(out.assets[0]!.url).searchParams;
      const q2 = new URL(out.assets[1]!.url).searchParams;
      expect(q1.get('title')).toBe('Test Video-1');
      expect(q2.get('title')).toBe('Test Video-2');
    } finally {
      delete process.env.PROXY_SECRET;
    }
  });
});
