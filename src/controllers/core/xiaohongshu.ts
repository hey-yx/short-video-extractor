import type { Context } from "elysia";
import { CacheManager } from "@/utils/cache";
import { browserManager, configureXiaohongshuPage } from "@/utils/puppeteer";

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

// 创建全局缓存管理器实例，缓存时间为1小时（3600000毫秒）
const xiaohongshuCache = new CacheManager<XiaohongshuResponse>(3600000);

export async function parseXiaohongshuContent({
  body,
}: Context): Promise<XiaohongshuResponse> {
  const { url } = body as { url: string };
  console.log("开始处理URL:", url);

  const cachedResult = xiaohongshuCache.get(url);
  if (cachedResult) {
    console.log("从缓存返回结果");
    return cachedResult;
  }

  const resources: { type: string; url: string }[] = [];

  try {
    console.log("创建浏览器页面...");
    const page = await browserManager.createPage();
    await configureXiaohongshuPage(page);
    console.log("浏览器页面已创建");

    const videoUrls: string[] = [];
    let clickCount = 0;

    // 设置请求拦截
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      if (url.includes(".xhscdn.com")) {
        if (url.includes("sns-video-")) {
          if (!videoUrls.includes(url)) {
            videoUrls.push(url);
            const resourceType = url.includes("sign") ? "video" : "live";

            resources.push({
              type: resourceType,
              url: url,
            });
            console.log(`捕获到${resourceType}资源: ${url}`);
          }
        }

        if (url.includes("sns-webpic-") && url.includes("/notes_pre_post/")) {
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

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // 获取页面标题和作者信息
    const pageInfo = await page.evaluate(() => {
      const titleElement = document.querySelector("#detail-title");
      const title =
        titleElement?.textContent?.trim() ||
        document
          .querySelector("#detail-desc .note-text")
          ?.textContent?.trim() ||
        "";

      const authorNameElement = document.querySelector(".author .username");
      const authorName = authorNameElement?.textContent?.trim() || "";

      const authorAvatarElement = document.querySelector(
        ".author .avatar-item",
      );
      const authorAvatar = authorAvatarElement?.getAttribute("src") || "";

      return { title, authorName, authorAvatar };
    });

    const authorName = pageInfo.authorName;
    const authorUrl = pageInfo.authorAvatar;
    const title = pageInfo.title;

    console.log("获取到的页面信息:", { title, authorName, authorUrl });

    // 循环点击右侧按钮直到到达最后一页
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // 获取总页数
    const totalPages = await page.evaluate(() => {
      let paginationItems = document.querySelectorAll(
        "#noteContainer #pagination-teleport-container .pagination-list .pagination-item",
      );

      if (paginationItems.length === 0) {
        paginationItems = document.querySelectorAll(
          ".pagination-list .pagination-item",
        );
      }

      if (paginationItems.length === 0) {
        paginationItems = document.querySelectorAll(
          ".slider-pagination-container .pagination-item",
        );
      }

      if (paginationItems.length === 0) {
        const fractionText = document.querySelector(".fraction")?.textContent;
        if (fractionText && fractionText.includes("/")) {
          const parts = fractionText.split("/");
          const total = parseInt(parts[1]);
          if (!isNaN(total) && total > 0) {
            return total;
          }
        }
      }

      return paginationItems.length || 1;
    });

    console.log(`检测到总页数: ${totalPages}`);

    if (totalPages <= 1) {
      console.log("只有 1 页，无需翻页");
    } else {
      console.log(`开始翻页，共 ${totalPages} 页`);

      for (let currentPage = 1; currentPage < totalPages; currentPage++) {
        // 关闭登录面板
        const loginContainer = await page.$(".login-container");
        if (loginContainer) {
          const closeButton = await page.$(".login-container div");
          if (closeButton) {
            await closeButton.click();
            await sleep(300);
          }
        }

        // 点击下一页
        const clicked = await page.evaluate(() => {
          let rightBtn = document.querySelector(
            ".slider-container .right .btn-wrapper",
          );

          if (!rightBtn) {
            rightBtn = document.querySelector(
              ".arrow-controller.right .btn-wrapper",
            );
          }

          if (!rightBtn) {
            rightBtn = document.querySelector(".arrow-controller.right");
          }

          if (rightBtn) {
            const parent = rightBtn.closest(".arrow-controller");
            if (parent && parent.classList.contains("forbidden")) {
              console.log("右侧按钮已禁用，到达最后一页");
              return false;
            }

            try {
              (rightBtn as HTMLElement).click();
              return true;
            } catch {
              const clickEvent = new MouseEvent("click", {
                view: window,
                bubbles: true,
                cancelable: true,
              });
              rightBtn.dispatchEvent(clickEvent);
              return true;
            }
          }

          return false;
        });

        if (!clicked) {
          console.log(
            `第 ${currentPage + 1} 页：无法点击下一页按钮，可能已到最后一页`,
          );
          break;
        }

        clickCount = currentPage;
        console.log(`第 ${currentPage + 1}/${totalPages} 页翻页成功`);

        await sleep(500);
      }

      console.log(`翻页完成，共点击 ${clickCount} 次`);
    }

    // 等待资源加载
    const waitTime = Math.max(500, totalPages * 50);
    console.log(`等待 ${waitTime}ms 以确保资源加载...`);
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
          console.log(`资源加载稳定，共捕获 ${resources.length} 个资源`);
          break;
        }
      } else {
        stableCount = 0;
        console.log(`资源数量变化: ${lastResourceCount} → ${resources.length}`);
        lastResourceCount = resources.length;
      }
    }

    // 按类型重新组织资源
    const resourceMap = new Map<string, string[]>();

    // 将资源按类型分组
    for (const resource of resources) {
      if (!resourceMap.has(resource.type)) {
        resourceMap.set(resource.type, []);
      }
      resourceMap.get(resource.type)?.push(resource.url);
    }

    console.log(`资源分组完成:`);
    for (const [type, urls] of resourceMap.entries()) {
      console.log(`   - ${type}: ${urls.length} 个`);
    }

    // 关闭页面
    await browserManager.closePage(page);
    console.log("页面已关闭，浏览器实例保留");

    // 构建返回结果
    const result: XiaohongshuResponse = {
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
    };

    // 将结果存入缓存
    xiaohongshuCache.set(url, result);

    return result;
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

// 导出缓存管理器实例，便于管理和监控
export { xiaohongshuCache };
