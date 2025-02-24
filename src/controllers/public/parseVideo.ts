import puppeteer from "puppeteer";
import type { ApiResponse } from "@/types/response";

interface ParseVideoBody {
  url: string;
}

interface ParseResult {
  title: string;
  videoUrl: string | null;
  imagesList?: string[];
}

export async function parseVideo({
  body,
  set,
}: ItcoxTypes.ContextPro): Promise<
  ApiResponse<{ videoUrl: string; title: string; imagesList?: string[] }>
> {
  let browser;
  try {
    const { url } = body as ParseVideoBody;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto("https://www.jiexiapi.top/");

    // 等待输入框和按钮加载
    await page.waitForSelector(
      '.section-heading input[placeholder="请输入短视频分享链接"]',
    );
    await page.waitForSelector(".section-heading button.button-btn");

    // 输入URL
    await page.type(
      '.section-heading input[placeholder="请输入短视频分享链接"]',
      url,
    );

    // 点击解析按钮
    await page.click(".section-heading button.button-btn");

    try {
      // 等待结果出现
      await page.waitForSelector(".white-bc", { timeout: 5000 });

      // 获取解析结果
      const result = await page.evaluate(() => {
        const titleElement = document.querySelector(".title-alert");
        const videoElement = document.querySelector(".video-box a");

        // 获取图片列表
        const imagesList = Array.from(
          document.querySelectorAll(".images-item .images-ico img"),
        ).map((img) => (img as HTMLImageElement).src);

        return {
          title: titleElement?.textContent?.trim() || "",
          videoUrl: videoElement?.getAttribute("href") || null,
          imagesList: imagesList.length > 0 ? imagesList : undefined,
        };
      });

      if (!result.videoUrl && !result.imagesList?.length) {
        set.status = 400;
        return {
          success: false,
          data: { videoUrl: "", title: "" },
          message: "解析失败，未找到视频链接或图片列表",
          errorCode: 1201,
        };
      }

      return {
        success: true,
        data: {
          videoUrl: result.videoUrl || "",
          title: result.title,
          ...(result.imagesList && { imagesList: result.imagesList }),
        },
        message: "解析成功",
      };
    } catch (timeoutError) {
      set.status = 408; // Request Timeout
      return {
        success: false,
        data: { videoUrl: "", title: "" },
        message: "解析超时，请稍后重试",
        errorCode: 1203,
      };
    }
  } catch (error) {
    console.error(error);
    set.status = 500;
    return {
      success: false,
      data: { videoUrl: "", title: "" },
      message: error instanceof Error ? error.message : "服务器内部错误",
      errorCode: 1202,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
