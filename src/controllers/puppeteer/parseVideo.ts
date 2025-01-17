import puppeteer from "puppeteer";
import type { ApiResponse } from "@/types/response";

interface ParseVideoBody {
  url: string;
}

export async function parseVideo({
  body,
  set,
}: ItcoxTypes.ContextPro): Promise<ApiResponse<{ videoUrl: string }>> {
  let browser;
  try {
    const { url } = body as ParseVideoBody;

    // 启动浏览器
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // 创建新页面
    const page = await browser.newPage();

    // 访问目标网站
    await page.goto("https://api.spapi.cn/");

    // 等待输入框加载完成
    await page.waitForSelector("#homepage.layui-input");

    // 输入URL
    await page.type("#homepage.layui-input", url);

    // 点击解析按钮
    const buttonExists = await page.$$eval("button", (buttons) =>
      buttons.some((button) => button.textContent?.includes("开始解析")),
    );
    // console.log("按钮是否存在:", buttonExists);

    if (!buttonExists) {
      throw new Error("未找到解析按钮");
    }

    // 点击按钮
    const clickResult = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (btn) => btn.textContent?.includes("开始解析"),
      );
      if (button) {
        button.click();
        return true;
      }
      return false;
    });
    // console.log("按钮点击结果:", clickResult);

    // 等待结果出现
    // console.log("等待面板出现...");
    await page.waitForSelector("div#parsingpanel", { timeout: 10000 });
    // console.log("面板已出现");

    // 等待并获取结果
    // console.log("开始轮询检查结果...");
    const videoUrl = await page.evaluate(() => {
      return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 10;

        const checkInterval = setInterval(() => {
          attempts++;
          const lis = document.querySelectorAll("#parsingpanel li");
          const lastLi = lis[lis.length - 1]; // 获取最后一个li

          if (lastLi?.textContent?.includes("视频链接")) {
            const link = lastLi.querySelector("a.layui-badge-rim");
            clearInterval(checkInterval);
            resolve(link?.getAttribute("href") || null);
          }

          if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            resolve(null);
          }
        }, 1000);
      });
    });
    console.log("获取到的视频链接:", videoUrl);

    if (!videoUrl) {
      set.status = 400;
      return {
        success: false,
        data: { videoUrl: "" },
        message: "解析失败，未找到视频链接",
        errorCode: 1201,
      };
    }

    return {
      success: true,
      data: { videoUrl: videoUrl as string },
      message: "视频解析成功",
    };
  } catch (error) {
    console.error(error);
    set.status = 500;
    return {
      success: false,
      data: { videoUrl: "" },
      message: error instanceof Error ? error.message : "服务器内部错误",
      errorCode: 1202,
    };
  } finally {
    // 确保浏览器被关闭
    if (browser) {
      await browser.close();
    }
  }
}
