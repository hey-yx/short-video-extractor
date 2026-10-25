import { Elysia } from 'elysia';
// 检测站页面：构建期内嵌进二进制（Bun text import），容器里不需要带 docs/ 目录
import statusPage from '../../docs/status.html' with { type: 'text' };

export const statusRoutes = new Elysia()
  // 检测站：/status 返回页面；/ 保持 JSON 自描述（API 契约不变）
  .get('/status', ({ set }) => {
    set.headers['content-type'] = 'text/html; charset=utf-8';
    // 状态页要反映当前部署，别让浏览器拿旧缓存
    set.headers['cache-control'] = 'no-store';
    return statusPage;
  });
