import { AppError } from '@/core/errors';
import { proxiedFetch } from '@/core/fetch-proxy';
import { uifidPool, type UifidMinter } from './uifid-pool';
import { recordChannelDowngrade } from '@/infra/metrics';
import { recordHttpRiskControl, shouldSkipHttp } from '@/infra/channel-policy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { hostMatches } from '../hosts';
import { parseAweme } from './parse';
import { buildL2DetailRequest, resolveTtwid, type L2Identity } from './signing';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** detail 接口的零签名通道（实测唯一开关是 Origin 头，见 docs/research/01 §2.2） */
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
/** 浏览器兜底时从 response 事件截取的 XHR 路径（页面自己会带签名请求它） */
const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';
const OPEN_ORIGIN = 'https://open.douyin.com';
/** 浏览器兜底单次导航上限（总耗时仍受 ctx.signal 15s 约束） */
const BROWSER_TIMEOUT_MS = 15_000;

const AWEME_ID_RE = /\/(?:video|note|share\/video|share\/note)\/(\d{15,20})/;
const MODAL_ID_RE = /[?&]modal_id=(\d{15,20})/;

/** 抖音直链形态（空 Referer 可下；见 docs/research/01 §5） */
export function buildPlayUrl(videoId: string, ratio: string): string {
  return `https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(videoId)}&ratio=${ratio}&line=0`;
}

/** 纯 HTTP 通道：L1 零签名 detail 接口（失效信号 = 403 ArgusSecurityPlugin，§2.2） */
async function fetchViaHttp(input: MatchResult, ctx: FetchCtx): Promise<RawPayload> {
  const qs = new URLSearchParams({ aweme_id: input.id, aid: '6383' });
  let res: Response;
  try {
    res = await fetch(`${DETAIL_URL}?${qs}`, {
      headers: {
        // 唯一必需头；UA/Referer 均可省（实测矩阵见调研文档）
        Origin: OPEN_ORIGIN,
        'User-Agent': UA,
      },
      signal: ctx.signal,
    });
  } catch (err) {
    // 网络层失败归一成 UPSTREAM_TIMEOUT（parse.service 据此重试）；请求被取消则原样上抛
    if (ctx.signal.aborted) throw err;
    throw new AppError('UPSTREAM_TIMEOUT', '抖音接口网络错误或超时', { err: String(err).slice(0, 120) });
  }

  if (res.status === 403) {
    const text = await res.text();
    if (text.includes('ArgusSecurityPlugin') || text.includes('Uifid')) {
      throw new AppError('RISK_CONTROL', '抖音风控拦截（L1 通道疑似失效）', { body: text.slice(0, 120) });
    }
    throw new AppError('UPSTREAM_ERROR', '抖音接口 403', { body: text.slice(0, 120) });
  }
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `抖音接口 HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) {
    // 200 + 空 body = 静默拒绝，必须当失败（调研文档 §2.3）
    throw new AppError('UPSTREAM_CHANGED', '抖音接口返回空 body');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('UPSTREAM_CHANGED', '抖音接口返回非 JSON');
  }
  return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body: json, channel: 'http' };
}

/** 纯 HTTP 签名通道（L2）：标准参数集 + ttwid + uifid + x-secsdk-web-signature（§12.3 配方，不带 a_bogus）。
 * 失效信号与 L1 不同：403 / 200 空 body 都归 UPSTREAM_CHANGED（签名过期 = bdms 升级或 uifid 过期），
 * 与 L1 的 RISK_CONTROL 在错误码与降级打点上区分。 */
async function fetchViaSigned(input: MatchResult, ctx: FetchCtx, identity: L2Identity): Promise<RawPayload> {
  const { url, headers } = buildL2DetailRequest(input.id, identity);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new AppError('UPSTREAM_TIMEOUT', '抖音 L2 签名通道网络错误或超时', {
      err: String(err).slice(0, 120),
    });
  }
  if (res.status === 403) {
    const text = await res.text();
    throw new AppError('UPSTREAM_CHANGED', '抖音 L2 签名失效（403，疑似 bdms 升级或 uifid 过期）', {
      body: text.slice(0, 120),
    });
  }
  if (res.status !== 200) {
    throw new AppError('UPSTREAM_ERROR', `抖音 L2 接口 HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) {
    // 200 + 空 body = 静默拒绝，必须当失败（调研文档 §2.3）
    throw new AppError('UPSTREAM_CHANGED', '抖音 L2 接口返回空 body（静默拒绝）');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('UPSTREAM_CHANGED', '抖音 L2 接口返回非 JSON');
  }
  return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body: json, channel: 'http-l2' };
}

/** 浏览器兜底通道：真实 Chrome 打开作品页，截页面自己发出的 detail XHR JSON */
async function fetchViaBrowser(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
  if (!ctx.browser) {
    throw new AppError('RISK_CONTROL', '抖音风控拦截，且浏览器兜底通道不可用', { id: input.id });
  }
  // 优先用原链接导航（保留 /note/、modal 等页面形态）；短链已在 dispatch 展开成内容页
  const pageUrl = hostMatches(url.hostname, 'douyin.com')
    ? url.href
    : `https://www.douyin.com/video/${input.id}`;
  let body: unknown;
  try {
    body = await ctx.browser.interceptJson(pageUrl, DETAIL_PATH, BROWSER_TIMEOUT_MS, ctx.signal);
  } catch (err) {
    if (err instanceof AppError || ctx.signal.aborted) throw err;
    // puppeteer 原生超时等非业务错误归一，别以 INTERNAL 冒出
    throw new AppError('UPSTREAM_TIMEOUT', '抖音浏览器通道超时', { err: String(err).slice(0, 120) });
  }
  const detail = (body as { aweme_detail?: unknown } | null)?.aweme_detail;
  if (!detail) {
    throw new AppError('UPSTREAM_CHANGED', '浏览器通道未截到 aweme_detail 数据');
  }
  return { via: 'api', fetchedAt: Math.floor(Date.now() / 1000), body, channel: 'browser' };
}

/** douyin.com 页面路径：uifid 铸造就开精选页（同 research §12.2 复铸手册的入口） */
const CAST_URL = 'https://www.douyin.com/jingxuan';
/** JS 挑战种下 UIFID_TEMP 的实测窗口约 8s（research §12.2），超时就当没铸出来 */
const CAST_TIMEOUT_MS = 8_000;

/**
 * L2 身份解析（惰性，只在真要打 L2 时才花钱）：
 *  1. env 固定身份（DOUYIN_UIFID）优先，运维显式指定，换不换由运维定；
 *  2. 缺省走 uifid 池：复用池里活着的访客，没有就用浏览器铸一个新的（铸造有节流，拿不到不硬磕）。
 */
async function resolveL2Identity(ctx: FetchCtx): Promise<(L2Identity & { pooled: boolean }) | null> {
  if (ctx.douyinUifid) {
    const ttwid = await resolveTtwid(ctx.douyinTtwid, ctx.signal);
    return ttwid ? { uifid: ctx.douyinUifid, ttwid, pooled: false } : null;
  }
  const collect = ctx.browser?.collectCookies;
  if (!collect) return null;
  const minter: UifidMinter = async (signal) => {
    const cookies = await collect(CAST_URL, { name: 'UIFID_TEMP', timeoutMs: CAST_TIMEOUT_MS }, signal);
    const uifid = cookies['UIFID_TEMP'];
    return uifid ? { uifid, ttwid: cookies['ttwid'] ?? null } : null;
  };
  const minted = await uifidPool.acquire(minter, ctx.signal);
  if (!minted) return null;
  // ttwid 同场带出最稳，拿不到再让签名器现铸一个（同身份体系，略逊但可用）
  const ttwid = minted.ttwid ?? (await resolveTtwid(undefined, ctx.signal));
  return ttwid ? { uifid: minted.uifid, ttwid, pooled: true } : null;
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  description: '抖音：零签名 detail 通道 + 签名 L2 通道 + play 直链（L1 风控时逐级降级，浏览器兜底）',
  hosts: ['douyin.com', 'iesdouyin.com'],
  capabilities: { http: true, browser: true, tlsImpersonation: false, kinds: ['video', 'album'] },

  match(url: URL): MatchResult | null {
    // 短链
    if (url.hostname === 'v.douyin.com') {
      return { platform: 'douyin', id: url.pathname.replace(/\//g, ''), kind: 'unknown', needsResolve: true };
    }
    // 长链 / 分享页
    const m = url.href.match(AWEME_ID_RE);
    if (m?.[1]) return { platform: 'douyin', id: m[1], kind: 'unknown', needsResolve: false };
    const modal = url.href.match(MODAL_ID_RE);
    if (modal?.[1]) return { platform: 'douyin', id: modal[1], kind: 'unknown', needsResolve: false };
    return null;
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    // v.douyin.com 短链：HEAD 不跟随，Location 里直接有 aweme_id
    const res = await proxiedFetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: ctx.signal,
    });
    // 响应体必须取消，防连接泄漏
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', '抖音短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc);
  },

  async fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
    // L2 可用性：env 固定身份，或有浏览器能自动铸造 uifid（池子管理）
    const wantL2 = !!ctx.douyinUifid || !!ctx.browser?.collectCookies;
    let lastErr: AppError | null = null;
    /** L1 是否命中真风控（决定要不要进熔断记账，见下方四分类说明） */
    let l1RiskControl = false;
    // 熔断粘性：L1 连续被风控期间不再每请求先吃一次 403（半开态探针放行 L1 试探）；
    // 粘住后链路变 L2 → 浏览器——L2 仍是零浏览器的纯 HTTP 通道
    const skipL1 = shouldSkipHttp('douyin') && (wantL2 || !!ctx.browser);
    if (skipL1) {
      ctx.logger.warn('douyin circuit sticky: skip L1', { id: input.id, l2: wantL2 });
    } else {
      try {
        return await fetchViaHttp(input, ctx);
      } catch (err) {
        // L1 失效（403 Argus 风控 / 接口侧 5xx/504）→ 先试 L2 签名通道再落浏览器；
        // 超时与结构变更不降级（交给上层重试/如实报错），无后继通道、信号已取消时原样上抛
        const downgrade =
          err instanceof AppError && (err.code === 'RISK_CONTROL' || err.code === 'UPSTREAM_ERROR');
        if (!downgrade || ctx.signal.aborted || (!wantL2 && !ctx.browser)) throw err;
        // 失败四分类：只有真风控（RISK_CONTROL）进熔断记账。接口侧 5xx/404（含作品已删）
        // 照常降级，但不污染熔断计数，否则「删了一个视频」会让整条 HTTP 通道被粘住 60s
        l1RiskControl = err instanceof AppError && err.code === 'RISK_CONTROL';
        lastErr = err as AppError;
      }
    }

    // L2：签名通道（纯 HTTP，零浏览器）。身份/ttwid 拿不到视为通道不可用，直接落 L3
    let viaL2 = false;
    if (wantL2) {
      const identity = await resolveL2Identity(ctx);
      if (identity) {
        viaL2 = true;
        if (!skipL1) {
          // L1 失效进熔断记账（仅真风控）：连续达阈值后粘住 L2/浏览器（半开态探针由 shouldSkipHttp 控制）
          recordChannelDowngrade('douyin', 'http-l1', 'http-l2');
          if (l1RiskControl) recordHttpRiskControl('douyin');
        }
        try {
          const raw = await fetchViaSigned(input, ctx, identity);
          if (identity.pooled) uifidPool.reportSuccess(identity.uifid);
          return raw;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          lastErr = err as AppError;
          // 签名失效/静默拒绝 = 怀疑池子里的身份用废（env 固定身份只记日志，换不换由运维定）
          if (identity.pooled && err instanceof AppError && err.code === 'UPSTREAM_CHANGED') {
            uifidPool.reportSuspect(identity.uifid);
          }
          ctx.logger.warn('douyin L2 failed, downgrade to browser channel', {
            id: input.id,
            code: lastErr.code,
            identity: identity.pooled ? 'pool' : 'env',
          });
        }
      }
    }

    // L3：浏览器兜底
    if (!ctx.browser) throw lastErr ?? new AppError('UPSTREAM_ERROR', '抖音无可用取数通道');
    if (viaL2) recordChannelDowngrade('douyin', 'http-l2', 'browser');
    else if (!skipL1) {
      recordChannelDowngrade('douyin', 'http', 'browser');
      if (l1RiskControl) recordHttpRiskControl('douyin');
    }
    return fetchViaBrowser(input, url, ctx);
  },

  parse: parseAweme,
};
