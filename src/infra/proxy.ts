import type { Platform } from '@/types/platform';

/**
 * 出站代理解析（全局唯一）：PROXY_<PLATFORM> 覆盖 → OUTBOUND_PROXY → HTTPS_PROXY 兜底。
 * 只给海外平台用（youtube 等）；国内四平台保持直连，不走这里。
 * YouTube 直链绑 IP：解析（adapter fetch）与 /media 中转（fetchUpstream）必须拿到同一个值。
 */
export function resolveProxy(platform: Platform): string | undefined {
  return (
    process.env[`PROXY_${platform.toUpperCase()}`] || process.env.OUTBOUND_PROXY || process.env.HTTPS_PROXY
  );
}
