import { describe, expect, test } from 'bun:test';
import { xhsAdapter } from '@/platforms/xhs/adapter';

const u = (s: string) => new URL(s);

describe('xhs match（纯函数）', () => {
  test('explore 长链 + xsec_token：id 与 token 原样保留', () => {
    const m = xhsAdapter.match(
      u(
        'https://www.xiaohongshu.com/explore/6aa0343c00000000270173b7?xsec_token=ABqZchtGxxx&xsec_source=pc_feed',
      ),
    );
    expect(m?.platform).toBe('xhs');
    expect(m?.id).toBe('6aa0343c00000000270173b7');
    expect(m?.needsResolve).toBe(false);
    expect(m?.params?.xsec_token).toBe('ABqZchtGxxx');
  });

  test('discovery/item 长链', () => {
    const m = xhsAdapter.match(
      u('https://www.xiaohongshu.com/discovery/item/6ac016680000000002029db8?xsec_token=tX'),
    );
    expect(m?.id).toBe('6ac016680000000002029db8');
  });

  test('无 token 的裸 explore 链接也匹配（fetch 层拿到的页面无数据时分类报错）', () => {
    const m = xhsAdapter.match(u('https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9'));
    expect(m?.id).toBe('6411cf99000000001300b6d9');
    expect(m?.params).toBeUndefined();
  });

  test('短链 xhslink.com → needsResolve', () => {
    const m = xhsAdapter.match(u('https://xhslink.com/a/abc123'));
    expect(m?.needsResolve).toBe(true);
  });

  test('24 位十六进制之外不匹配', () => {
    expect(xhsAdapter.match(u('https://www.xiaohongshu.com/explore/notanoteid'))).toBeNull();
    expect(xhsAdapter.match(u('https://www.xiaohongshu.com/user/profile/59ed510b4e'))).toBeNull();
  });

  test('capabilities：浏览器通道 + TLS 指纹', () => {
    expect(xhsAdapter.capabilities.http).toBe(false);
    expect(xhsAdapter.capabilities.browser).toBe(true);
    expect(xhsAdapter.capabilities.tlsImpersonation).toBe(true);
  });
});

describe('registry 注册', () => {
  test('GET /platforms 显示 xhs', async () => {
    const { createApp } = await import('@/bootstrap/app');
    const app = createApp();
    const res = await app.handle(new Request('http://localhost/platforms'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as
      Array<{ platform: string }> | { success: boolean; data: Array<{ platform: string }> };
    // /platforms 响应形状随并行改版变过（裸数组 → 信封），两种都兼容
    const rows = Array.isArray(body) ? body : body.data;
    const platforms = rows.map((p) => p.platform);
    expect(platforms).toContain('xhs');
    expect(platforms).toContain('douyin');
  });
});
