import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import puppeteer, { type HTTPRequest, type Page, type ResponseForRequest } from 'puppeteer';

import { browserGateway, closeBrowser } from '@/infra/browser';

const launch = puppeteer.launch.bind(puppeteer);
const htmlUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

let launchSpy: ReturnType<typeof spyOn<typeof puppeteer, 'launch'>> | undefined;

/** 真实 Chrome 解析 HTML/执行 JS/发请求，只在网络边界返回固定响应，不启动本地服务。 */
function servePages(
  response: (req: HTTPRequest) => Partial<ResponseForRequest>,
  prepare?: (page: Page) => Promise<void>,
): void {
  launchSpy = spyOn(puppeteer, 'launch').mockImplementation(async (options) => {
    const browser = await launch(options);
    const newPage = browser.newPage.bind(browser);
    spyOn(browser, 'newPage').mockImplementation(async () => {
      const page = await newPage();
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void req.respond(response(req));
      });
      await prepare?.(page);
      return page;
    });
    return browser;
  });
}

afterEach(async () => {
  await closeBrowser();
  launchSpy?.mockRestore();
  launchSpy = undefined;
});

describe('browserGateway（真实 Chromium）', () => {
  test('启动失败不泄漏名额，后续请求仍能启动浏览器读取页面', async () => {
    launchSpy = spyOn(puppeteer, 'launch')
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockImplementation(launch);

    for (let i = 0; i < 2; i++) {
      await expect(browserGateway.getDocumentHtml(htmlUrl('<p>retry</p>'), 2_000)).rejects.toThrow(
        'launch failed',
      );
    }

    const signal = AbortSignal.timeout(2_000);
    const html = await browserGateway.getDocumentHtml(htmlUrl('<p>recovered</p>'), 2_000, signal);
    expect(html).toContain('<p>recovered</p>');
    expect(launchSpy).toHaveBeenCalledTimes(3);
  }, 20_000);

  test('截取最终文档原文，而不是被页面 JS 删除状态后的 DOM', async () => {
    const original =
      '<html><body><script>window.__INITIAL_STATE__={id:42};document.currentScript.remove()</script><p>loaded</p></body></html>';
    let userAgent = '';
    let headerSpy: ReturnType<typeof spyOn<Page, 'setExtraHTTPHeaders'>> | undefined;
    servePages(
      (req) => {
        userAgent = req.headers()['user-agent'] ?? '';
        if (req.url().endsWith('/redirect')) {
          return { status: 302, headers: { location: 'https://fixture.test/final' } };
        }
        return { contentType: 'text/html', body: original };
      },
      async (page) => {
        // CDP 拦截事件的 headers 不含全部 ExtraHTTPHeaders，验证实际设置调用。
        headerSpy = spyOn(page, 'setExtraHTTPHeaders');
      },
    );
    const html = await browserGateway.getDocumentHtml('https://fixture.test/redirect', 2_000);
    expect(html).toBe(original);
    expect(html).toContain('__INITIAL_STATE__');
    expect(userAgent).toContain('Chrome/');
    expect(headerSpy).toHaveBeenCalledWith({ 'accept-language': 'zh-CN,zh;q=0.9' });
  }, 20_000);

  test('文档响应体无法读取时，退回真实 DOM', async () => {
    servePages(
      () => ({ contentType: 'text/html', body: '<p>fallback</p>' }),
      async (page) => {
        page.on('response', (res) => {
          if (res.request().isNavigationRequest()) {
            spyOn(res, 'text').mockRejectedValue(new Error('body released'));
          }
        });
      },
    );
    const html = await browserGateway.getDocumentHtml('https://fixture.test/page', 2_000);
    expect(html).toContain('<p>fallback</p>');
  }, 20_000);

  test('浏览器进程断开后，下次请求重新启动', async () => {
    const browsers: Awaited<ReturnType<typeof launch>>[] = [];
    launchSpy = spyOn(puppeteer, 'launch').mockImplementation(async (options) => {
      const browser = await launch(options);
      browsers.push(browser);
      return browser;
    });
    await browserGateway.getDocumentHtml(htmlUrl('<p>first</p>'), 2_000);
    await browsers[0]!.close();
    const html = await browserGateway.getDocumentHtml(htmlUrl('<p>second</p>'), 2_000);
    expect(html).toContain('second');
    expect(launchSpy).toHaveBeenCalledTimes(2);
  }, 20_000);

  test('同时请求共用浏览器，导航失败后名额仍归还', async () => {
    launchSpy = spyOn(puppeteer, 'launch').mockImplementation(launch);
    const values = await Promise.all(
      [1, 2, 3].map((id) => browserGateway.getDocumentHtml(htmlUrl(`<p>${id}</p>`), 2_000)),
    );
    values.forEach((html, i) => expect(html).toContain(`<p>${i + 1}</p>`));
    expect(launchSpy).toHaveBeenCalledTimes(1);
    await expect(browserGateway.getDocumentHtml('invalid://page', 2_000)).rejects.toThrow();
    expect(await browserGateway.getDocumentHtml(htmlUrl('<p>after-error</p>'), 2_000)).toContain(
      'after-error',
    );
  }, 20_000);

  test('截取页面 JS 发出的 JSON，跳过同路径文档和非 JSON 响应', async () => {
    servePages((req) => {
      if (req.isNavigationRequest()) {
        return {
          contentType: 'text/html',
          body: '<script>fetch("/detail?bad").then(()=>fetch("/detail?good"))</script>',
        };
      }
      return req.url().endsWith('?bad')
        ? { contentType: 'text/html', body: '<p>risk page</p>' }
        : { contentType: 'application/json', body: '{"id":42,"video":"fixture.mp4"}' };
    });
    const value = await browserGateway.interceptJson('https://fixture.test/detail', '/detail', 2_000);
    expect(value).toEqual({ id: 42, video: 'fixture.mp4' });
  }, 20_000);

  test('XHR 晚于 DOM 加载时等待响应', async () => {
    servePages((req) =>
      req.isNavigationRequest()
        ? { contentType: 'text/html', body: '<script>setTimeout(()=>fetch("/detail"),300)</script>' }
        : { contentType: 'application/json', body: '{"late":true}' },
    );
    expect(await browserGateway.interceptJson('https://fixture.test/page', '/detail', 2_000)).toEqual({
      late: true,
    });
  }, 20_000);

  test('没有匹配 XHR 时明确报上游改版，而非空结果', async () => {
    servePages(() => ({ contentType: 'text/html', body: '<p>no detail</p>' }));
    await expect(
      browserGateway.interceptJson('https://fixture.test/page', '/detail', 100),
    ).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED' });
  }, 20_000);

  test('等待 XHR 时取消，退出并允许后续页面继续工作', async () => {
    servePages(() => ({ contentType: 'text/html', body: '<p>waiting</p>' }));
    const controller = new AbortController();
    const pending = browserGateway.interceptJson(
      'https://fixture.test/page',
      '/detail',
      2_000,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 1_000);
    await expect(pending).rejects.toThrow('aborted');
    expect(await browserGateway.getDocumentHtml('https://fixture.test/after', 2_000)).toContain('waiting');
  }, 20_000);

  test('等待页面 JS 种下目标 cookie，并返回全部 cookie', async () => {
    servePages(() => ({
      contentType: 'text/html',
      body: '<script>document.cookie="other=keep";setTimeout(()=>document.cookie="UIFID_TEMP=minted",300)</script>',
    }));
    const cookies = await browserGateway.collectCookies('https://fixture.test/page', {
      name: 'UIFID_TEMP',
      timeoutMs: 2_000,
    });
    expect(cookies).toEqual({ other: 'keep', UIFID_TEMP: 'minted' });
  }, 20_000);

  test('cookie 未就绪到超时时返回当前结果', async () => {
    servePages(() => ({ contentType: 'text/html', body: '<script>document.cookie="other=keep"</script>' }));
    expect(
      await browserGateway.collectCookies('https://fixture.test/page', { name: 'missing', timeoutMs: 100 }),
    ).toEqual({ other: 'keep' });
  }, 20_000);
});
