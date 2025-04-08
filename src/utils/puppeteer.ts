import puppeteer, {
	type Browser,
	type Page,
	type HTTPRequest,
	type HTTPResponse,
} from "puppeteer";

class PuppeteerManager {
	private static instance: PuppeteerManager;
	private browser: Browser | null = null;
	private isResetting = false;

	private constructor() {}

	public static getInstance(): PuppeteerManager {
		if (!PuppeteerManager.instance) {
			PuppeteerManager.instance = new PuppeteerManager();
		}
		return PuppeteerManager.instance;
	}

	public async getBrowser(): Promise<Browser> {
		if (!this.browser) {
			this.browser = await this.initBrowser();
		}
		return this.browser;
	}

	private async initBrowser(): Promise<Browser> {
		return await puppeteer.launch({
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--window-size=1280,800",
			],
			defaultViewport: { width: 1280, height: 800 },
			timeout: 30000,
		});
	}

	private async checkLoginStatus(page: Page): Promise<boolean> {
		if (page.isClosed()) {
			throw new Error("页面已关闭");
		}

		return await page.evaluate(() => {
			const userEmail = document.querySelector("#showUserName");
			return userEmail?.textContent?.trim() === "business@itcox.cn";
		});
	}

	private async createPage(): Promise<Page | null> {
		const browser = await this.getBrowser();
		const page = await browser.newPage();

		// 设置页面超时时间为10秒
		page.setDefaultTimeout(10000);
		page.setDefaultNavigationTimeout(10000);

		// 设置视口大小为常见分辨率
		await page.setViewport({ width: 1366, height: 768 });

		// 启用 JavaScript
		await page.setJavaScriptEnabled(true);

		// 设置更真实的用户代理
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
		);

		// 设置更真实的浏览器指纹
		await page.evaluateOnNewDocument(() => {
			// 修改 navigator 属性
			Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
			Object.defineProperty(navigator, "webdriver", { get: () => false });
			Object.defineProperty(navigator, "languages", {
				get: () => ["zh-CN", "zh", "en"],
			});

			// 添加一些常见的浏览器插件
			Object.defineProperty(navigator, "plugins", {
				get: () => [
					{
						0: { type: "application/x-google-chrome-pdf" },
						description: "Portable Document Format",
						filename: "internal-pdf-viewer",
						length: 1,
						name: "Chrome PDF Plugin",
					},
					{
						0: { type: "application/pdf" },
						description: "Portable Document Format",
						filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
						length: 1,
						name: "Chrome PDF Viewer",
					},
				],
			});
		});

		try {
			// 导航到目标页面，使用更真实的加载策略
			await page.goto("https://www.jiexiapi.top/", {
				waitUntil: "domcontentloaded", // 使用更快的加载策略
				timeout: 10000,
			});

			// 等待页面加载完成
			await page.waitForFunction(() => document.readyState === "complete", {
				timeout: 10000,
			});

			// 模拟真实用户的鼠标移动
			await page.mouse.move(Math.random() * 1366, Math.random() * 768);

			// 模拟真实用户的滚动行为
			await page.evaluate(() => {
				window.scrollTo(0, Math.random() * 100);
				setTimeout(() => {
					window.scrollTo(0, 0);
				}, 500);
			});

			return page;
		} catch (error) {
			console.error(
				`[Puppeteer] 页面创建失败: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (!page.isClosed()) {
				await page.close();
			}
			return null;
		}
	}

	public async createNewPage(c = true): Promise<Page | null> {
		// 创建新页面
		let page = await this.createPage();

		// 如果页面创建失败，直接返回 null
		if (!page) {
			return null;
		}

		// 检查登录状态
		const isLoggedIn = await this.checkLoginStatus(page);
		if (!isLoggedIn) {
			// 最多重试3次
			let retryCount = 0;
			const maxRetries = 3;
			let loginSuccess = false;

			while (retryCount < maxRetries && !loginSuccess) {
				try {
					// 直接在当前页面登录
					await this.login(page);

					// 登录成功后，如果 c 为 true，创建新页面用于后续操作
					if (c) {
						const newPage = await this.createPage();
						// 如果新页面创建失败，返回 null
						if (!newPage) {
							return null;
						}
						// 再次检查登录状态
						const finalLoginStatus = await this.checkLoginStatus(newPage);
						if (!finalLoginStatus) {
							console.error("[Puppeteer] 新页面登录状态验证失败");
							return null;
						}
						return newPage;
					}

					// 如果 c 为 false，关闭当前页面并返回
					await page.close();
					loginSuccess = true;
					return page;
				} catch (error) {
					console.error(`[Puppeteer] 第 ${retryCount + 1} 次登录失败:`, error);
					retryCount++;
					if (retryCount < maxRetries) {
						if (!page.isClosed()) {
							await page.close();
						}
						page = await this.createPage();
						// 如果页面创建失败，返回 null
						if (!page) {
							return null;
						}
					}
				}
			}

			if (!loginSuccess) {
				console.error("[Puppeteer] 登录失败");
				return null;
			}
		}

		return page;
	}

	public async login(page: Page): Promise<void> {
		// 检查是否已经登录
		const isLoggedIn = await this.checkLoginStatus(page);
		if (isLoggedIn) {
			return;
		}

		// 检查页面是否包含登录按钮
		const loginButtonExists = await page.evaluate(() => {
			const button = document.querySelector(
				'#loginAndRegister a[data-target="#loginModal"]',
			);
			return !!button;
		});

		if (!loginButtonExists) {
			throw new Error("登录按钮不存在");
		}

		// 等待登录按钮可见和可点击
		await page.waitForSelector(
			'#loginAndRegister a[data-target="#loginModal"]',
			{ timeout: 60000, visible: true },
		);

		// 点击登录按钮
		await page.click('#loginAndRegister a[data-target="#loginModal"]');

		// 等待登录模态框出现
		await page.waitForSelector("#loginModal", {
			visible: true,
			timeout: 60000,
		});

		// 等待输入框和按钮加载
		await Promise.all([
			page.waitForSelector("#loginemail", {
				visible: true,
				timeout: 60000,
			}),
			page.waitForSelector("#loginpassword", {
				visible: true,
				timeout: 60000,
			}),
			page.waitForSelector("#loginSubmit", {
				visible: true,
				timeout: 60000,
			}),
		]);

		// 先设置请求拦截
		await page.setRequestInterception(true);
		let loginRequestSent = false;
		let loginResponseReceived = false;

		const requestHandler = (request: HTTPRequest) => {
			if (request.method() === "POST" && request.url().includes("/login")) {
				if (!loginRequestSent) {
					loginRequestSent = true;
					request.continue();
				} else {
					request.continue();
				}
			} else {
				request.continue();
			}
		};

		const responseHandler = (response: HTTPResponse) => {
			if (
				response.request().method() === "POST" &&
				response.url().includes("/login")
			) {
				loginResponseReceived = true;
			}
		};

		// 添加事件监听
		page.on("request", requestHandler);
		page.on("response", responseHandler);

		const email = "business@itcox.cn";
		const password = "5YDsEGdG452TCUrL";

		// 输入邮箱
		await page.evaluate((email: string) => {
			const emailInput = document.querySelector(
				"#loginemail",
			) as HTMLInputElement;
			if (emailInput) {
				emailInput.value = email;
				emailInput.dispatchEvent(new Event("input", { bubbles: true }));
				emailInput.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}, email);

		// 输入密码
		await page.evaluate((password: string) => {
			const passwordInput = document.querySelector(
				"#loginpassword",
			) as HTMLInputElement;
			if (passwordInput) {
				passwordInput.value = password;
				passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
				passwordInput.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}, password);

		// 确保按钮可点击
		await page.waitForFunction(
			'!document.querySelector("#loginSubmit").disabled',
			{ timeout: 30000 },
		);

		// 点击登录按钮
		await page.click("#loginSubmit");

		// 等待一下确保请求发送
		await new Promise((resolve) => setTimeout(resolve, 500));

		// 等待登录成功
		// 等待模态框出现
		await page.waitForSelector("#successModal", {
			visible: true,
			timeout: 3500,
		});

		// 等待一下确保完全显示
		await new Promise((resolve) => setTimeout(resolve, 350));

		// 检查登录状态
		const finalLoginStatus = await this.checkLoginStatus(page);
		if (!finalLoginStatus) {
			throw new Error("登录状态验证失败");
		}

		// 移除事件监听
		page.removeAllListeners("request");
		page.removeAllListeners("response");
	}

	public async closeBrowser(): Promise<void> {
		if (this.browser) {
			try {
				await this.browser.close();
			} catch (error) {
				console.error("[Puppeteer] 关闭浏览器时出错:", error);
			}
			this.browser = null;
		}
	}
}

export const puppeteerManager = PuppeteerManager.getInstance();
