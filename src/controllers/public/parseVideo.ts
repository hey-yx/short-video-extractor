import puppeteer from "puppeteer";
import type { ApiResponse } from "@/types/response";

interface ParseVideoBody {
  url: string;
}

interface ParseResult {
  title: string;
  videoUrl: string | null;
  cover: string;
}

export async function parseVideo({
  body,
  set,
}: ItcoxTypes.ContextPro): Promise<
  ApiResponse<{ videoUrl: string; title: string; cover: string }>
> {
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
    await page.waitForSelector("div#parsingpanel", { timeout: 3000 });
    // console.log("面板已出现");

    // 等待并获取结果
    console.log("开始轮询检查结果...");
    const result = await page.evaluate(() => {
      return new Promise<ParseResult>((resolve) => {
        let attempts = 0;
        const maxAttempts = 10;

        const checkInterval = setInterval(() => {
          attempts++;
          const lis = document.querySelectorAll("#parsingpanel li");

          if (lis.length >= 3) {
            // 确保至少有三个li元素
            const titleLi = lis[0];
            const coverLi = lis[1];
            const videoLi = lis[lis.length - 1];

            const title = titleLi?.textContent?.split("：")[1]?.trim() || "";
            const cover =
              coverLi?.querySelector("a")?.getAttribute("href") || "";

            if (videoLi?.textContent?.includes("视频链接")) {
              const link = videoLi.querySelector("a.layui-badge-rim");
              const videoUrl = link?.getAttribute("href") || null;

              clearInterval(checkInterval);
              resolve({ title, videoUrl, cover });
            }
          }

          if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            resolve({ title: "", videoUrl: null, cover: "" });
          }
        }, 200);
      });
    });
    console.log("获取到的结果:", result);

    if (!result.videoUrl) {
      set.status = 400;
      return {
        success: false,
        data: { videoUrl: "", title: "", cover: "" },
        message: "解析失败，未找到视频链接",
        errorCode: 1201,
      };
    }

    return {
      success: true,
      data: {
        videoUrl: result.videoUrl,
        title: result.title,
        cover: result.cover,
      },
      message: "视频解析成功",
    };
  } catch (error) {
    console.error(error);
    set.status = 500;
    return {
      success: false,
      data: { videoUrl: "", title: "", cover: "" },
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
