/**
 * 签名器契约与注册表（P0-1，来自同类项目调研 yt-dlp PO Token Provider 的做法）。
 *
 * 背景：平台的签名算法藏在它自己的 JS 里，会随版本升级换掉（bdms 升级 → x-secsdk-web-signature
 * 算法过期，全线 403）。把「怎么算签名」抽成可替换的 provider，算法过期时换一个实现、注册进来，
 * adapter 与编排层一行不改。provider 声明自己的算法版本，漂移检测与日志归因都看它。
 *
 * 选择规则：同平台按 priority 降序，取第一个 isAvailable() 的；都没有则返回 null，
 * 调用方（platforms/douyin/signing.ts）回落到内置默认实现，保证零注册也能跑。
 */

import type { Platform } from '@/types/platform';

/** 待签名请求：规范业务 URL（query 已含业务参数），身份与时间戳随请求给 */
export interface UnsignedRequest {
  url: string;
  /** UIFID_TEMP cookie 值 */
  uifid: string;
  /** 签名时间戳（Unix 秒）；缺省当前秒。可注入以便单测固定签名 */
  timestamp?: number;
}

/** 签名结果：最终请求 URL 与请求头。签名放 URL 还是放 header 由算法决定，provider 说了算 */
export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface SignerProvider {
  /** 实现名（如 'abogus'），指标与日志归因用 */
  readonly name: string;
  readonly platform: Platform;
  /** 算法/依赖版本标识（如 'abogus@2.1.1'），过期排查看这个 */
  readonly version: string;
  /** 自检：本实现当前能不能产出可信签名（依赖可用、配置在位） */
  isAvailable(): boolean;
  /** 算签名：产出最终 URL 与签名相关的请求头 */
  signRequest(req: UnsignedRequest): SignedRequest;
  /** 铸访客 cookie（ttwid 等）；不可用或铸造失败返回 null，调用方跳过该通道 */
  mintTtwid?(signal?: AbortSignal): Promise<string | null>;
}

interface Entry {
  provider: SignerProvider;
  priority: number;
}

const registry = new Map<Platform, Entry[]>();

/** 注册签名器；priority 高者优先（默认 0）。同优先级后注册的排前（热替换语义）。
 * 同名重复注册视为替换（保留一次，便于重启式热加载）。 */
export function registerSigner(provider: SignerProvider, opts: { priority?: number } = {}): void {
  const list = (registry.get(provider.platform) ?? []).filter((e) => e.provider.name !== provider.name);
  list.unshift({ provider, priority: opts.priority ?? 0 });
  list.sort((a, b) => b.priority - a.priority);
  registry.set(provider.platform, list);
}

/** 按优先级取第一个可用的签名器 */
export function pickSigner(platform: Platform): SignerProvider | null {
  for (const { provider } of registry.get(platform) ?? []) {
    if (provider.isAvailable()) return provider;
  }
  return null;
}

/** 某平台已注册的全部签名器（含不可用的），运维接口展示用 */
export function listSigners(platform: Platform): readonly SignerProvider[] {
  return (registry.get(platform) ?? []).map((e) => e.provider);
}

export function resetSignersForTests(): void {
  registry.clear();
}
