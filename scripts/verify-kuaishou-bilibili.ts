/**
 * 实链验证脚本（t_a1cc9cc7 验收项，可重复执行）：
 *   快手 1 条视频分享链接；B 站 1 条普通视频 + 1 条多 P
 *   每条：GET /parse 解析成功 → 直链 Range 0-2047 返回 206
 *   附：GET /platforms 显示 4 个平台
 * 全部进程内 app.handle 驱动，不启服务。用法：bun scripts/verify-kuaishou-bilibili.ts
 */
import { createApp } from '../src/bootstrap/app';
import type { ParseResult } from '../src/types/platform';

const app = createApp();

async function rangeCheck(url: string, referer?: string): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-2047', ...(referer ? { Referer: referer } : {}) },
    });
    await res.body?.cancel();
    return res.status;
  } catch (e) {
    // PCDN 节点偶发 ECONNRESET，探测脚本记为 -1 不中断
    console.log(`  [warn] range ${url.slice(0, 60)}... -> ${e instanceof Error ? e.message.slice(0, 40) : 'err'}`);
    return -1;
  }
}

async function probe(name: string, url: string, referer?: string) {
  const line: string[] = [];
  const res = await app.handle(new Request(`http://local/parse?url=${encodeURIComponent(url)}`));
  const body = (await res.json()) as { success: boolean; data?: ParseResult; code?: string; message?: string };
  if (!body.success || !body.data) {
    line.push(`[fail] ${name}: HTTP ${res.status} ${body.code ?? ''} ${body.message ?? ''}`);
    console.log(line.join('\n'));
    return;
  }
  const r = body.data;
  line.push(`[ok] ${name}: ${r.platform}/${r.id} ${r.kind} assets=${r.assets.length} author=${r.author.name} title=${r.title.slice(0, 40)}`);
  for (let i = 0; i < r.assets.length; i++) {
    const a = r.assets[i]!;
    const vStatus = await rangeCheck(a.url, referer);
    const aStatus = a.audioUrl ? await rangeCheck(a.audioUrl, referer) : '-';
    line.push(
      `  P${i + 1}${a.partTitle ? `[${a.partTitle}]` : ''} ${a.width}x${a.height} ${a.durationMs}ms video=${vStatus} audio=${aStatus}`,
    );
  }
  console.log(line.join('\n'));
}

await probe('kuaishou 短链', 'https://v.kuaishou.com/5hFdnB');
await probe('bilibili 单 P', 'https://www.bilibili.com/video/BV1GJ411x7h7', 'https://www.bilibili.com');
await probe('bilibili 多 P(23P)', 'https://www.bilibili.com/video/BV1bK411W797', 'https://www.bilibili.com');

const res = await app.handle(new Request('http://local/platforms'));
const body = (await res.json()) as Array<{ platform: string }> | { success: boolean; data: Array<{ platform: string }> };
const list = Array.isArray(body) ? body : body.data ?? [];
console.log(`platforms: status=${res.status} count=${list.length} [${list.map((p) => p.platform).join(', ')}]`);
