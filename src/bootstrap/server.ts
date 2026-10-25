import { createApp } from './app';
import { logger } from '@/infra/logger';

const PORT = Number(process.env.PORT ?? 7777);

const app = createApp();
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'sve listening');
});

// 优雅关闭
process.on('SIGTERM', () => {
  logger.info('SIGTERM, stopping');
  app.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  app.stop();
  process.exit(0);
});
