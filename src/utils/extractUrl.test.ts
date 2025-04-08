import {
	extractMainDomain,
	extractUrl,
	extractAllUrls,
	isValidUrl,
} from "./extractUrl";

// 测试extractMainDomain函数
console.log("测试extractMainDomain函数:");
console.log("----------------------------------------");

const testUrls = [
	"https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b",
	"https://m.xiaohongshu.com/discovery/item/67e27d88000000000603a36b",
	"https://api.xiaohongshu.com/v1/users",
	"https://xiaohongshu.com/discovery/item/67e27d88000000000603a36b",
	"https://sub1.sub2.xiaohongshu.com/discovery/item/67e27d88000000000603a36b",
	"https://example.com",
	"https://www.example.co.uk",
	"https://invalid-url",
	"not-a-url",
	"",
];

for (const url of testUrls) {
	const mainDomain = extractMainDomain(url);
	console.log(`URL: ${url}`);
	console.log(`主域名: ${mainDomain}`);
	console.log("----------------------------------------");
}

// 测试extractUrl函数
console.log("测试extractUrl函数:");
console.log("----------------------------------------");

const textWithUrl =
	"这是一个包含URL的文本 https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b 这是URL后面的文本";
const extractedUrl = extractUrl(textWithUrl);
console.log(`文本: ${textWithUrl}`);
console.log(`提取的URL: ${extractedUrl}`);
console.log("----------------------------------------");

// 测试extractAllUrls函数
console.log("测试extractAllUrls函数:");
console.log("----------------------------------------");

const textWithMultipleUrls =
	"这是第一个URL https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b 这是第二个URL https://www.example.com";
const extractedUrls = extractAllUrls(textWithMultipleUrls);
console.log(`文本: ${textWithMultipleUrls}`);
console.log(`提取的所有URL: ${JSON.stringify(extractedUrls)}`);
console.log("----------------------------------------");

// 测试isValidUrl函数
console.log("测试isValidUrl函数:");
console.log("----------------------------------------");

const urlsToValidate = [
	"https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b",
	"http://example.com",
	"https://example.com",
	"ftp://example.com",
	"not-a-url",
	"",
];

for (const url of urlsToValidate) {
	const isValid = isValidUrl(url);
	console.log(`URL: ${url}`);
	console.log(`是否有效: ${isValid}`);
	console.log("----------------------------------------");
}
