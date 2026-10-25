import puppeteer, { type Browser, type HTTPResponse } from "puppeteer";

/**
 * 浏览器网关：平台包唯一允许的浏览器通道（FetchCtx.browser 的实现）。
 * 小红书放行靠真实 Chrome 的 TLS/HTTP2 指纹（docs/research/02 §1）；
 * 主文档 HTML 必须从 response 事件截——hydration 会删掉 __INITIAL_STATE__（§1.8 坑 1）。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      })
      .then((b) => {
        // 进程崩溃/被杀后允许下次调用重新拉起
        b.once("disconnected", () => {
          browserPromise = null;
        });
        return b;
      })
      .catch((err: unknown) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function getDocumentHtml(
  url: string,
  timeoutMs: number,
): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  // 302 链上每一跳的 document 响应都会进这里，取 goto 落定前最后一跳（最终页面）
  const docResponses: HTTPResponse[] = [];
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "accept-language": "zh-CN,zh;q=0.9" });
    page.on("response", (res) => {
      if (
        res.request().isNavigationRequest() &&
        res.request().resourceType() === "document"
      ) {
        docResponses.push(res);
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    const doc = docResponses.at(-1);
    if (doc) {
      try {
        return await doc.text();
      } catch {
        // body 已被释放才走到这；退回 hydration 后的 DOM，解析层会识别为无 state
      }
    }
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

export const browserGateway = { getDocumentHtml };

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  const b = await pending;
  await b.close();
}
