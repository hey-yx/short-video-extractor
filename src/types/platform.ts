/**
 * 平台无关的统一数据模型。
 * 平台适配层（src/platforms/**）的 parse() 输出此结构；对外 API 直接序列化它。
 */

export type Platform =
  'douyin' | 'xhs' | 'kuaishou' | 'bilibili' | 'weibo' | 'twitter' | 'youtube' | 'instagram' | 'tiktok';

type AssetType = 'video' | 'image' | 'audio' | 'cover';

/** 同一资源的不同档位（抖音：540p/720p/1080p/origin） */
export interface AssetVariant {
  /** 档位标识：540p / 720p / 1080p / origin / hd 等 */
  ratio: string;
  url: string;
  size?: number;
  width?: number;
  height?: number;
  /** 该档位是否带平台水印 */
  watermark?: boolean;
}

export interface MediaAsset {
  type: AssetType;
  /** 直连地址（客户端不带 Referer 即可下载） */
  url: string;
  /** 该资源的过期时刻（Unix 秒）；读不出则省略 */
  expiresAt?: number;
  size?: number;
  width?: number;
  height?: number;
  /** 时长（毫秒），视频/实况有效 */
  durationMs?: number;
  /** 备用 CDN 地址 */
  backups?: string[];
  /** 同一资源的其他档位直链 */
  variants?: AssetVariant[];
  /** 实况照片的 5s 视频直链（抖音图集） */
  liveClipUrl?: string;
  /** 封面图（视频类资源附带） */
  coverUrl?: string;
  /** 音频直链（B 站 DASH 音视频分离时的伴音轨，下载端需与视频分别拉取后合成） */
  audioUrl?: string;
  /** 多 P 视频的分 P 标题（B 站 pages[].part） */
  partTitle?: string;
}

export interface ParsedAuthor {
  name: string;
  avatar?: string;
  /** 平台内用户标识（sec_uid / userId 等） */
  id?: string;
}

export interface ParseResult {
  platform: Platform;
  /** 平台内稳定 ID（aweme_id / noteId / photoId / bvid），缓存 key 与日志用 */
  id: string;
  kind: 'video' | 'album' | 'unknown';
  title: string;
  /** 正文/描述（抖音的 desc 常含 tag，与 title 分开给） */
  description?: string;
  tags?: string[];
  author: ParsedAuthor;
  /** 视频/图集主资源列表 */
  assets: MediaAsset[];
  /** 所有资源里最早过期的时刻（Unix 秒） */
  expiresAt?: number;
  /** 解析时刻（Unix 秒） */
  parsedAt: number;
  /** 解析通道，指标与降级归因用：http-l2 = 抖音签名通道（L1 风控时的纯 HTTP 降级） */
  via: 'http' | 'http-l2' | 'browser';
}

/** 平台声明：能解析什么 URL、走什么通道 */
interface Capabilities {
  /** 纯 HTTP 能否完成 */
  http: boolean;
  /** 需要浏览器兜底/主力 */
  browser: boolean;
  /** 需要浏览器级 TLS 指纹（小红书） */
  tlsImpersonation: boolean;
  kinds: ReadonlyArray<ParseResult['kind']>;
}

/** registry.match() 的结果：纯数据，不含行为 */
export interface MatchResult {
  platform: Platform;
  id: string;
  kind: ParseResult['kind'];
  /** 短链需要先展开 */
  needsResolve: boolean;
  /** 必须原样保留的查询参数（xsec_token 等） */
  params?: Record<string, string>;
}

/** IO 上下文：超时/取消/客户端都从这里进，平台包不自己造 */
export interface FetchCtx {
  signal: AbortSignal;
  channel: 'http' | 'browser';
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  /** channel==='browser' 时由 infra 注入的页面操作接口（不暴露 puppeteer 类型） */
  browser?: {
    /** 导航并截取主文档 HTML（小红书用；hydration 前抢快照） */
    getDocumentHtml(url: string, timeoutMs: number): Promise<string>;
    /**
     * 导航后监听 response，截取 urlIncludes 命中的 XHR JSON（抖音兜底用）。
     * 首个命中即返回解析后的 body；signal 取消时立即中止导航与等待。
     */
    interceptJson(
      url: string,
      urlIncludes: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<unknown>;
    /**
     * 开页等 cookie 就位后回收（uifid 自动铸造用：douyin 的 JS 挑战约 8s 后种下 UIFID_TEMP）。
     * waitFor.name 出现即返回全部 cookie；超时也返回当下的（拿不到就拿不到，调用方降级）。
     */
    collectCookies?(
      url: string,
      waitFor: { name: string; timeoutMs: number },
      signal?: AbortSignal,
    ): Promise<Record<string, string>>;
  };
  /**
   * 海外平台出站代理（http://host:port）。
   * 由 app/routes 层从 env 读出注入（resolveProxy：PROXY_<PLATFORM> 覆盖 → HTTPS_PROXY），
   * 平台包不读 env；平台侧经 src/core/fetch-proxy.ts 的 proxiedFetch 使用；未配置 = 直连。
   * YouTube 直链绑 IP：解析与 /media 中转必须用同一个值。
   */
  proxyUrl?: string;
  /**
   * Instagram 匿名 GraphQL doc_id（IG 前端发版会轮换，必须配置化）。
   * 由 routes 层从 env IG_GRAPHQL_DOC_ID 读出注入；平台包不读 env；未配置时 IG adapter 给可懂报错。
   */
  instagramDocId?: string;
  /**
   * 抖音 L2 签名通道的访客身份 uifid（浏览器一次性铸造后配到 env DOUYIN_UIFID）。
   * 由 routes 层从 env 读出注入；平台包不读 env；未配置时抖音 adapter 跳过 L2 直落浏览器兜底。
   */
  douyinUifid?: string;
  /**
   * 抖音 L2 的 ttwid（可选，env DOUYIN_TTWID）；缺省由平台侧经 abogus getTtwid() 现铸。
   * ttwid 与 uifid 同身份体系，铸造 uifid 时的 ttwid 一起配进来最稳。
   */
  douyinTtwid?: string;
}

/** 平台原始载荷：可 JSON 序列化，fixture 才能录制回放 */
export interface RawPayload {
  via: 'api' | 'html-embedded-json' | 'browser-intercept';
  fetchedAt: number;
  body: unknown;
  /** 实际取数通道：http = 纯 HTTP（L1），http-l2 = 签名通道（L1 风控时的纯 HTTP 降级），
   * browser = 浏览器兜底（adapter 降级后如实标注） */
  channel: 'http' | 'http-l2' | 'browser';
}

/**
 * 平台适配器三条硬约束：
 *  1. match() 必须是纯函数
 *  2. fetch() 是唯一允许 IO 的方法
 *  3. parse() 必须是纯函数（同输入同输出，可 fixture 回归）
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly description: string;
  /** host 白名单，兼作 SSRF 第一道闸 */
  readonly hosts: readonly string[];
  readonly capabilities: Capabilities;

  match(url: URL): MatchResult | null;

  /** 短链展开：只解析一跳，返回最终 URL */
  resolve?(url: URL, ctx: FetchCtx): Promise<URL>;

  fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload>;

  parse(raw: RawPayload, input: MatchResult): ParseResult;
}
