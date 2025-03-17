import type { ApiResponse } from "@/types/response";
import { puppeteerManager } from "@/utils/puppeteer";

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
  try {
    const { url } = body as ParseVideoBody;
    const page = await puppeteerManager.getPage();

    // 等待输入框和按钮加载
    await page.waitForSelector(
      '.section-heading input[placeholder="请输入短视频分享链接"]',
      { timeout: 10000 },
    );
    await page.waitForSelector(".section-heading button.button-btn", {
      timeout: 10000,
    });

    // 直接设置输入框的值
    await page.evaluate((inputUrl) => {
      const input = document.querySelector(
        '.section-heading input[placeholder="请输入短视频分享链接"]',
      ) as HTMLInputElement;
      if (input) {
        input.value = inputUrl;
        // 触发输入事件，确保网站的 JavaScript 能够响应值的变化
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, url);

    // 点击解析按钮
    await page.click(".section-heading button.button-btn");

    try {
      // 等待结果出现
      await page.waitForSelector(".white-bc", { timeout: 10000 });

      // 等待一段时间确保结果已更新
      // await new Promise((resolve) => setTimeout(resolve, 500));

      // 获取解析结果并验证
      const result = await page.evaluate((currentUrl) => {
        const titleElement = document.querySelector(".title-alert");
        const videoElement = document.querySelector(".video-box a");
        const title = titleElement?.textContent?.trim() || "";

        // 获取图片列表
        const imagesList = Array.from(
          document.querySelectorAll(".images-item .images-ico img"),
        ).map((img) => (img as HTMLImageElement).src);

        // 检查是否为旧数据
        const isOldData = title && !title.includes(currentUrl.slice(0, 20));

        return {
          title,
          videoUrl: videoElement?.getAttribute("href") || null,
          imagesList: imagesList.length > 0 ? imagesList : undefined,
          isOldData,
        };
      }, url);

      // 如果是旧数据，等待更长时间后重试
      if (result.isOldData) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 重新获取结果
        const newResult = await page.evaluate(() => {
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

        result.title = newResult.title;
        result.videoUrl = newResult.videoUrl;
        result.imagesList = newResult.imagesList;
      }

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
    set.status = 500;
    return {
      success: false,
      data: { videoUrl: "", title: "" },
      message: error instanceof Error ? error.message : "服务器内部错误",
      errorCode: 1202,
    };
  }
}
