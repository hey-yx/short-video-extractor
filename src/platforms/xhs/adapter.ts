import { AppError } from '@/core/errors';
import { recordChannelDowngrade } from '@/infra/metrics';
import { recordHttpRiskControl, shouldSkipHttp } from '@/infra/channel-policy';
import type { FetchCtx, MatchResult, PlatformAdapter, RawPayload } from '@/types/platform';
import { noteDataVerdict, parseNote } from './parse';

/** noteId：24 位十六进制（/explore/<id> 与 /discovery/item/<id>） */
const NOTE_ID_RE = /\/(?:explore|discovery\/item)\/([0-9a-f]{24})/;
const SHORT_HOSTS = new Set(['xhslink.com', 'xhslink.cn']);

/**
 * 放行门三件套（docs/research/04 §2 实测矩阵）：UA 必须浏览器形态、Accept 必须在场且不能是通配符、
 * Accept-Language 必须在场。TLS 指纹无关（Chrome 级指纹客户端缺这三头照样 302）。
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9',
};

/** HTTP 通道单跳超时（实测单次 0.2–0.5s；总耗时仍受 ctx.signal 15s 兜底） */
const BROWSER_TIMEOUT_MS = 12_000;
/** 登录墙重试上限：换连接重试 1 次（调研 §4.2），连续 2 次 → 浏览器兜底 */
const LOGINWALL_RETRIES = 1;

/** fetch 注入点：离线单测换假通道（真通道 = Bun 原生 fetch，零依赖零二进制） */
export type XhsFetchClient = (url: string, init: RequestInit) => Promise<Response>;
let client: XhsFetchClient = (url, init) => fetch(url, init);
export function setXhsClientForTests(next: XhsFetchClient): void {
  client = next;
}

/** 302 Location 分类：IP 风控 / token 失效之外的落点一律按登录墙处理 */
function classifyRedirect(location: string): 'loginwall' | 'ip-risk' | 'token-invalid' {
  if (location.includes('error_code=300012')) return 'ip-risk';
  if (location.includes('error_code=300031')) return 'token-invalid';
  return 'loginwall';
}

/** note 页地址：长链原样（保住全部查询参数）；短链/无 token 时按 id + params 拼最小形态 */
function noteUrl(input: MatchResult, url: URL): string {
  if (url.hostname.endsWith('xiaohongshu.com') && NOTE_ID_RE.test(url.href)) {
    return url.href;
  }
  const path = input.id ? `/explore/${input.id}` : '/explore';
  const token = input.params?.xsec_token;
  return token
    ? `https://www.xiaohongshu.com${path}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_share`
    : `https://www.xiaohongshu.com${path}`;
}

/** 纯 HTTP 通道：三件套头直抓主文档，登录墙换连接重试 1 次（调研 §4.2） */
async function fetchViaHttp(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
  const target = noteUrl(input, url);
  let loginwall = 0;
  for (;;) {
    let res: Response;
    try {
      res = await client(target, {
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: ctx.signal,
      });
    } catch (err) {
      // 网络层失败归一成 UPSTREAM_TIMEOUT（parse.service 据此重试）；请求被取消则原样上抛
      if (ctx.signal.aborted) throw err;
      throw new AppError('UPSTREAM_TIMEOUT', '小红书接口网络错误或超时', { err: String(err).slice(0, 120) });
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel();
      const loc = res.headers.get('location') ?? '';
      const kind = classifyRedirect(loc);
      if (kind === 'ip-risk') {
        // IP 风控独立维度（§2.4）：与请求头无关，换连接重试无意义
        throw new AppError('RISK_CONTROL', '小红书风控拦截（出口 IP 被平台限制，换网络后重试）', {
          noteId: input.id || undefined,
        });
      }
      if (kind === 'token-invalid') {
        // token 失效/与 noteId 不配对（§2.4）：重试与降级都拿不回 token，如实报错
        throw new AppError('CONTENT_NOT_FOUND', '笔记链接无效或已过期（xsec_token 失效）', {
          noteId: input.id || undefined,
        });
      }
      loginwall += 1;
      if (loginwall > LOGINWALL_RETRIES) {
        throw new AppError('UPSTREAM_ERROR', '小红书登录墙（HTTP 通道请求头被拒）', {
          noteId: input.id || undefined,
          status: res.status,
          location: loc.slice(0, 120),
        });
      }
      continue;
    }
    const html = await res.text();
    // 200 载荷预判（调研 §4.2 降级契约）：壳页/风控页在这里就能定性，等 parse 阶段再抛就错过降级分支了。
    // 风控页 RISK_CONTROL 直接上抛（降级无意义，fetch 阶段抛才进熔断记账+止血窗口）；
    // 壳页/笔记数据空抛 UPSTREAM_CHANGED 交浏览器验证（只有浏览器分得清壳页与已删除），仅在有浏览器时拦。
    // 无浏览器时不过早定性：原样交 parseNote 分类，纯 HTTP 部署的错误码与文案保持不变
    const verdict = noteDataVerdict(html, input.id);
    if (verdict === 'risk') {
      throw new AppError('RISK_CONTROL', '小红书风控拦截（出口 IP 被平台限制或未登录，换网络后重试）', {
        noteId: input.id || undefined,
      });
    }
    if (ctx.browser && (verdict === 'shell' || verdict === 'empty')) {
      throw new AppError('UPSTREAM_CHANGED', '小红书返回壳页/笔记数据为空，交浏览器验证', {
        noteId: input.id || undefined,
      });
    }
    return {
      via: 'browser-intercept',
      fetchedAt: Math.floor(Date.now() / 1000),
      body: html,
      channel: 'http',
    };
  }
}

/** 浏览器兜底：沿用原主通道的「真实 Chrome 导航 + hydration 前截主文档」 */
async function fetchViaBrowser(url: URL, ctx: FetchCtx): Promise<RawPayload> {
  if (!ctx.browser) {
    throw new AppError('UPSTREAM_ERROR', '小红书 HTTP 通道失败，且浏览器兜底通道不可用');
  }
  const html = await ctx.browser.getDocumentHtml(url.href, BROWSER_TIMEOUT_MS);
  if (!html) {
    throw new AppError('UPSTREAM_CHANGED', '浏览器未截到主文档 HTML');
  }
  return {
    via: 'browser-intercept',
    fetchedAt: Math.floor(Date.now() / 1000),
    body: html,
    channel: 'browser',
  };
}

export const xhsAdapter: PlatformAdapter = {
  platform: 'xhs',
  description: '小红书：纯 HTTP 直抓 __INITIAL_STATE__（请求头三件套放行），风控时自动降级浏览器',
  hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  capabilities: {
    http: true,
    browser: true,
    tlsImpersonation: false,
    kinds: ['video', 'album'],
  },

  match(url: URL): MatchResult | null {
    if (SHORT_HOSTS.has(url.hostname)) {
      // 短链：xhslink.com/.cn 裸 HTTP 302 即可展开（调研 §2.4），Location 自带配对 xsec_token
      return { platform: 'xhs', id: '', kind: 'unknown', needsResolve: true };
    }
    const m = url.href.match(NOTE_ID_RE);
    if (!m?.[1]) return null;
    const token = url.searchParams.get('xsec_token');
    return {
      platform: 'xhs',
      id: m[1],
      kind: 'unknown',
      needsResolve: false,
      params: token ? { xsec_token: token } : undefined,
    };
  },

  async resolve(url: URL, ctx: FetchCtx): Promise<URL> {
    let res: Response;
    try {
      res = await client(url.href, {
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: ctx.signal,
      });
    } catch (err) {
      // 同 fetchViaHttp：网络层失败归一 UPSTREAM_TIMEOUT，取消原样上抛
      if (ctx.signal.aborted) throw err;
      throw new AppError('UPSTREAM_TIMEOUT', '小红书短链展开网络错误或超时', {
        err: String(err).slice(0, 120),
      });
    }
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc) {
      throw new AppError('INVALID_URL', '小红书短链未返回跳转地址', { url: url.href, status: res.status });
    }
    return new URL(loc);
  },

  async fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload> {
    // 熔断粘性：HTTP 通道连续被拒期间直接走浏览器，不再每请求先吃两连 302（半开态探针放行）
    if (ctx.browser && shouldSkipHttp('xhs')) {
      ctx.logger.warn('xhs circuit sticky: skip http channel, go browser directly', { id: input.id });
      return fetchViaBrowser(url, ctx);
    }
    try {
      return await fetchViaHttp(input, url, ctx);
    } catch (err) {
      // 降级判定（调研 §4.2）：登录墙（头被拒）与 200 壳页（UPSTREAM_CHANGED）交浏览器验证；
      // IP 风控/token 失效降级无意义，如实上抛；无浏览器环境、信号已取消时原样上抛
      const downgrade =
        err instanceof AppError && (err.code === 'UPSTREAM_ERROR' || err.code === 'UPSTREAM_CHANGED');
      if (!downgrade || !ctx.browser || ctx.signal.aborted) {
        throw err;
      }
      ctx.logger.warn('xhs http channel risk signal, downgrade to browser channel', { id: input.id });
      recordChannelDowngrade('xhs', 'http', 'browser');
      // 失败四分类：登录墙（UPSTREAM_ERROR，身份被拒）才算风控进熔断记账；
      // 200 壳页/结构变更（UPSTREAM_CHANGED）是改版信号，降级验证即可，不该粘住 HTTP 通道
      if (err instanceof AppError && err.code === 'UPSTREAM_ERROR') recordHttpRiskControl('xhs');
      return fetchViaBrowser(url, ctx);
    }
  },

  parse: parseNote,
};
