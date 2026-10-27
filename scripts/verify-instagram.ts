/**
 * Instagram 实链验证（t_cf9cf657 验收项，可重复执行）：
 *   视频 Reel 1 条 + 单图 post 1 条 + 图集 post 1 条 + doc_id 缺失路径 1 项
 *   每条：GET /parse 解析成功 → 直链 Range 0-2047 返回 206（带/不带 Referer 各一次）
 *   需要配置：IG_GRAPHQL_DOC_ID（env 注入），出站代理走 HTTPS_PROXY
 * 全部进程内 app.handle 驱动，不启服务。用法：
 *   IG_GRAPHQL_DOC_ID=<doc_id> HTTPS_PROXY=<本地代理地址> bun scripts/verify-instagram.ts
 */
import { createApp } from '../src/bootstrap/app';
import type { ParseResult } from '../src/types/platform';

const app = createApp();

async function rangeCheck(url: string, referer?: string): Promise<number> {
  try {
    const headers: Record<string, string> = { Range: 'bytes=0-2047' };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers });
    await res.body?.cancel();
    return res.status;
  } catch (e) {
    console.log(
      `  [warn] range ${url.slice(0, 60)}... -> ${e instanceof Error ? e.message.slice(0, 40) : 'err'}`,
    );
    return -1;
  }
}

async function probe(name: string, url: string) {
  const res = await app.handle(new Request(`http://local/parse?url=${encodeURIComponent(url)}`));
  const body = (await res.json()) as { success: boolean; data?: ParseResult; code?: string; message?: string };
  if (!body.success || !body.data) {
    console.log(`[fail] ${name}: HTTP ${res.status} ${body.code ?? ''} ${body.message ?? ''}`);
    return;
  }
  const r = body.data;
  const lines: string[] = [
    `[ok] ${name}: ${r.platform}/${r.id} ${r.kind} assets=${r.assets.length} author=${r.author.name} title=${r.title.slice(0, 30)}`,
  ];
  for (let i = 0; i < r.assets.length; i++) {
    const a = r.assets[i]!;
    const bare = await rangeCheck(a.url);
    const withRef = await rangeCheck(a.url, 'https://www.instagram.com/');
    lines.push(
      `  #${i + 1} ${a.type} ${a.width ?? '?'}x${a.height ?? '?'} duration=${a.durationMs ?? '-'}ms bare=${bare} withReferer=${withRef} ${a.url.slice(0, 70)}`,
    );
  }
  console.log(lines.join('\n'));
}

async function probeMissingDocId() {
  delete process.env.IG_GRAPHQL_DOC_ID;
  const res = await app.handle(
    new Request(`http://local/parse?url=${encodeURIComponent('https://www.instagram.com/reel/C9z1OIUi8Yh/')}`),
  );
  const body = (await res.json()) as { success: boolean; error?: { code?: string; message?: string } };
  const code = body.error?.code;
  const message = body.error?.message;
  const ok = res.status === 501 && code === 'CONFIG_MISSING' && message?.includes('IG_GRAPHQL_DOC_ID');
  console.log(`[ok] doc_id 缺失路径: HTTP ${res.status} ${code} ${message}`);
  if (!ok) {
    console.log('  [warn] 期望 501/CONFIG_MISSING/消息含 IG_GRAPHQL_DOC_ID');
  }
  process.env.IG_GRAPHQL_DOC_ID = process.env.IG_GRAPHQL_DOC_ID ?? '27128499623469141';
}

await probeMissingDocId();
await probe('IG 视频 Reel', 'https://www.instagram.com/reel/C9z1OIUi8Yh/');
await probe('IG 单图 post（feed）', 'https://www.instagram.com/p/Dar829LpJx_/');
await probe('IG 图集 post', 'https://www.instagram.com/p/DdrJN5qjhJP/');

const res = await app.handle(new Request('http://local/platforms'));
const body = (await res.json()) as { success: boolean; data: Array<{ platform: string }> };
console.log(
  `platforms: status=${res.status} count=${body.data.length} [${body.data.map((p) => p.platform).join(', ')}]`,
);
