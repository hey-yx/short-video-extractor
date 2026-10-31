import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { AppError } from '@/core/errors';
import { fail } from '@/core/envelope';
import { register, listAdapters } from '@/platforms/registry';
import { registerSigner } from '@/core/signers';
import { douyinAbogusSigner } from '@/platforms/douyin/abogus-signer';
import { douyinAdapter } from '@/platforms/douyin/adapter';
import { kuaishouAdapter } from '@/platforms/kuaishou/adapter';
import { bilibiliAdapter } from '@/platforms/bilibili/adapter';
import { xhsAdapter } from '@/platforms/xhs/adapter';
import { weiboAdapter } from '@/platforms/weibo/adapter';
import { twitterAdapter } from '@/platforms/twitter/adapter';
import { youtubeAdapter } from '@/platforms/youtube/adapter';
import { instagramAdapter } from '@/platforms/instagram/adapter';
import { tiktokAdapter } from '@/platforms/tiktok/adapter';
import { redactRequestUrl, reqIdOf, reqStartedAt, requestLogger } from '@/infra/logger';
import { parseRoutes } from '@/routes/parse.routes';
import { mediaRoutes } from '@/routes/media.routes';
import { opsRoutes } from '@/routes/ops.routes';

export function createApp() {
  // 注册平台（加平台 = 加目录 + 这里一行）
  register(douyinAdapter);
  // 注册默认签名器（算法过期时换 provider 热替换，见 core/signers）
  registerSigner(douyinAbogusSigner);
  register(kuaishouAdapter);
  register(bilibiliAdapter);
  register(xhsAdapter);
  register(weiboAdapter);
  register(twitterAdapter);
  register(youtubeAdapter);
  register(instagramAdapter);
  register(tiktokAdapter);

  const app = new Elysia()
    .use(cors({ origin: '*' }))
    // 每请求：生成/透传 requestId，响应回写 X-Request-Id
    .onRequest(({ request, set }) => {
      set.headers['x-request-id'] = reqIdOf(request);
    })
    // 访问日志：requestId + 脱敏 URL（query 里 xsec_token 等不进日志）
    .onAfterResponse(({ request, set }) => {
      const status = typeof set.status === 'number' ? set.status : 200;
      requestLogger(request).info(
        {
          method: request.method,
          path: redactRequestUrl(request.url),
          status,
          ms: Math.round(performance.now() - reqStartedAt(request)),
        },
        'request done',
      );
    })
    .onError(({ code, error, set, request }) => {
      if (error instanceof AppError) {
        set.status = error.httpStatus;
        return fail(error.code, error.message, error.detail);
      }
      if (code === 'NOT_FOUND') {
        set.status = 404;
        return fail('UNSUPPORTED_CONTENT', '接口不存在');
      }
      if (code === 'VALIDATION') {
        set.status = 400;
        return fail('INVALID_URL', '请求参数不合法');
      }
      // 未知异常：不吞栈，打日志并返回 INTERNAL
      requestLogger(request).error({ err: error }, 'unhandled error');
      set.status = 500;
      return fail('INTERNAL', error instanceof Error ? error.message : '内部错误');
    })
    .get('/', () => ({
      name: 'allparse',
      version: '2.1.0',
      platforms: listAdapters().map((a) => a.platform),
    }))
    .use(parseRoutes)
    .use(mediaRoutes)
    .use(opsRoutes);

  return app;
}
