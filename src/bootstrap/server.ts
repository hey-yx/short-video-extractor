import { createApp } from './app';

const PORT = Number(process.env.PORT ?? 7777);

const app = createApp();
app.listen(PORT, () => {
  console.log(`[sve] listening on :${PORT}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[sve] SIGTERM, stopping');
  app.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  app.stop();
  process.exit(0);
});
