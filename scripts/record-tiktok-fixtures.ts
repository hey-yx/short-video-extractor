#!/usr/bin/env bun
/**
 * 录制 tikwm 真实响应 → tests/fixtures/tiktok/（脱敏）。
 * 脱敏原则：字段名照实；URL 里一次性签名段打码但保持结构；统计类计数归零。
 * 脚本不在 src/ 下，不参与 tsconfig include，Bun 运行时的 process/Bun 全局由 bun 提供。
 * 用法：OUTBOUND_PROXY=<本地代理地址> bun scripts/record-tiktok-fixtures.ts
 */
export {};

const PROXY = process.env.OUTBOUND_PROXY;

const VIDEO_URL = 'https://www.tiktok.com/@nasa/video/7665075736742530317';
const PHOTO_URL = 'https://www.tiktok.com/@dx_r13/photo/7398188624526724358';

async function get(url: string): Promise<unknown> {
  const qs = new URLSearchParams({ url, hd: '1' });
  const res = await fetch(`https://www.tikwm.com/api/?${qs}`, {
    proxy: PROXY,
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' },
  });
  return res.json();
}

/** URL 通用脱敏：path 第一段 32 位 hex 签名 + query 全剥（直链语义不变，{{SECRET_}} 字面值保留与否都剥掉） */
function redactUrl(u: string): string {
  if (!u) return u;
  try {
    const parsed = new URL(u);
    // path 第一段 32hex 签名 → <sig32>
    parsed.pathname = parsed.pathname.replace(/\/[0-9a-f]{32}\//, '/<sig32>/');
    parsed.search = '';
    return parsed.href;
  } catch {
    return u;
  }
}

function redact(json: unknown): unknown {
  if (typeof json === 'string') return redactUrl(json);
  if (Array.isArray(json)) return json.map(redact);
  if (json && typeof json === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (
        k === 'create_time' ||
        k === 'play_count' ||
        k === 'digg_count' ||
        k === 'comment_count' ||
        k === 'share_count' ||
        k === 'collect_count' ||
        k === 'download_count'
      ) {
        out[k] = 0; // 统计类数字脱零，结构保留
        continue;
      }
      out[k] = redact(v);
    }
    return out;
  }
  return json;
}

const video = redact(await get(VIDEO_URL));
const photo = redact(await get(PHOTO_URL));

await Bun.write('tests/fixtures/tiktok/tikwm-video.json', `${JSON.stringify(video, null, 2)}\n`);
await Bun.write('tests/fixtures/tiktok/tikwm-album.json', `${JSON.stringify(photo, null, 2)}\n`);
console.log('fixtures written: tikwm-video.json, tikwm-album.json');
const v = video as { data?: { id?: string; play?: string; hdplay?: string; images?: string[] } };
console.log('video id:', v.data?.id, 'play?', !!v.data?.play, 'hd?', !!v.data?.hdplay);
const p = photo as { data?: { id?: string; images?: string[] } };
console.log('photo id:', p.data?.id, 'images:', p.data?.images?.length);
