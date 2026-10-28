import puppeteer, { type Browser, type HTTPResponse, type Page } from 'puppeteer';

import { AppError } from '@/core/errors';

/**
 * 浏览器网关：平台包唯一允许的浏览器通道（FetchCtx.browser 的实现）。
 * 小红书放行靠真实 Chrome 的 TLS/HTTP2 指纹（docs/research/02 §1）；
 * 主文档 HTML 必须从 response 事件截——hydration 会删掉 __INITIAL_STATE__（§1.8 坑 1）。
 * 页并发受信号量约束（research/03 §6：Chrome 每页 30–110 MB，无上限会 OOM）。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 最多同时开 2 个 page；超出的请求排队，排队期间可被 AbortSignal 取消 */
const MAX_CONCURRENT_PAGES = 2;

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
      .then((b) => {
        // 进程崩溃/被杀后允许下次调用重新拉起
        b.once('disconnected', () => {
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

/** 计数信号量：acquire 返回释放函数；排队可被 signal 打断（AbortError） */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(wake);
        if (i >= 0) this.queue.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(wake);
    });
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  get stats(): { active: number; waiting: number; max: number } {
    return { active: this.active, waiting: this.queue.length, max: this.max };
  }
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError');
}

/** sleep 期间 signal 取消则以 AbortError 拒绝；无 signal 时等同普通 sleep */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

/** 信号量内跑一页：acquire → 开页 → fn → finally 关页并释放（signal 贯穿导航） */
async function withPage<T>(
  fn: (page: Page, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await pageSemaphore.acquire(signal);
  let page: Page | undefined;
  try {
    page = await (await getBrowser()).newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'accept-language': 'zh-CN,zh;q=0.9' });
    return await fn(page, signal ?? abortErrorSignal());
  } finally {
    await page?.close().catch(() => {});
    release();
  }
}

/** fn 需要非空 signal 传给 puppeteer；调用方没给时给一个永不触发的新信号 */
function abortErrorSignal(): AbortSignal {
  return new AbortController().signal;
}

async function getDocumentHtml(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return withPage(async (page, signal) => {
    // 302 链上每一跳的 document 响应都会进这里，取 goto 落定前最后一跳（最终页面）
    const docResponses: HTTPResponse[] = [];
    page.on('response', (res) => {
      if (res.request().isNavigationRequest() && res.request().resourceType() === 'document') {
        docResponses.push(res);
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs, signal });

    const doc = docResponses.at(-1);
    if (doc) {
      try {
        return await doc.text();
      } catch {
        // body 已被释放才走到这；退回 hydration 后的 DOM，解析层会识别为无 state
      }
    }
    return await page.content();
  }, signal);
}

/**
 * 导航后监听 response，截取 urlIncludes 命中的首个 XHR JSON。
 * 与 getDocumentHtml 共用同一信号量；XHR 通常早于 DOM 落定，先到先返回。
 */
async function interceptJson(
  url: string,
  urlIncludes: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return withPage(async (page, sig) => {
    const pending: Array<Promise<string>> = [];
    page.on('response', (res) => {
      if (res.url().includes(urlIncludes) && res.request().resourceType() !== 'document') {
        pending.push(res.text().catch(() => ''));
      }
    });
    // 原子化：导航完成或超时/取消，先到者赢；goto 失败不立即放弃（XHR 可能已截到）
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs, signal: sig }).catch(() => null),
      sleepWithSignal(timeoutMs, sig),
    ]);
    // detail XHR 常晚于 domcontentloaded（hydration 后才发）：留窗口等它出现，期间 signal 可取消
    const deadline = Date.now() + Math.min(timeoutMs, 8_000);
    while (Date.now() < deadline && pending.length === 0) {
      await sleepWithSignal(200, sig);
    }
    // 给已排队的响应体一个解析窗口；期间 signal 取消同样立即退出
    const bodies = await Promise.race([
      Promise.all(pending),
      sleepWithSignal(2_000, sig).then(() => [] as string[]),
    ]);
    for (const body of bodies) {
      try {
        return JSON.parse(body);
      } catch {
        // 非 JSON 响应（风控 HTML 等）跳过，继续看下一份
      }
    }
    // 页面上没等到 XHR（被站方改版/风控页）：明确失败，由 adapter 决定下一步
    throw new AppError('UPSTREAM_CHANGED', `浏览器未截到 ${urlIncludes} 响应（可能被改版或风控页拦截）`);
  }, signal);
}

/**
 * 开页等目标 cookie 就位后回收全部 cookie（uifid 自动铸造用）。
 * douyin.com 的 __ac_nonce JS 挑战约 8s 跑完后种下 UIFID_TEMP，所以是轮询等待而非一次读取；
 * 超时返回当下拿到的 cookie（可能缺目标），拿不到由调用方降级。
 */
async function collectCookies(
  url: string,
  waitFor: { name: string; timeoutMs: number },
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return withPage(async (page, sig) => {
    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: waitFor.timeoutMs, signal: sig })
      .catch(() => null);
    const deadline = Date.now() + waitFor.timeoutMs;
    for (;;) {
      const cookies = await page.cookies();
      const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
      if (map[waitFor.name] || Date.now() >= deadline) return map;
      await sleepWithSignal(250, sig);
    }
  }, signal);
}

export const browserGateway = { getDocumentHtml, interceptJson, collectCookies };

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  const b = await pending;
  await b.close();
}
