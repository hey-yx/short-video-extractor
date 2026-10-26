/**
 * YouTube 实链验证（service 层）：registry dispatch → innertube fetch → parse → /media 同出口拉流。
 * 用法：bun tests/probe-youtube.ts
 */
import { dispatch, register } from '../src/platforms/registry';
import { youtubeAdapter } from '../src/platforms/youtube/adapter';
import { allowedHosts, fetchUpstream } from '../src/services/media-proxy';
import { resolveProxy } from '../src/infra/proxy';
import type { FetchCtx } from '../src/types/platform';

// service 层跑法不经过 createApp()，这里手动注册（每个进程只注册一次）
register(youtubeAdapter);

const ctx: FetchCtx = {
  signal: AbortSignal.timeout(30_000),
  channel: 'http',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  proxyUrl: resolveProxy('youtube'),
};

const LINKS: Array<[string, string]> = [
  ['普通长视频', 'https://www.youtube.com/watch?v=9bZkp7q19f0'],
  ['Shorts', 'https://www.youtube.com/shorts/pjWY5NkjsrY'],
  ['高清 1080p+', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['youtu.be 短链', 'https://youtu.be/9bZkp7q19f0'],
];

for (const [label, url] of LINKS) {
  const t0 = Date.now();
  try {
    const { adapter, input, url: finalUrl } = await dispatch(new URL(url), ctx);
    const tMatch = Date.now();
    const payload = await adapter.fetch(input, finalUrl, ctx);
    const tFetch = Date.now();
    const result = adapter.parse(payload, input);
    const asset = result.assets[0]!;
    const client = (payload.body as { client?: string }).client;
    console.log(
      `${label}: OK 总耗时 ${Date.now() - t0}ms（dispatch ${tMatch - t0}ms + fetch ${tFetch - tMatch}ms + parse ${Date.now() - tFetch}ms）`,
    );
    console.log(`  通道: innertube ${client} → ${finalUrl.href}`);
    console.log(`  id=${result.id} kind=${result.kind} via=${result.via} author=${result.author.name}`);
    console.log(`  title=${result.title.slice(0, 60)}`);
    console.log(
      `  ${asset.width}x${asset.height} duration=${asset.durationMs}ms audioUrl=${asset.audioUrl ? 'yes' : 'no'} variants=${(asset.variants ?? []).map((v) => v.ratio).join(',')}`,
    );
    console.log(
      `  expiresAt=${result.expiresAt}（${result.expiresAt ? result.expiresAt - Math.floor(Date.now() / 1000) : '?'}s 后过期）`,
    );

    // IP 一致性验证：/media 同出口拉流（googlevideo 直链绑 IP，必须与解析同代理）
    const res = await fetchUpstream(
      asset.url,
      new Headers({ range: 'bytes=0-65535' }),
      'GET',
      allowedHosts(),
    );
    const buf = await res.arrayBuffer();
    const head = [...new Uint8Array(buf.slice(0, 8))].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(
      `  media 拉流: ${res.status} ${res.headers.get('content-type')} ${buf.byteLength}B head=${head}`,
    );
  } catch (e) {
    console.log(`${label}: FAIL ${Date.now() - t0}ms ${e instanceof Error ? e.message : String(e)}`);
  }
}
