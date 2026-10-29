/**
 * X/Twitter 实链验证（t_87244e4c 验收项，可重复执行）：
 *   单视频推文 1 条 + GIF 推文 1 条 + 4 图图集推文 1 条 + t.co 短链 1 条
 *   每条：GET /parse 解析成功 → 直链 Range 0-2047 返回 206
 *   附：GET /platforms 显示 5 个平台
 * 全部进程内 app.handle 驱动，不启服务。用法：bun scripts/verify-twitter.ts
 */
import { createApp } from '../src/bootstrap/app';
import type { ParseResult } from '../src/types/platform';

const app = createApp();

async function rangeCheck(url: string): Promise<number> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' } });
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
  const body = (await res.json()) as {
    success: boolean;
    data?: ParseResult;
    code?: string;
    message?: string;
  };
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
    const status = await rangeCheck(a.url);
    lines.push(
      `  #${i + 1} ${a.type} ${a.width ?? '?'}x${a.height ?? '?'} variants=${a.variants?.length ?? 0} direct=${status} ${a.url.slice(0, 80)}`,
    );
  }
  console.log(lines.join('\n'));
}

await probe('x.com 单视频', 'https://x.com/JeffLadish/status/2104732943457599638');
await probe('x.com GIF→mp4', 'https://x.com/Wallface/status/2107578945742987490');
await probe('x.com 4图图集', 'https://x.com/BluesOfBirds/status/2112763635378663468');
await probe('t.co 短链（→视频推）', 'https://t.co/4NNIMDP3TO');

const res = await app.handle(new Request('http://local/platforms'));
const body = (await res.json()) as { success: boolean; data: Array<{ platform: string }> };
console.log(
  `platforms: status=${res.status} count=${body.data.length} [${body.data.map((p) => p.platform).join(', ')}]`,
);
