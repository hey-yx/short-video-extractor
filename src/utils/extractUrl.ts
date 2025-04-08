/**
 * 从文本中提取URL
 * 该函数可以从包含URL的文本中提取出URL，即使URL前后有其他文字
 *
 * @param text 包含URL的文本
 * @returns 提取出的URL，如果没有找到URL则返回null
 */
export function extractUrl(text: string): string | null {
	if (!text) return null;

	// URL正则表达式，匹配http(s)://开头的URL
	const urlRegex = /(https?:\/\/[^\s]+)/g;

	// 查找所有匹配的URL
	const matches = text.match(urlRegex);

	// 如果找到匹配的URL，返回第一个匹配项
	if (matches && matches.length > 0) {
		return matches[0];
	}

	return null;
}

/**
 * 从文本中提取所有URL
 * 该函数可以从包含多个URL的文本中提取出所有URL
 *
 * @param text 包含URL的文本
 * @returns 提取出的所有URL数组，如果没有找到URL则返回空数组
 */
export function extractAllUrls(text: string): string[] {
	if (!text) return [];

	// URL正则表达式，匹配http(s)://开头的URL
	const urlRegex = /(https?:\/\/[^\s]+)/g;

	// 查找所有匹配的URL
	const matches = text.match(urlRegex);

	// 如果找到匹配的URL，返回所有匹配项
	if (matches && matches.length > 0) {
		return matches;
	}

	return [];
}

/**
 * 验证URL是否有效
 * 该函数可以验证一个字符串是否是有效的URL
 *
 * @param url 要验证的URL
 * @returns 如果URL有效则返回true，否则返回false
 */
export function isValidUrl(url: string): boolean {
	if (!url) return false;

	try {
		new URL(url);
		return true;
	} catch (error) {
		return false;
	}
}

/**
 * 从URL中提取主域名
 * 该函数可以从URL中提取出主域名，例如从 https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b 中提取出 xiaohongshu.com
 *
 * @param url 要提取主域名的URL
 * @returns 提取出的主域名，如果URL无效或无法提取则返回null
 */
export function extractMainDomain(url: string): string | null {
	if (!url || !isValidUrl(url)) return null;

	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname;

		// 处理子域名情况，例如 www.xiaohongshu.com 提取为 xiaohongshu.com
		const parts = hostname.split(".");

		// 如果域名部分少于2个，则无法提取主域名
		if (parts.length < 2) return null;

		// 如果域名部分大于2个，可能是子域名，尝试提取主域名
		if (parts.length > 2) {
			// 检查是否是常见的二级域名前缀，如 www, m, api 等
			const commonSubdomains = [
				"www",
				"m",
				"api",
				"app",
				"dev",
				"test",
				"staging",
				"prod",
			];

			// 如果第一部分是常见的二级域名前缀，则返回后两部分
			if (commonSubdomains.includes(parts[0])) {
				return parts.slice(1).join(".");
			}

			// 否则返回最后两部分
			return parts.slice(-2).join(".");
		}

		// 如果只有两部分，直接返回
		return hostname;
	} catch (error) {
		return null;
	}
}
