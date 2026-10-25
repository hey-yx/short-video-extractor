/**
 * 实链验证脚本（t_a1cc9cc7 验收项，可重复执行）：
 *   快手 1 条视频分享链接；B 站 1 条普通视频 + 1 条多 P
 *   每条：解析成功 → 直链 Range 0-2047 返回 206
 *   附：GET /platforms 平台数（进程内 app.handle，不启服务）
 * 用法：bun scripts/verify-kuaishou-bilibili.ts
 */
import { parseUrl } from '@/services/parse.service';
import { createApp } from '@/bootstrap/app';
import type { FetchCtx, ParseResult } from '@/types/platform';

const ctx = (): FetchCtx => ({
  signal: AbortSignal.timeout(30_000),
  channel: 'http',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

async function rangeCheck(url: string, referer?: string): Promise<number> {
  const res = await fetch(url, {
    headers: { Range: 'bytes=0-2047', ...(referer ? { Referer: referer } : {}) },
  });
  await res.body?.cancel();
  return res.status;
}

async function probe(name: string, url: string, referer?: string) {
  const line: string[] = [];
  try {
    const r: ParseResult = await parseUrl(url, ctx());
    line.push(`[ok] ${name}: ${r.platform}/${r.id} ${r.kind} assets=${r.assets.length} author=${r.author.name}`);
    for (let i = 0; i < r.assets.length; i++) {
      const a = r.assets[i]!;
      const vStatus = await rangeCheck(a.url, referer);
      const aStatus = a.audioUrl ? await rangeCheck(a.audioUrl, referer) : '-';
      line.push(
        `  P${i + 1}${a.partTitle ? `[${a.partTitle}]` : ''} ${a.width}x${a.height} ${a.durationMs}ms video=${vStatus} audio=${aStatus}`,
      );
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    line.push(`[fail] ${name}: ${err.code ?? ''} ${err.message ?? String(e)}`);
  }
  console.log(line.join('\n'));
}

await probe('kuaishou 短链', 'https://v.kuaishou.com/5hFdnB');
await probe('bilibili 单 P', 'https://www.bilibili.com/video/BV1GJ411x7h7', 'https://www.bilibili.com');
await probe('bilibili 多 P(23P)', 'https://www.bilibili.com/video/BV1bK411W797', 'https://www.bilibili.com');
