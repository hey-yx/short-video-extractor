import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { AppError } from '@/core/errors';
import { fail } from '@/core/envelope';
import { register, listAdapters } from '@/platforms/registry';
import { douyinAdapter } from '@/platforms/douyin/adapter';
import { parseRoutes } from '@/routes/parse.routes';
import { opsRoutes } from '@/routes/ops.routes';

export function createApp() {
  // 注册平台（加平台 = 加目录 + 这里一行）
  register(douyinAdapter);

  const app = new Elysia()
    .use(cors({ origin: '*' }))
    .onError(({ code, error, set }) => {
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
      console.error('[unhandled]', error);
      set.status = 500;
      return fail('INTERNAL', error instanceof Error ? error.message : '内部错误');
    })
    .get('/', () => ({
      name: 'short-video-extractor',
      version: '2.0.0',
      platforms: listAdapters().map((a) => a.platform),
    }))
    .use(parseRoutes)
    .use(opsRoutes);

  return app;
}
