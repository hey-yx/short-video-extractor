import type { Platform } from '@/types/platform';

/** 平台域名白名单（registry.match 的数据源；新增平台只改这里 + 加目录） */
export const PLATFORM_HOSTS: Record<Platform, readonly string[]> = {
  douyin: ['douyin.com', 'iesdouyin.com', 'v.douyin.com'],
  xhs: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  kuaishou: ['kuaishou.com', 'chenzhongtech.com', 'v.kuaishou.com'],
  bilibili: ['bilibili.com', 'b23.tv'],
  weibo: ['weibo.com', 'weibo.cn', 'weibo.com.cn', 't.cn'],
  // twitter.com 覆盖 mobile.twitter.com；x.com 覆盖 v.x.com（后缀匹配）；t.co 短链展开走通用 resolve
  twitter: ['x.com', 'twitter.com', 't.co'],
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  // instagr.am 301 到 instagram.com（实测），但分享口令可能直接带原始短域
  instagram: ['instagram.com', 'instagr.am'],
  // vm./vt. 已被 tiktok.com 后缀覆盖，单列对齐分享域；短链展开走通用 resolve
  tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
};

/** host 是否属于平台（后缀匹配：news.douyin.com ∈ douyin.com） */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** 从 URL 找所属平台；找不到返回 null */
export function findPlatform(url: URL): Platform | null {
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS) as [Platform, readonly string[]][]) {
    for (const h of hosts) {
      if (hostMatches(url.hostname, h)) return platform;
    }
  }
  return null;
}
