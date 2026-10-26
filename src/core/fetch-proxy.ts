/**
 * 可选代理的 fetch 包装（海外平台出站通道，YouTube 等后续平台复用）。
 *
 * 2026-10-26 实测（Bun 1.3.10）：
 *  - Bun fetch 不读 HTTPS_PROXY/HTTP_PROXY 环境变量（坏端口 env 下请求仍成功，本机 TUN 接管掩盖了常规验证）；
 *  - 但 per-request `proxy` 选项真实生效（坏端口 proxy 下请求失败）。
 * 因此部署在中国云服务器需要出站代理时，代理必须显式传入：
 *  - app/routes 层从 env（PROXY_<PLATFORM> 覆盖 → OUTBOUND_PROXY → HTTPS_PROXY）读出代理串，注入 FetchCtx.proxyUrl；
 *  - 平台包只经 ctx 拿字符串，不读 env（平台层硬约束）；
 *  - 未配置代理时本包装与裸 fetch 行为一致（直连）。
 *  - YouTube 直链绑出口 IP：解析与 /media 中转必须拿到同一个代理值（resolveProxy 同源）。
 */

export type ProxyFetchInit = RequestInit & {
  /** 代理串（http://host:port）；空/undefined = 直连 */
  proxy?: string;
};

export async function proxiedFetch(url: string | URL, init: ProxyFetchInit = {}): Promise<Response> {
  const { proxy, ...rest } = init;
  const headers = new Headers(rest.headers);
  // 媒体与 API 一律不压缩：压缩响应会让 Range/字节语义错乱（media-proxy 实测坑 3 的同源经验）
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  const options = { ...rest, headers } as RequestInit;
  if (proxy) {
    (options as RequestInit & { proxy: string }).proxy = proxy;
  }
  return fetch(url, options);
}
