import { describe, expect, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';

const app = createApp();

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe('检测站路由（/status）', () => {
  test('/status 200：返回 HTML 页面，content-type 与 no-store 缓存头齐备', async () => {
    const res = await get('/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    // 状态页要反映当前部署，禁止浏览器拿旧缓存
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
  });

  test('/status：页面包含状态总览与四大端点取数逻辑', async () => {
    const res = await get('/status');
    const html = await res.text();
    // 状态总览横幅 + 服务/使用情况分区 + 解析演示保留
    for (const marker of [
      'banner',
      '服务',
      '使用情况',
      '解析演示',
      '/health',
      '/ready',
      '/platforms',
      '/metrics',
    ]) {
      expect(html).toContain(marker);
    }
  });

  test('/status：页面结构对 XSS 有防线（动态内容统一走 esc 转义）', async () => {
    const res = await get('/status');
    const html = await res.text();
    expect(html).toContain('function esc(s)');
    expect(html).not.toContain('document.write');
  });

  test('/status 与 / 互不干扰：根路径仍是 JSON 自描述', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('short-video-extractor');
  });

  test('/status 响应体是内嵌页面原文（与 docs/status.html 同源构建）', async () => {
    const diskPage = await Bun.file(new URL('../../docs/status.html', import.meta.url)).text();
    const res = await get('/status');
    expect(await res.text()).toBe(diskPage);
  });
});
