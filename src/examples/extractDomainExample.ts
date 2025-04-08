import { extractMainDomain } from "../utils/extractUrl";

/**
 * 示例：从小红书链接中提取主域名
 */
function extractXiaohongshuDomain() {
	// 小红书链接示例
	const xiaohongshuUrl =
		"https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b?source=webshare&xhsshare=pc_web&xsec_token=ABfemsqINCwKNtr4SHbyFr5Wi2t8cKp7f3Uyu_JI5exGI=&xsec_source=pc_share";

	// 提取主域名
	const mainDomain = extractMainDomain(xiaohongshuUrl);

	console.log("小红书链接示例:");
	console.log("----------------------------------------");
	console.log(`原始URL: ${xiaohongshuUrl}`);
	console.log(`提取的主域名: ${mainDomain}`);
	console.log("----------------------------------------");

	// 其他平台链接示例
	const otherUrls = [
		"https://www.douyin.com/video/7123456789",
		"https://www.kuaishou.com/short-video/abcdef123456",
		"https://www.bilibili.com/video/BV1xx411c7mD",
		"https://www.zhihu.com/question/123456789",
		"https://www.weibo.com/1234567890/abcdef123456",
	];

	console.log("其他平台链接示例:");
	console.log("----------------------------------------");

	for (const url of otherUrls) {
		const domain = extractMainDomain(url);
		console.log(`平台: ${domain}`);
		console.log(`原始URL: ${url}`);
		console.log("----------------------------------------");
	}
}

// 运行示例
extractXiaohongshuDomain();
