import puppeteer from "puppeteer";
import { browserManager } from "./puppeteer";

/**
 * 辅助函数：将资源按类型分组
 */
function groupResources(
  resources: { type: string; url: string }[],
): { type: string; urls: string[] }[] {
  const resourceMap = new Map<string, string[]>();
  for (const resource of resources) {
    if (!resourceMap.has(resource.type)) {
      resourceMap.set(resource.type, []);
    }
    resourceMap.get(resource.type)?.push(resource.url);
  }
  return Array.from(resourceMap.entries()).map(([type, urls]) => ({
    type,
    urls,
  }));
}

/**
 * API 解析器 - 使用轻量级的浏览器拦截来获取 API 响应
 * 比传统的 Puppeteer 更快，资源占用更少
 */

interface ApiParserOptions {
  waitForSelector?: string;
  apiEndpoint?: string;
  timeout?: number;
}

/**
 * 通用的 API 拦截解析器
 */
export class ApiParser {
  private endpoint: string;
  private options: ApiParserOptions;

  constructor(endpoint: string, options: ApiParserOptions = {}) {
    this.endpoint = endpoint;
    this.options = {
      timeout: 15000,
      ...options,
    };
  }

  /**
   * 拦截 API 响应
   */
  async interceptApiResponse(url: string): Promise<any> {
    const page = await browserManager.createPage();

    // 设置请求拦截
    await page.setRequestInterception(true);

    let apiResponse: any = null;
    let apiResolved = false;

    // 监听响应
    page.on("response", async (response) => {
      const requestUrl = response.url();

      // 检查是否是目标 API
      if (requestUrl.includes(this.endpoint)) {
        try {
          const contentType = response.headers()["content-type"];
          if (contentType && contentType.includes("application/json")) {
            apiResponse = await response.json();
            apiResolved = true;
            console.log(`成功拦截 API 响应: ${this.endpoint}`);
          }
        } catch (error) {
          console.error("解析 API 响应失败:", error);
        }
      }
    });

    // 导航到 URL
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.timeout,
      });

      // 等待 API 响应
      const maxWait = 10000;
      const start = Date.now();

      while (!apiResolved && Date.now() - start < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error("导航失败:", error);
    } finally {
      await browserManager.closePage(page);
    }

    return apiResponse;
  }
}

/**
 * 抖音 API 解析器
 */
export class DouyinApiParser extends ApiParser {
  constructor() {
    super("/aweme/v1/web/aweme/detail/", {
      timeout: 15000,
    });
  }

  /**
   * 从页面解析抖音图集（监听网络资源）
   */
  private async parseGalleryFromPage(url: string): Promise<{
    title: string;
    author: { name: string; avatar: string };
    resources: Array<{ type: string; url: string }>;
  } | null> {
    try {
      const page = await browserManager.createPage();

      const resources: Array<{ type: string; url: string }> = [];
      const capturedUrls: string[] = [];

      // 设置请求拦截，监听图片资源
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const requestUrl = request.url();

        // 监听抖音图集图片资源
        // 支持两种格式：aweme_images 和 tplv-dy-aweme-images
        const isDouyinImage = requestUrl.includes("douyinpic.com");
        const isGalleryImage =
          requestUrl.includes("aweme_images") ||
          requestUrl.includes("tplv-dy-aweme-images") ||
          requestUrl.includes("aweme-images");

        if (isDouyinImage && isGalleryImage && !capturedUrls.includes(requestUrl)) {
          capturedUrls.push(requestUrl);
          resources.push({
            type: "image",
            url: requestUrl,
          });
        }

        // 阻止不需要的资源
        const resourceType = request.resourceType();
        if (["font", "stylesheet", "media"].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      // 导航到页面
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // 等待页面内容加载完成
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      // 获取总页数
      const totalPages = await page.evaluate(() => {
        // 尝试从页码元素获取 "1/2" 格式
        // 通用方法：查找包含 "/" 的文本元素
        const allElements = Array.from(document.querySelectorAll("*"));
        for (const el of allElements) {
          const text = el.textContent?.trim();
          if (text && text.includes("/") && text.match(/^\d+\s*\/\s*\d+$/)) {
            const parts = text.split("/");
            const current = parseInt(parts[0].trim());
            const total = parseInt(parts[1].trim());
            if (!isNaN(current) && !isNaN(total) && total > 0 && total >= current) {
              return total;
            }
          }
        }

        // 尝试计算幻灯片数量：通过 class 名称包含 "slide" 或 "swiper" 的元素
        const slideContainers = document.querySelectorAll("[class*='slide'], [class*='swiper']");
        let maxSlides = 0;
        for (const container of slideContainers) {
          const slides = container.querySelectorAll("[class*='slide']");
          if (slides.length > maxSlides) {
            maxSlides = slides.length;
          }
        }

        if (maxSlides > 0) {
          return maxSlides;
        }

        return 1;
      });

      // 如果只有 1 页，无需翻页
      if (totalPages > 1) {

        for (let currentPage = 1; currentPage < totalPages; currentPage++) {
          // 尝试点击下一页按钮（通用方法）
          const clicked = await page.evaluate(() => {
            // 通用方法1：查找包含右箭头 SVG 的按钮
            const allButtons = Array.from(document.querySelectorAll("button, div[role='button']"));

            // 查找包含右箭头图标的按钮（SVG path 通常包含特定的路径数据）
            for (const btn of allButtons) {
              const svg = btn.querySelector("svg");
              if (svg) {
                const path = svg.querySelector("path");
                if (path) {
                  const d = path.getAttribute("d");
                  // 右箭头通常包含向右的路径
                  if (d && (d.includes("M9") || d.includes("M7"))) {
                    // 简单的箭头检测
                    try {
                      (btn as HTMLElement).click();
                      return true;
                    } catch {
                      const event = new MouseEvent("click", {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                      });
                      btn.dispatchEvent(event);
                      return true;
                    }
                  }
                }
              }
            }

            // 通用方法2：查找包含特定文本的按钮
            const nextTextBtn = Array.from(document.querySelectorAll("*")).find((el) => {
              const text = el.textContent?.trim();
              return text === "下一页" || text === ">";
            });
            if (nextTextBtn) {
              try {
                (nextTextBtn as HTMLElement).click();
                return true;
              } catch {
                const event = new MouseEvent("click", {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                });
                nextTextBtn.dispatchEvent(event);
                return true;
              }
            }

            return false;
          });

          if (!clicked) {
            break;
          }

          await sleep(500);
        }
      }

      // 等待资源加载完成
      const waitTime = Math.max(500, totalPages * 50);
      await sleep(waitTime);

      // 稳定性检查
      let retryCount = 0;
      const maxRetries = 20;
      let lastResourceCount = resources.length;
      let stableCount = 0;

      while (retryCount < maxRetries) {
        await sleep(100);
        retryCount++;

        if (resources.length === lastResourceCount) {
          stableCount++;
          if (stableCount >= 3) {
            break;
          }
        } else {
          stableCount = 0;
          lastResourceCount = resources.length;
        }
      }

      // 关闭页面
      await browserManager.closePage(page);

      return {
        title: "",
        author: {
          name: "",
          avatar: "",
        },
        resources,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 解析抖音视频
   */
  async parseVideo(url: string): Promise<{
    title: string;
    author: { name: string; avatar: string };
    resources: Array<{ type: string; urls: string[] }>;
  } | null> {
    const page = await browserManager.createPage();

    // 设置请求拦截
    await page.setRequestInterception(true);

    let videoData: any = null;
    const capturedApis: string[] = [];

    // 监听所有 API 响应
    page.on("response", async (response) => {
      const requestUrl = response.url();

      // 记录所有 API 请求（调试用）
      if (requestUrl.includes("/api/") || requestUrl.includes("/aweme/")) {
        capturedApis.push(requestUrl);
        // console.log("捕获到 API:", requestUrl.substring(requestUrl.lastIndexOf("/")));
      }

      // 监听视频详情 API
      if (
        requestUrl.includes("/aweme/v1/web/aweme/detail/") ||
        requestUrl.includes("/v1/web/aweme/detail/") ||
        requestUrl.includes("/aweme/v1/web/aweme/detail")
      ) {
        try {
          const data = await response.json();
          if (data?.aweme_detail) {
            videoData = data.aweme_detail;
            console.log("成功捕获抖音 API 数据");
            console.log("是否包含视频:", !!videoData.video);
            console.log("是否包含图集:", !!videoData.images);
          }
        } catch (error) {
          // 忽略非 JSON 响应
        }
      }
    });

    // 阻止不需要的资源
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      // 等待 API 响应
      let retries = 0;
      while (!videoData && retries < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        retries++;
      }

      // 如果没有 API 数据，尝试从页面解析图集
      if (!videoData) {
        // 关闭当前页面，创建新页面用于图集解析
        await browserManager.closePage(page);

        const galleryResult = await this.parseGalleryFromPage(url);
        if (galleryResult) {
          return {
            title: galleryResult.title,
            author: galleryResult.author,
            resources: groupResources(galleryResult.resources),
          };
        }

        return null;
      }

      // 提取数据
      const title = videoData.desc || "";
      const author = {
        name: videoData.author?.nickname || "",
        avatar: videoData.author?.avatar_thumb?.url_list?.[0] || "",
      };

      const resources: Array<{ type: string; url: string }> = [];

      // 提取视频（只保留 play URL）
      if (videoData.video?.play_addr?.url_list) {
        const playUrl = videoData.video.play_addr.url_list.find((url: string) =>
          url.includes("/aweme/v1/play/")
        );
        if (playUrl) {
          resources.push({
            type: "video",
            url: playUrl,
          });
        }
      }

      // 提取图片（图集）
      const images = videoData.images || videoData.image_list || [];
      if (Array.isArray(images) && images.length > 0) {
        console.log(`检测到图集，共 ${images.length} 张图片`);
        images.forEach((image: any, index: number) => {
          // 尝试多种可能的 URL 字段
          const urlLists = [
            image.url_list,
            image.urls,
            image.url,
          ].filter(Boolean);

          for (const urlList of urlLists) {
            if (Array.isArray(urlList) && urlList.length > 0) {
              // 优先使用最后一个 URL（通常质量最高）
              const bestUrl = urlList[urlList.length - 1];
              if (bestUrl && !resources.some((r) => r.url === bestUrl)) {
                resources.push({
                  type: "image",
                  url: bestUrl,
                });
                console.log(`提取图片 ${index + 1}/${images.length}:`, bestUrl.substring(0, 50) + "...");
                break;
              }
            } else if (typeof urlList === "string" && !resources.some((r) => r.url === urlList)) {
              resources.push({
                type: "image",
                url: urlList,
              });
              console.log(`提取图片 ${index + 1}/${images.length}:`, urlList.substring(0, 50) + "...");
              break;
            }
          }
        });
      }

      console.log(`抖音 API 解析完成: ${resources.length} 个资源`);

      await browserManager.closePage(page);

      return {
        title,
        author,
        resources: groupResources(resources),
      };
    } catch (error) {
      console.error("抖音 API 解析失败:", error);
      await browserManager.closePage(page);
      return null;
    }
  }
}
