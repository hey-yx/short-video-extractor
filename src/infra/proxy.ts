import type { Platform } from '@/types/platform';

/**
 * 出站代理解析：PROXY_<PLATFORM> 覆盖 → HTTPS_PROXY 兜底。
 * 只给海外平台用（youtube 等）；国内四平台保持直连，不走这里。
 * YouTube 直链绑 IP：解析（adapter fetch）与 /media 中转（fetchUpstream）必须拿到同一个值。
 * 代理串只认 http://（Bun proxy 选项不支持 socks5）；部署机别设 NO_PROXY（实测会拦掉显式 proxy）。
 */
export function resolveProxy(platform: Platform): string | undefined {
  return process.env[`PROXY_${platform.toUpperCase()}`] || process.env.HTTPS_PROXY;
}
