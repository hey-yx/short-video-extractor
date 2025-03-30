import type { ApiResponse } from "@/types/response";
import { puppeteerManager } from "@/utils/puppeteer";

interface ParseVideoBody {
  url: string;
}

async function parseVideoWithRetry(
  url: string,
  retryCount = 0,
): Promise<
  ApiResponse<{ videoUrl: string; title: string; imagesList?: string[] }>
> {
  try {
    // 创建新页面并导航到目标网站（会自动处理登录状态）
    const page = await puppeteerManager.createNewPage();

    // 等待输入框和按钮加载
    await Promise.all([
      page.waitForSelector(
        '.section-heading input[placeholder="请输入短视频分享链接"]',
        {
          visible: true,
          timeout: 2000,
        },
      ),
      page.waitForSelector(".section-heading button.button-btn", {
        visible: true,
        timeout: 2000,
      }),
    ]);

    // 填写视频 URL
    await page.evaluate((inputUrl) => {
      const input = document.querySelector(
        '.section-heading input[placeholder="请输入短视频分享链接"]',
      ) as HTMLInputElement;
      if (input) {
        input.value = inputUrl;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, url);

    // 等待一下确保输入完成
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 点击解析按钮
    await page.click(".section-heading button.button-btn");

    // 等待一下确保请求发送
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 等待错误提示或结果出现
    const result = await Promise.race([
      // 等待错误提示
      page
        .waitForSelector(".error-alert .test-wechat", { timeout: 3000 })
        .then(async () => {
          const errorMessage = await page.evaluate(() => {
            const errorElement = document.querySelector(
              ".error-alert .test-wechat",
            );
            return errorElement?.textContent?.trim() || null;
          });

          if (errorMessage) {
            return {
              success: false,
              data: { videoUrl: "", title: "" },
              message: errorMessage,
              errorCode: 1201,
            };
          }
        })
        .catch(() => null),
      // 等待结果出现
      page
        .waitForSelector(".white-bc", { timeout: 5000 })
        .then(async () => {
          // 获取解析结果
          return await page.evaluate(() => {
            const titleElement = document.querySelector(".title-alert");
            const videoElement = document.querySelector(".video-box a");

            // 获取图片列表
            const imagesList = Array.from(
              document.querySelectorAll(".images-item .images-ico img"),
            ).map((img) => (img as HTMLImageElement).src);

            return {
              success: true,
              data: {
                videoUrl: videoElement?.getAttribute("href") || "",
                title: titleElement?.textContent?.trim() || "",
                ...(imagesList.length > 0 && { imagesList }),
              },
              message: "解析成功",
            };
          });
        })
        .catch(() => null),
    ]);

    // 关闭标签页
    await page.close();

    if (!result) {
      if (retryCount < 2) {
        // 如果重试次数小于2次，进行重试
        return parseVideoWithRetry(url, retryCount + 1);
      }
      return {
        success: false,
        data: { videoUrl: "", title: "" },
        message: "解析超时，请稍后重试",
        errorCode: 1203,
      };
    }

    return result;
  } catch (error) {
    // 如果发生错误且重试次数小于2次，进行重试
    if (retryCount < 2) {
      return parseVideoWithRetry(url, retryCount + 1);
    }
    return {
      success: false,
      data: { videoUrl: "", title: "" },
      message: error instanceof Error ? error.message : "服务器内部错误",
      errorCode: 1202,
    };
  }
}

export async function parseVideo({
  body,
  set,
}: ItcoxTypes.ContextPro): Promise<
  ApiResponse<{ videoUrl: string; title: string; imagesList?: string[] }>
> {
  try {
    const { url } = body as ParseVideoBody;
    const result = await parseVideoWithRetry(url);

    if (!result.success) {
      set.status =
        result.errorCode === 1201 ? 400 : result.errorCode === 1203 ? 408 : 500;
    }

    return result;
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
