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
    const maxRetries = 3;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        return await puppeteer.launch({
          headless: true,
          args: ["--no-sandbox", "--window-size=1280,800"],
          defaultViewport: { width: 1280, height: 800 },
          timeout: 30000,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    throw new Error(
      `浏览器初始化失败，已重试 ${maxRetries} 次: ${lastError?.message || "未知错误"}`,
    );
  }

  private async checkLoginStatus(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      const userEmail = document.querySelector("#showUserName");
      return userEmail?.textContent?.trim() === "business@itcox.cn";
    });
  }

  private async createPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // 设置页面超时时间
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);

    // 设置视口大小
    await page.setViewport({ width: 1280, height: 800 });

    // 启用 JavaScript
    await page.setJavaScriptEnabled(true);

    // 设置用户代理
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );

    // 设置额外的浏览器参数
    await page.setExtraHTTPHeaders({
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    });

    // 导航到目标页面
    await page.goto("https://www.jiexiapi.top/", {
      waitUntil: "networkidle0",
      timeout: 20000,
    });

    // 等待页面加载完成
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: 20000,
    });

    return page;
  }

  public async createNewPage(c = true): Promise<Page> {
    // 创建新页面
    const page = await this.createPage();

    // 检查登录状态
    const isLoggedIn = await this.checkLoginStatus(page);
    if (!isLoggedIn) {
      // 直接在当前页面登录
      await this.login(page);

      // 创建新页面用于后续操作
      if (c) return this.createPage();
    }

    return page;
  }

  public async login(page: Page): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
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
            loginRequestSent = true;
          }
          request.continue();
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
        await page.evaluate((email) => {
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
        await page.evaluate((password) => {
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
        await new Promise((resolve) => setTimeout(resolve, 200));

        // 直接等待成功模态框出现，不等待请求响应
        try {
          // 等待模态框出现
          await page.waitForSelector("#successModal", {
            visible: true,
            timeout: 30000,
          });

          // 移除事件监听
          page.removeAllListeners("request");
          page.removeAllListeners("response");

          // 等待模态框内容加载
          await page.waitForFunction(
            () => {
              const content = document.querySelector("#successmodalbody p");
              return content && content.textContent?.trim() === "登陆成功！";
            },
            { timeout: 30000 },
          );

          // 等待一下确保完全关闭
          await new Promise((resolve) => setTimeout(resolve, 200));

          // 直接点击关闭按钮
          await page.click(
            "#successModal .modal-dialog .modal-content .modal-footer .btn",
          );

          // 等待弹窗完全关闭
          await page.waitForFunction(
            () => {
              const modal = document.querySelector("#successModal");
              if (!modal) return true;
              const style = window.getComputedStyle(modal);
              return (
                style.display === "none" || !modal.classList.contains("in")
              );
            },
            { timeout: 30000 },
          );

          // 登录成功后关闭当前页面
          await page.close();

          // 登录成功，直接返回
          return;
        } catch (error) {
          console.error("[Puppeteer] 登录成功处理失败:", error);
          throw error;
        }
      } catch (error) {
        retryCount++;

        // 等待一段时间后重试
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
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
