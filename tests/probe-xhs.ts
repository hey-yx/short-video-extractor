/**
 * 小红书实链验证（service 层）：registry dispatch → fetch → parse。
 * 用法：bun tests/probe-xhs.ts [笔记链接（带 xsec_token）]
 * 不给链接时从探索流自取 token 实测。
 */
import { parseUrl } from "../src/services/parse.service";
import { register } from "../src/platforms/registry";
import { xhsAdapter } from "../src/platforms/xhs/adapter";
import { browserGateway, closeBrowser } from "../src/infra/browser";
import type { FetchCtx } from "../src/types/platform";

// service 层跑法不经过 createApp()，这里手动注册（每个进程只注册一次）
register(xhsAdapter);

const ctx: FetchCtx = {
  signal: AbortSignal.timeout(30_000),
  channel: "browser",
  browser: browserGateway,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

async function verifyUrl(
  rawUrl: string,
): Promise<{ ok: boolean; kind: string }> {
  const t0 = Date.now();
  try {
    const { result: r, cached } = await parseUrl(rawUrl, ctx);
    console.log(
      `[verify] ok in ${Date.now() - t0}ms: ${r.platform}/${r.id} kind=${r.kind} via=${r.via} cached=${cached}`,
    );
    console.log(
      `[verify] title=${r.title.slice(0, 30)} author=${r.author.name} assets=${r.assets.length}`,
    );
    for (const a of r.assets) {
      console.log(
        `[verify]   ${a.type} ${a.width ?? "?"}x${a.height ?? "?"} dur=${a.durationMs ?? "-"}ms size=${a.size ?? "-"} backups=${a.backups?.length ?? 0}`,
      );
      console.log(`[verify]     url=${a.url}`);
      try {
        const res = await fetch(a.url, {
          headers: { Range: "bytes=0-65535" },
          signal: AbortSignal.timeout(15000),
        });
        await res.body?.cancel();
        console.log(
          `[verify]     direct-link ${res.status} ${res.headers.get("content-type")} range=${res.headers.get("content-range") ?? "-"}`,
        );
      } catch (e) {
        console.log(
          "[verify]     direct-link error:",
          e instanceof Error ? e.message.slice(0, 60) : e,
        );
      }
    }
    return { ok: true, kind: r.kind };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.log(`[verify] FAILED in ${Date.now() - t0}ms:`, err.code, err.message);
    return { ok: false, kind: "" };
  }
}

const arg = process.argv[2];
if (arg) {
  const r = await verifyUrl(arg);
  if (!r.ok) process.exitCode = 1;
} else {
  const html = await browserGateway.getDocumentHtml(
    "https://www.xiaohongshu.com/explore",
    25000,
  );
  const re = /\/explore\/([0-9a-f]{24})\?xsec_token=([^&"']+)/g;
  const seen = new Map<string, string>();
  for (const m of html.matchAll(re)) {
    if (!seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
  }
  console.log("[probe] tokenized notes in feed:", seen.size);
  // 集齐 video + album 各一条（上限 10 条，防止 feed 全是同类）
  let sawVideo = false;
  let sawAlbum = false;
  let tried = 0;
  for (const [id, token] of seen) {
    if ((sawVideo && sawAlbum) || tried >= 10) break;
    tried++;
    const url = `https://www.xiaohongshu.com/explore/${id}?xsec_token=${token}&xsec_source=pc_feed`;
    const r = await verifyUrl(url);
    if (!r.ok) continue;
    if (r.kind === "video") sawVideo = true;
    else sawAlbum = true;
    console.log("---");
  }
  console.log("[probe] kinds seen:", { sawVideo, sawAlbum });
}
await closeBrowser();
