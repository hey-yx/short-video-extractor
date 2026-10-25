import { Elysia } from 'elysia';

import { AppError } from '@/core/errors';
import {
  allowedHosts,
  buildMediaResponseHeaders,
  fetchUpstream,
  mediaConcurrency,
  verifyMediaSignature,
} from '@/services/media-proxy';

const PROXY_HINT = 'PROXY_SECRET 未配置，/media 中转未启用（可选增强）。直链仍是主路径。';

/** Content-Disposition 文件名：标题清洗 + RFC 5987（中文文件名） */
function contentDisposition(title: string, contentType: string): string | null {
  const ext = contentType.includes('audio') ? 'm4a' : 'mp4';
  const base = title
    .replace(/[\\/:*?"<>|\n\r]/g, ' ')
    .trim()
    .slice(0, 80);
  if (!base) return null;
  return `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

async function proxyMedia(request: Request, query: Record<string, string>): Promise<Response> {
  // 未配置密钥：501 + 提示文案（可选增强未启用，走 envelope 错误信封）
  if (!process.env.PROXY_SECRET) {
    throw new AppError('MEDIA_PROXY_DISABLED', PROXY_HINT);
  }

  const verified = verifyMediaSignature(query);
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';

  // 并发上限 2：满了直接拒绝（客户端会重试），不排队占内存
  if (mediaConcurrency.size >= 2) {
    throw new AppError('RATE_LIMITED', '中转并发已达上限，请稍后重试');
  }

  return mediaConcurrency.run(async () => {
    const upstream = await fetchUpstream(verified.url, request.headers, method, allowedHosts());
    const out = buildMediaResponseHeaders(upstream.headers);
    if (method === 'GET') {
      const cd = contentDisposition(query.title ?? '', out.get('content-type') ?? '');
      if (cd) out.set('content-disposition', cd);
    }
    // 交回 ReadableStream：Bun 背压（research/03 §4.3），不 await arrayBuffer
    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    });
  });
}

export const mediaRoutes = new Elysia({ prefix: '/media' })
  // ★ 实测坑 1：HEAD 必须显式注册，否则 Elysia 自动应答会把 content-length 改写成 0
  .get('/', ({ request, query }) => proxyMedia(request, query))
  .head('/', ({ request, query }) => proxyMedia(request, query));
