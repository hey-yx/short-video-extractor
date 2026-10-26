import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '@/platforms/hosts';
import { mapPlayability, parseYoutube } from './parse';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player';

/**
 * innertube client 回退链：ANDROID_VR 先（能到 4K），被 bot 检查拦时换 IOS（调研 05 §1.2）。
 * 顺序即优先级；攻防变化时改这里。平台层不读 env，配置收敛为此常量。
 */
export const CLIENT_CHAIN = ['ANDROID_VR', 'IOS'] as const;
type InnertubeClient = (typeof CLIENT_CHAIN)[number];

const CLIENTS: Record<
  InnertubeClient,
  { context: Record<string, unknown>; headers: Record<string, string> }
> = {
  ANDROID_VR: {
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.62.27',
      androidSdkVersion: 32,
      hl: 'en',
      gl: 'US',
    },
    headers: {
      'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US) gzip',
      'X-Youtube-Client-Name': '28',
      'X-Youtube-Client-Version': '1.62.27',
    },
  },
  IOS: {
    context: {
      clientName: 'IOS',
      clientVersion: '20.32.4',
      deviceModel: 'iPhone16,2',
      osVersion: '18.5.22F76',
      hl: 'en',
      gl: 'US',
    },
    headers: {
      'User-Agent': 'com.google.ios.youtube/20.32.4 (iPhone16,2; U; CPU iOS 18_5_22 like Mac OS X;) gzip',
      'X-Youtube-Client-Name': '5',
      'X-Youtube-Client-Version': '20.32.4',
    },
  },
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function videoIdOf(value: string | null | undefined): string | null {
  return value && VIDEO_ID_RE.test(value) ? value : null;
}

interface Attempt {
  client: InnertubeClient;
  status?: string;
  reason?: string;
}

async function playerRequest(
  client: InnertubeClient,
  videoId: string,
  ctx: FetchCtx,
): Promise<Record<string, unknown>> {
  const def = CLIENTS[client];
  const res = await proxiedFetch(PLAYER_URL, {
    method: 'POST',
    proxy: ctx.proxyUrl,
    signal: ctx.signal,
    headers: { 'Content-Type': 'application/json', ...def.headers },
    body: JSON.stringify({
      context: { client: def.context },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `YouTube player HTTP ${res.status}`, {
      client,
      body: text.slice(0, 120),
    });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AppError('UPSTREAM_CHANGED', 'YouTube player 返回非 JSON', { client });
  }
}

export const youtubeAdapter: PlatformAdapter = {
  platform: 'youtube',
  description: 'YouTube：innertube player（ANDROID_VR→IOS 回退），明文直链免解扰，直链绑 IP 走 /media 中转',
  hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  capabilities: { http: true, browser: false, tlsImpersonation: false, kinds: ['video'] },

  match(url: URL): MatchResult | null {
    if (url.hostname === 'youtu.be') {
      const id = videoIdOf(url.pathname.replace(/\//g, '').slice(0, 11));
      if (!id) return null;
      return { platform: 'youtube', id, kind: 'video', needsResolve: true };
    }
    if (!hostMatches(url.hostname, 'youtube.com') && !hostMatches(url.hostname, 'youtube-nocookie.com')) {
      return null;
    }
    // /watch?v=<id> 与 /shorts|embed|live|v/<id> 形态（Shorts 与普通视频同一接口）
    const fromQuery = videoIdOf(url.searchParams.get('v'));
    if (url.pathname === '/watch' && fromQuery) {
      return { platform: 'youtube', id: fromQuery, kind: 'video', needsResolve: false };
    }
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
    const id = videoIdOf(m?.[2]);
    if (id) {
      return { platform: 'youtube', id, kind: 'video', needsResolve: false };
    }
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // youtu.be 302 一跳到 youtube.com/watch?v=xxx 或 /shorts/xxx
    const res = await proxiedFetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      proxy: ctx.proxyUrl,
      signal: ctx.signal,
    });
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', 'youtu.be 短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc, url.href);
  },

  async fetch(input: MatchResult, _url: URL, ctx: FetchCtx): Promise<RawPayload> {
    const attempts: Attempt[] = [];
    for (const client of CLIENT_CHAIN) {
      let player: Record<string, unknown>;
      try {
        player = await playerRequest(client, input.id, ctx);
      } catch (e) {
        // 网络层失败换下一个 client 重试；全挂再抛
        attempts.push({ client, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const ps = (player.playabilityStatus ?? {}) as { status?: string; reason?: string };
      const streamingData = player.streamingData as
        { adaptiveFormats?: unknown[]; formats?: unknown[] } | undefined;
      if (
        ps.status === 'OK' &&
        streamingData &&
        (streamingData.formats ?? []).length + (streamingData.adaptiveFormats ?? []).length > 0
      ) {
        return {
          via: 'api',
          channel: 'http',
          fetchedAt: Math.floor(Date.now() / 1000),
          body: { client, player },
        };
      }
      attempts.push({ client, status: ps.status, reason: ps.reason });
      // bot 检查/不可播都是按 client 概率性发生的，换下一个 client 才是有效重试（调研 05 §1.2）
    }
    const last = attempts[attempts.length - 1];
    const err = mapPlayability(last?.status, last?.reason);
    throw new AppError(err.code, err.message, { ...(err.detail ?? {}), attempts });
  },

  parse: parseYoutube,
};
