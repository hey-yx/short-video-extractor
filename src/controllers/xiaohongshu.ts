import type { Context } from "elysia";
import puppeteer from "puppeteer";

interface Resource {
	type: string;
	url: string;
}

interface GroupedResource {
	type: string;
	urls: string[];
}

interface XiaohongshuResponse {
	success: boolean;
	data: {
		title: string;
		author: {
			name: string;
			url: string;
		};
		resources: GroupedResource[];
	};
	message: string;
}

export async function parseXiaohongshuContent({
	body,
}: Context): Promise<XiaohongshuResponse> {
	// 69 【(｡ì _ í｡) - anono0509 | 小红书 - 你的生活指南】 😆 YNcHCnx1kALpqZ1 😆 https://www.xiaohongshu.com/discovery/item/67e27d88000000000603a36b?source=webshare&xhsshare=pc_web&xsec_token=ABfemsqINCwKNtr4SHbyFr5Wi2t8cKp7f3Uyu_JI5exGI=&xsec_source=pc_share
	const { url } = body as { url: string };
	console.log("开始处理URL:", url);

	const resources: { type: string; url: string }[] = [];

	try {
		console.log("启动Puppeteer浏览器...");
		const browser = await puppeteer.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-accelerated-2d-canvas",
				"--disable-gpu",
				"--hide-scrollbars",
				"--disable-notifications",
				"--disable-extensions",
				"--force-color-profile=srgb",
				"--mute-audio",
				"--disable-background-timer-throttling",
				"--disable-backgrounding-occluded-windows",
				"--disable-breakpad",
				"--disable-component-extensions-with-background-pages",
				"--disable-features=TranslateUI,BlinkGenPropertyTrees",
				"--disable-ipc-flooding-protection",
				"--disable-renderer-backgrounding",
				"--enable-features=NetworkService,NetworkServiceInProcess",
				"--metrics-recording-only",
				"--no-default-browser-check",
				"--no-first-run",
				"--password-store=basic",
				"--use-mock-keychain",
				"--disable-web-security",
				"--disable-features=IsolateOrigins,site-per-process",
			],
		});
		const page = await browser.newPage();
		console.log("浏览器页面已创建");

		// 设置页面超时时间
		page.setDefaultTimeout(30000);

		// 设置 User-Agent
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		);

		// 设置额外的 HTTP 头
		await page.setExtraHTTPHeaders({
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			"sec-ch-ua":
				'"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"macOS"',
			"Upgrade-Insecure-Requests": "1",
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			"Accept-Encoding": "gzip, deflate, br",
			Connection: "keep-alive",
			"Cache-Control": "max-age=0",
		});

		// 注入脚本以绕过检测
		await page.evaluateOnNewDocument(() => {
			// 覆盖 webdriver 属性
			Object.defineProperty(navigator, "webdriver", {
				get: () => false,
			});

			// 覆盖 chrome 属性
			// @ts-ignore
			window.chrome = {
				runtime: {},
				loadTimes: () => {},
				csi: () => {},
				app: {},
			};

			// 添加语言和平台
			Object.defineProperty(navigator, "languages", {
				get: () => ["zh-CN", "zh", "en"],
			});

			Object.defineProperty(navigator, "platform", {
				get: () => "MacIntel",
			});

			// 添加插件
			Object.defineProperty(navigator, "plugins", {
				get: () => [1, 2, 3, 4, 5],
			});
		});

		// 存储视频 URL 的数组
		const videoUrls: string[] = [];
		let clickCount = 0; // 记录点击次数

		// 设置请求拦截
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const url = request.url();
			const resourceType = request.resourceType();

			if (url.includes(".xhscdn.com")) {
				// 检查是否是视频资源
				if (url.includes("sns-video-")) {
					if (!videoUrls.includes(url)) {
						videoUrls.push(url);
						// 根据URL特征判断资源类型
						const resourceType = url.includes("sign") ? "video" : "live";

						resources.push({
							type: resourceType,
							url: url,
						});
						console.log(`捕获到${resourceType}资源: ${url}`);
					}
				}

				// 检查是否是图片资源
				if (url.includes("sns-webpic-")) {
					if (!videoUrls.includes(url)) {
						videoUrls.push(url);
						resources.push({
							type: "image",
							url: url,
						});
						console.log(`捕获到image资源: ${url}`);
					}
				}
			}

			// 只拦截真正不需要的资源
			if (
				["font", "media", "xhr", "stylesheet", "ping", "beacon"].includes(
					resourceType,
				)
			) {
				request.abort();
			} else {
				request.continue();
			}
		});

		// 导航到目标URL
		await page.goto(url, {
			waitUntil: "networkidle2",
			timeout: 30000,
		});

		// 获取页面标题和作者信息
		const pageInfo = await page.evaluate(() => {
			// 获取标题
			const titleElement = document.querySelector("#detail-title");
			const title =
				titleElement?.textContent?.trim() ||
				document
					.querySelector("#detail-desc .note-text")
					?.textContent?.trim() ||
				"";

			// 获取作者信息
			const authorNameElement = document.querySelector(".author .username");
			const authorName = authorNameElement?.textContent?.trim() || "";

			const authorAvatarElement = document.querySelector(
				".author .avatar-item",
			);
			const authorAvatar = authorAvatarElement?.getAttribute("src") || "";

			return { title, authorName, authorAvatar };
		});

		// 更新作者信息
		const authorName = pageInfo.authorName;
		const authorUrl = pageInfo.authorAvatar;
		const title = pageInfo.title;

		console.log("获取到的页面信息:", { title, authorName, authorUrl });

		// 循环点击右侧按钮直到到达最后一页
		while (true) {
			clickCount++; // 增加点击次数

			// 获取总页数
			const totalPages = await page.evaluate(() => {
				const paginationItems = document.querySelectorAll(
					"#noteContainer #pagination-teleport-container .pagination-list .pagination-item",
				);
				return paginationItems.length || 1;
			});

			// 如果当前点击次数已经达到总页数，说明已经到达最后一页
			if (clickCount >= totalPages) {
				break;
			}

			// 检查并关闭登录面板
			const loginContainer = await page.$(".login-container");
			if (loginContainer) {
				const closeButton = await page.$(".login-container div");
				if (closeButton) {
					await closeButton.click();
					await page.evaluate(
						() => new Promise((resolve) => setTimeout(resolve, 300)),
					);
				}
			}

			// 点击右侧按钮
			await page.evaluate(() => {
				const rightBtn = document.querySelector(
					".slider-container .right .btn-wrapper",
				);
				if (rightBtn) {
					const clickEvent = new MouseEvent("click", {
						view: window,
						bubbles: true,
						cancelable: true,
					});
					rightBtn.dispatchEvent(clickEvent);
				}
			});

			// 等待新页面加载和视频资源请求完成
			await page.evaluate(
				() => new Promise((resolve) => setTimeout(resolve, 500)),
			);
		}

		// 计算需要捕获的资源数量
		const requiredCount = clickCount;

		// 等待捕获所有必要的资源
		let retryCount = 0;
		const maxRetries = 10 * clickCount;
		while (videoUrls.length < requiredCount && retryCount < maxRetries) {
			await page.evaluate(
				() => new Promise((resolve) => setTimeout(resolve, 100)),
			);
			retryCount++;
		}

		// 按类型重新组织资源
		const resourceMap = new Map<string, string[]>();

		// 将资源按类型分组
		for (const resource of resources) {
			// 如果是图片资源且包含 nd_prv_wlteh，则跳过
			if (resource.type === "image" && resource.url.includes("nd_prv_wlteh")) {
				continue;
			}

			if (!resourceMap.has(resource.type)) {
				resourceMap.set(resource.type, []);
			}
			resourceMap.get(resource.type)?.push(resource.url);
		}

		await browser.close();

		// 返回最终结果
		return {
			success: true,
			data: {
				title,
				author: {
					name: authorName,
					url: authorUrl,
				},
				resources: Array.from(resourceMap.entries()).map(([type, urls]) => ({
					type,
					urls,
				})) as GroupedResource[],
			},
			message: "获取小红书内容成功",
		} as XiaohongshuResponse;
	} catch (error) {
		console.error("使用Puppeteer直接获取作者信息失败:", error);
		return {
			success: false,
			data: {
				title: "",
				author: {
					name: "",
					url: "",
				},
				resources: [],
			},
			message: "获取小红书内容失败",
		} as XiaohongshuResponse;
	}
}
