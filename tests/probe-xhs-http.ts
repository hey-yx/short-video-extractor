/**
 * 小红书 HTTP 主通道实链验证：HTTP feed 取 token 链接 → parseUrl（无浏览器注入）→ 直链 206 探测。
 * 用法：bun tests/probe-xhs-http.ts [笔记链接（带 xsec_token）]
 * 结尾对比同一链接 HTTP 通道 vs 浏览器通道耗时。
 */
import { parseUrl } from '../src/services/parse.service';
import { register } from '../src/platforms/registry';
import { xhsAdapter } from '../src/platforms/xhs/adapter';
import { browserGateway, closeBrowser } from '../src/infra/browser';
import type { FetchCtx, ParseResult } from '../src/types/platform';

register(xhsAdapter);

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9',
};

/** 纯 HTTP 上下文：browser 不注入，降级路径不可用——解析成功即证明 HTTP 通道独立可用 */
const httpCtx: FetchCtx = {
  signal: AbortSignal.timeout(30_000),
  channel: 'http',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

/** 浏览器兜底通道上下文（仅末尾耗时对比用） */
const browserCtx: FetchCtx = {
  signal: AbortSignal.timeout(30_000),
  channel: 'browser',
  browser: browserGateway,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

interface Outcome {
  url: string;
  ok: boolean;
  ms: number;
  kind: string;
  via: string;
  title: string;
  assets: number;
  directLinks: string[];
}

async function verifyUrl(rawUrl: string, ctx: FetchCtx): Promise<Outcome> {
  const t0 = Date.now();
  const base: Outcome = {
    url: rawUrl,
    ok: false,
    ms: 0,
    kind: '',
    via: '',
    title: '',
    assets: 0,
    directLinks: [],
  };
  try {
    const out = (await parseUrl(rawUrl, ctx)) as unknown as { result?: ParseResult } & Partial<ParseResult>;
    const r = (out.result ?? (out as ParseResult))!;
    base.ms = Date.now() - t0;
    base.ok = true;
    base.kind = r.kind;
    base.via = r.via;
    base.title = r.title.slice(0, 30);
    base.assets = r.assets.length;
    for (const a of r.assets) {
      try {
        const res = await fetch(a.url, {
          headers: { Range: 'bytes=0-65535' },
          signal: AbortSignal.timeout(15_000),
        });
        await res.body?.cancel();
        base.directLinks.push(`${res.status} ${res.headers.get('content-type') ?? '-'}`);
      } catch (e) {
        base.directLinks.push(`ERR ${e instanceof Error ? e.message.slice(0, 40) : e}`);
      }
    }
    return base;
  } catch (e) {
    base.ms = Date.now() - t0;
    const err = e as { code?: string; message?: string };
    base.kind = `FAIL ${err.code} ${err.message?.slice(0, 60)}`;
    return base;
  }
}

function show(tag: string, o: Outcome): void {
  console.log(`[${tag}] ${o.ok ? 'ok' : 'FAIL'} ${o.ms}ms kind=${o.kind} via=${o.via} assets=${o.assets}`);
  if (o.title) console.log(`[${tag}]   title=${o.title}`);
  for (const d of o.directLinks) console.log(`[${tag}]   direct ${d}`);
}

const arg = process.argv[2];

// ---- HTTP feed 取带 token 的链接（不经过浏览器） ----
const feedRes = await fetch('https://www.xiaohongshu.com/explore', {
  headers: HEADERS,
  redirect: 'manual',
  signal: AbortSignal.timeout(15_000),
});
console.log(`[feed] status=${feedRes.status}`);
if (feedRes.status !== 200) {
  console.log('[feed] HTTP 通道 feed 拉取失败，退出');
  process.exit(1);
}
const feedHtml = await feedRes.text();
const seen = new Map<string, string>();
for (const m of feedHtml.matchAll(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})\?xsec_token=([^&"'\\]+)/g)) {
  if (!seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
}
console.log(`[feed] tokenized notes: ${seen.size}`);

// ---- 选样：视频 + 图文（多图优先）+ 第三条补位，至少 3 条 ----
const picks: Array<{ id: string; token: string }> = [];
let sawVideo = false;
let sawAlbum = false;
for (const [id, token] of seen) {
  if (picks.length >= 4) break;
  const url = `https://www.xiaohongshu.com/explore/${id}?xsec_token=${token}&xsec_source=pc_feed`;
  const o = await verifyUrl(url, httpCtx);
  show('http', o);
  if (!o.ok) continue;
  if (o.kind === 'video' && !sawVideo) {
    sawVideo = true;
    picks.push({ id, token });
  } else if (o.kind === 'album' && !sawAlbum) {
    sawAlbum = true;
    picks.push({ id, token });
  } else if (picks.length < 3) {
    picks.push({ id, token });
  }
}

// ---- 指定链接模式 ----
if (arg) {
  const o = await verifyUrl(arg, httpCtx);
  show('http-arg', o);
  picks.push({ id: '', token: '' });
}

// ---- 耗时对比：同一链接 HTTP vs 浏览器 ----
const cmpTarget = picks[0];
if (cmpTarget?.id) {
  const url = `https://www.xiaohongshu.com/explore/${cmpTarget.id}?xsec_token=${cmpTarget.token}&xsec_source=pc_feed`;
  // 缓存会吞第二次解析：手动各跑一遍原始通道
  const tHttp = Date.now();
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const html = res.status === 200 ? await res.text() : '';
  const httpMs = Date.now() - tHttp;
  const hasData = html.includes('__INITIAL_STATE__') && html.includes('noteDetailMap');
  console.log(`[cmp] http raw: ${httpMs}ms status=${res.status} hasState=${hasData} html=${html.length}B`);
  const tBr = Date.now();
  const brHtml = await browserGateway.getDocumentHtml(url, 15_000);
  const brMs = Date.now() - tBr;
  console.log(
    `[cmp] browser raw: ${brMs}ms html=${brHtml.length}B hasState=${brHtml.includes('__INITIAL_STATE__')}`,
  );
}
await closeBrowser();
console.log('[done] http-channel picks:', picks.length, 'video:', sawVideo, 'album:', sawAlbum);
