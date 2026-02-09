interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CacheManager<T> {
  private cache: Map<string, CacheEntry<T>>;
  private ttl: number; // Time to live in milliseconds
  private cleanupInterval: ReturnType<typeof setInterval> | null;

  /**
   * 创建缓存管理器
   * @param ttl 缓存过期时间（毫秒），默认1小时
   * @param cleanupInterval 清理间隔（毫秒），默认10分钟
   */
  constructor(ttl: number = 3600000, cleanupInterval: number = 600000) {
    this.cache = new Map();
    this.ttl = ttl;
    this.cleanupInterval = null;

    // 启动定期清理过期缓存
    this.startCleanup(cleanupInterval);
  }

  /**
   * 生成缓存键
   * @param url 请求的URL
   * @returns 缓存键
   */
  private generateKey(url: string): string {
    // 标准化URL：移除查询参数中的时间戳等动态参数
    try {
      const urlObj = new URL(url);
      // 移除一些动态查询参数
      const paramsToRemove = [
        "xhsshare",
        "xsec_token",
        "xsec_source",
        "source",
        "timestamp",
        "_t",
      ];
      paramsToRemove.forEach((param) => {
        urlObj.searchParams.delete(param);
      });
      return urlObj.toString();
    } catch {
      return url;
    }
  }

  /**
   * 获取缓存
   * @param url 请求的URL
   * @returns 缓存的数据，如果不存在或已过期则返回null
   */
  get(url: string): T | null {
    const key = this.generateKey(url);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      // 缓存已过期，删除
      this.cache.delete(key);
      return null;
    }

    console.log(`命中缓存: ${key}`);
    return entry.data;
  }

  /**
   * 设置缓存
   * @param url 请求的URL
   * @param data 要缓存的数据
   */
  set(url: string, data: T): void {
    const key = this.generateKey(url);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
    };
    this.cache.set(key, entry);
    console.log(`已缓存: ${key}`);
  }

  /**
   * 删除指定URL的缓存
   * @param url 请求的URL
   */
  delete(url: string): void {
    const key = this.generateKey(url);
    this.cache.delete(key);
    console.log(`已删除缓存: ${key}`);
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    console.log(`🧹 已清空所有缓存，共 ${size} 条`);
  }

  /**
   * 清理过期的缓存条目
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 清理了 ${cleanedCount} 条过期缓存`);
    }
  }

  /**
   * 启动定期清理
   * @param interval 清理间隔（毫秒）
   */
  private startCleanup(interval: number): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, interval);
  }

  /**
   * 停止定期清理
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * 检查缓存是否存在且有效
   * @param url 请求的URL
   * @returns 如果缓存存在且未过期返回true
   */
  has(url: string): boolean {
    const key = this.generateKey(url);
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }
}
