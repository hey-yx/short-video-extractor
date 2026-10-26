import { describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { listAdapters } from '@/platforms/registry';

const app = createApp();

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe('ops 路由（/health /ready /platforms /metrics）', () => {
  test('/health 200：status=ok 且 uptime 是数字', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('/ready 200：status=ready 且平台数与注册表一致', async () => {
    const res = await get('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; platforms: number };
    expect(body.status).toBe('ready');
    expect(body.platforms).toBe(listAdapters().length);
    expect(body.platforms).toBeGreaterThanOrEqual(4);
  });

  test('/platforms：统一信封 + 全平台 + 字段齐全', async () => {
    const res = await get('/platforms');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ platform: string; description: string; hosts: string[] }>;
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(listAdapters().length);
    const names = body.data.map((p) => p.platform).sort();
    expect(names).toEqual([
      'bilibili',
      'douyin',
      'instagram',
      'kuaishou',
      'twitter',
      'weibo',
      'xhs',
      'youtube',
    ]);
    for (const p of body.data) {
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
      expect(Array.isArray(p.hosts)).toBe(true);
      expect(p.hosts.length).toBeGreaterThan(0);
    }
  });

  test('/platforms：capabilities 声明 http/browser/tlsImpersonation/kinds', async () => {
    const body = (await (await get('/platforms')).json()) as {
      data: Array<{
        platform: string;
        capabilities: { http: boolean; browser: boolean; tlsImpersonation: boolean; kinds: string[] };
      }>;
    };
    for (const p of body.data) {
      expect(typeof p.capabilities.http).toBe('boolean');
      expect(typeof p.capabilities.browser).toBe('boolean');
      expect(typeof p.capabilities.tlsImpersonation).toBe('boolean');
      expect(Array.isArray(p.capabilities.kinds)).toBe(true);
      expect(p.capabilities.kinds.length).toBeGreaterThan(0);
    }
  });

  test('/metrics：Prometheus 文本格式 + 四个指标名都在', async () => {
    const res = await get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const text = await res.text();
    for (const name of ['parse_total', 'parse_duration_ms', 'cache_hit_total', 'upstream_error_total']) {
      expect(text).toContain(`# TYPE ${name}`);
      expect(text).toContain(name);
    }
  });

  test('/：服务自描述（name/version/platforms）', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string; platforms: string[] };
    expect(body.name).toBe('short-video-extractor');
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.platforms)).toBe(true);
    expect(body.platforms.length).toBe(listAdapters().length);
  });

  test('未知路径 404：UNSUPPORTED_CONTENT 统一信封', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      success: boolean;
      data: null;
      error: { code: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('UNSUPPORTED_CONTENT');
    expect(body.error.message).toBe('接口不存在');
  });
});
