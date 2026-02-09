import type { Context } from "elysia";
import { xiaohongshuCache } from "@/controllers/core/xiaohongshu";

interface CacheStatsResponse {
  success: boolean;
  data: {
    size: number;
    keys: string[];
    ttl: number;
  };
  message: string;
}

interface CacheActionResponse {
  success: boolean;
  message: string;
  data?: {
    size: number;
  };
}

/**
 * 获取缓存统计信息
 */
export async function getCacheStats({
  body,
}: Context): Promise<CacheStatsResponse> {
  try {
    const stats = xiaohongshuCache.getStats();

    return {
      success: true,
      data: {
        ...stats,
        ttl: 3600000, // 1小时，单位：毫秒
      },
      message: "获取缓存统计信息成功",
    };
  } catch (error) {
    console.error("获取缓存统计信息失败:", error);
    return {
      success: false,
      data: {
        size: 0,
        keys: [],
        ttl: 0,
      },
      message: "获取缓存统计信息失败",
    };
  }
}

/**
 * 清空所有缓存
 */
export async function clearAllCache({
  body,
}: Context): Promise<CacheActionResponse> {
  try {
    xiaohongshuCache.clear();

    return {
      success: true,
      message: "已清空所有缓存",
      data: {
        size: 0,
      },
    };
  } catch (error) {
    console.error("清空缓存失败:", error);
    return {
      success: false,
      message: "清空缓存失败",
    };
  }
}

/**
 * 删除指定URL的缓存
 */
export async function deleteCache({
  body,
}: Context): Promise<CacheActionResponse> {
  try {
    const { url } = body as { url: string };

    if (!url) {
      return {
        success: false,
        message: "请提供要删除的URL",
      };
    }

    xiaohongshuCache.delete(url);

    // 获取删除后的缓存大小
    const stats = xiaohongshuCache.getStats();

    return {
      success: true,
      message: `已删除URL缓存: ${url}`,
      data: {
        size: stats.size,
      },
    };
  } catch (error) {
    console.error("删除缓存失败:", error);
    return {
      success: false,
      message: "删除缓存失败",
    };
  }
}
