import puppeteer, { type Browser, type Page } from "puppeteer";

class PuppeteerManager {
  private static instance: PuppeteerManager;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isInitializing = false;
  private isLoggedIn = false;

  private constructor() {}

  public static getInstance(): PuppeteerManager {
    if (!PuppeteerManager.instance) {
      PuppeteerManager.instance = new PuppeteerManager();
    }
    return PuppeteerManager.instance;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      if (this.isInitializing) {
        while (this.isInitializing) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        this.isInitializing = true;
        try {
          this.browser = await puppeteer.launch({
            headless: false,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
          });
        } finally {
          this.isInitializing = false;
        }
      }
    }
    if (!this.browser) {
      throw new Error("Failed to initialize browser");
    }
    return this.browser;
  }

  public async getPage(): Promise<Page> {
    if (this.page) {
      return this.page;
    }

    const browser = await this.getBrowser();
    this.page = await browser.newPage();

    try {
      await this.page.goto("https://www.jiexiapi.top/", {
        waitUntil: "networkidle0",
      });

      if (!this.isLoggedIn) {
        await this.page.waitForSelector(
          '#loginAndRegister a[data-target="#loginModal"]',
          { timeout: 10000 },
        );
        await this.page.click('#loginAndRegister a[data-target="#loginModal"]');

        await this.page.waitForSelector("#loginModal", {
          visible: true,
          timeout: 10000,
        });

        await this.page.waitForSelector("#loginemail", {
          visible: true,
          timeout: 10000,
        });
        await this.page.waitForSelector("#loginpassword", {
          visible: true,
          timeout: 10000,
        });
        await this.page.waitForSelector("#loginSubmit", {
          visible: true,
          timeout: 10000,
        });

        await this.page.setRequestInterception(true);
        let loginRequestSent = false;
        this.page.on("request", (request) => {
          if (request.method() === "POST" && request.url().includes("/login")) {
            loginRequestSent = true;
          }
          request.continue();
        });

        await this.page.evaluate(() => {
          const emailInput = document.querySelector(
            "#loginemail",
          ) as HTMLInputElement;
          const passwordInput = document.querySelector(
            "#loginpassword",
          ) as HTMLInputElement;
          if (emailInput) emailInput.value = "";
          if (passwordInput) passwordInput.value = "";
        });

        const email = "business@itcox.cn";
        const password = "5YDsEGdG452TCUrL";

        await this.page.evaluate(
          (email, password) => {
            const emailInput = document.querySelector(
              "#loginemail",
            ) as HTMLInputElement;
            const passwordInput = document.querySelector(
              "#loginpassword",
            ) as HTMLInputElement;

            if (emailInput && passwordInput) {
              emailInput.value = email;
              emailInput.dispatchEvent(new Event("input", { bubbles: true }));
              emailInput.dispatchEvent(new Event("change", { bubbles: true }));

              passwordInput.value = password;
              passwordInput.dispatchEvent(
                new Event("input", { bubbles: true }),
              );
              passwordInput.dispatchEvent(
                new Event("change", { bubbles: true }),
              );
            }
          },
          email,
          password,
        );

        await new Promise((resolve) => setTimeout(resolve, 500));

        const inputValues = await this.page.evaluate(() => {
          const emailInput = document.querySelector(
            "#loginemail",
          ) as HTMLInputElement;
          const passwordInput = document.querySelector(
            "#loginpassword",
          ) as HTMLInputElement;
          return {
            email: emailInput?.value || "",
            password: passwordInput?.value || "",
          };
        });

        if (inputValues.email !== email || inputValues.password !== password) {
          throw new Error("输入验证失败");
        }

        await this.page.click("#loginSubmit");

        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (!loginRequestSent) {
          await this.page.evaluate(async () => {
            try {
              const response = await fetch("/login", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  email: "business@itcox.cn",
                  password: "5YDsEGdG452TCUrL",
                }),
              });
            } catch (error) {
              // 忽略错误
            }
          });
        }

        await this.page.waitForSelector("#successModal", {
          visible: true,
          timeout: 10000,
        });

        await this.page.waitForFunction(
          () => {
            const modal = document.querySelector("#successModal");
            if (!modal) return false;
            const style = window.getComputedStyle(modal);
            return (
              style.display === "block" &&
              modal.classList.contains("in") &&
              document.querySelector("#successModal .modal-content") !== null
            );
          },
          { timeout: 10000 },
        );

        const modalText = await this.page.evaluate(() => {
          const content = document.querySelector("#successmodalbody p");
          return content ? content.textContent?.trim() : "";
        });

        if (modalText !== "登陆成功！") {
          throw new Error(`登录未成功: ${modalText}`);
        }

        await this.page.click('#successModal button[data-dismiss="modal"].btn');

        await this.page.waitForFunction(
          () => {
            const modal = document.querySelector("#successModal");
            if (!modal) return true;
            const style = window.getComputedStyle(modal);
            return style.display === "none" || !modal.classList.contains("in");
          },
          { timeout: 10000 },
        );

        this.isLoggedIn = true;
      }

      return this.page;
    } catch (error) {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      throw new Error(
        `登录失败: ${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }

  public async closeBrowser(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.isLoggedIn = false;
    }
  }
}

export const puppeteerManager = PuppeteerManager.getInstance();
