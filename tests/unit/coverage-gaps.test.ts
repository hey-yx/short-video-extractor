import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { createApp } from '@/bootstrap/app';
import { AppError } from '@/core/errors';
import { breakerSnapshot, resetChannelPolicyForTests } from '@/infra/channel-policy';
import { metrics } from '@/infra/metrics';
import { douyinAdapter } from '@/platforms/douyin/adapter';
import { parseAweme } from '@/platforms/douyin/parse';
import { uifidPool } from '@/platforms/douyin/uifid-pool';
import { parseBilibili } from '@/platforms/bilibili/parse';
import { parseInstagram } from '@/platforms/instagram/parse';
import { extractPhotoJson, parseKuaishou } from '@/platforms/kuaishou/parse';
import { parseTiktok } from '@/platforms/tiktok/parse';
import { parseTweetResultJson } from '@/platforms/twitter/parse';
import { resetGuestTicketForTests, weiboAdapter } from '@/platforms/weibo/adapter';
import { parseWeibo } from '@/platforms/weibo/parse';
import { setXhsClientForTests, xhsAdapter } from '@/platforms/xhs/adapter';
import { extractInitialState, parseNote } from '@/platforms/xhs/parse';
import { parseYoutube } from '@/platforms/youtube/parse';
import { parseCache } from '@/services/cache';
import { signIpBoundLinks, verifyMediaSignature } from '@/services/media-proxy';
import { parseUrl } from '@/services/parse.service';
import type { FetchCtx, MatchResult, ParseResult, RawPayload } from '@/types/platform';

const id = '7600000000000000001';
const douyinUrl = new URL(`https://www.douyin.com/video/${id}`);
const douyinInput: MatchResult = { platform: 'douyin', id, kind: 'video', needsResolve: false };
const xhsInput: MatchResult = { platform: 'xhs', id: '', kind: 'unknown', needsResolve: false };
const riskBody = 'Blocked by ArgusSecurityPlugin Uifid Not Found';
let restoreFetch: (() => void) | undefined;
const originalProxySecret = process.env.PROXY_SECRET;

function ctx(overrides: Partial<FetchCtx> = {}): FetchCtx {
  return {
    signal: new AbortController().signal,
    channel: 'http',
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

function raw(body: unknown, via: RawPayload['via'] = 'api'): RawPayload {
  return { body, via, fetchedAt: 1_700_000_000, channel: 'http' };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const preconnect = globalThis.fetch.preconnect;
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        handler(input instanceof Request ? input.url : String(input), init),
      { preconnect },
    ),
  );
  restoreFetch = () => spy.mockRestore();
  return spy;
}

function browser(body: unknown): NonNullable<FetchCtx['browser']> {
  return {
    async getDocumentHtml() {
      return '';
    },
    async interceptJson() {
      return body;
    },
  };
}

async function errorOf(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ${code}, but operation succeeded`);
}

function syncError(fn: () => unknown, code: AppError['code'], message: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
    return;
  }
  throw new Error(`Expected ${code}, but operation succeeded`);
}

beforeEach(() => {
  resetChannelPolicyForTests();
  metrics.reset();
  parseCache.resetForTests();
  uifidPool.resetForTests();
  resetGuestTicketForTests();
  setXhsClientForTests((url, init) => fetch(url, init));
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  setXhsClientForTests((url, init) => fetch(url, init));
  resetChannelPolicyForTests();
  metrics.reset();
  parseCache.resetForTests();
  uifidPool.resetForTests();
  resetGuestTicketForTests();
  if (originalProxySecret === undefined) delete process.env.PROXY_SECRET;
  else process.env.PROXY_SECRET = originalProxySecret;
});

describe('douyin adapter uncovered HTTP and redirect outcomes', () => {
  test('unrecognized page path does not match an aweme', () => {
    expect(douyinAdapter.match(new URL('https://www.douyin.com/jingxuan'))).toBeNull();
  });

  test('short-link HEAD returns Location and cancels its unread response body', async () => {
    let cancellations = 0;
    const upstream = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancellations += 1;
            },
          }),
          {
            status: 302,
            headers: { location: douyinUrl.href },
          },
        ),
    );
    const resolve = douyinAdapter.resolve;
    if (!resolve) throw new Error('Douyin must support short-link resolution');
    expect((await resolve(new URL('https://v.douyin.com/code/'), ctx())).href).toBe(douyinUrl.href);
    expect(cancellations).toBe(1);
    expect(upstream).toHaveBeenCalledTimes(1);
    const options = upstream.mock.calls[0]?.[1];
    expect(options?.method).toBe('HEAD');
    expect(options?.redirect).toBe('manual');
    expect(new Headers(options?.headers).get('user-agent')).toContain('Chrome/');
  });

  test('short-link response without Location is INVALID_URL', async () => {
    stubFetch(() => new Response('not a redirect'));
    const resolve = douyinAdapter.resolve;
    if (!resolve) throw new Error('Douyin must support short-link resolution');
    const error = await errorOf(resolve(new URL('https://v.douyin.com/missing/'), ctx()), 'INVALID_URL');
    expect(error.detail).toEqual({ url: 'https://v.douyin.com/missing/', status: 200 });
  });

  test('403 without the Argus fingerprint remains an upstream error, not risk control', async () => {
    const text = 'permission denied '.repeat(20);
    const upstream = stubFetch(() => new Response(text, { status: 403 }));
    const error = await errorOf(douyinAdapter.fetch(douyinInput, douyinUrl, ctx()), 'UPSTREAM_ERROR');
    expect(error.message).toBe('抖音接口 403');
    expect(error.detail?.body).toBe(text.slice(0, 120));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(breakerSnapshot().get('douyin')).toBeUndefined();
  });

  for (const [body, message] of [
    ['', '抖音接口返回空 body'],
    ['<html>maintenance</html>', '抖音接口返回非 JSON'],
  ] as const) {
    test(`L1 ${message} does not spend a browser fallback`, async () => {
      let browserCalls = 0;
      const gateway = browser({ aweme_detail: {} });
      gateway.interceptJson = async () => {
        browserCalls += 1;
        return { aweme_detail: {} };
      };
      const upstream = stubFetch(() => new Response(body));
      const error = await errorOf(
        douyinAdapter.fetch(douyinInput, douyinUrl, ctx({ browser: gateway })),
        'UPSTREAM_CHANGED',
      );
      expect(error.message).toBe(message);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(browserCalls).toBe(0);
    });
  }

  test('browser result without aweme_detail is rejected rather than returned as success', async () => {
    stubFetch(() => new Response(riskBody, { status: 403 }));
    const error = await errorOf(
      douyinAdapter.fetch(douyinInput, douyinUrl, ctx({ browser: browser({ unexpected: true }) })),
      'UPSTREAM_CHANGED',
    );
    expect(error.message).toBe('浏览器通道未截到 aweme_detail 数据');
  });

  for (const outcome of ['network', '500', 'non-json'] as const) {
    test(`L2 ${outcome} retains its classified failure when there is no browser`, async () => {
      const upstream = stubFetch((url) => {
        if (!url.includes('x-secsdk-web-signature=')) return new Response(riskBody, { status: 403 });
        if (outcome === 'network') throw new TypeError('connection reset');
        return new Response(outcome === '500' ? 'unavailable' : '<html>error</html>', {
          status: outcome === '500' ? 500 : 200,
        });
      });
      const error = await errorOf(
        douyinAdapter.fetch(douyinInput, douyinUrl, ctx({ douyinUifid: 'visitor', douyinTtwid: 'ticket' })),
        outcome === 'network'
          ? 'UPSTREAM_TIMEOUT'
          : outcome === '500'
            ? 'UPSTREAM_ERROR'
            : 'UPSTREAM_CHANGED',
      );
      expect(error.message).toBe(
        outcome === 'network'
          ? '抖音 L2 签名通道网络错误或超时'
          : outcome === '500'
            ? '抖音 L2 接口 HTTP 500'
            : '抖音 L2 接口返回非 JSON',
      );
      if (outcome === 'network') expect(error.detail?.err).toBe('TypeError: connection reset');
      expect(upstream).toHaveBeenCalledTimes(2);
    });
  }

  test('cancellation during L2 preserves the original AbortError and skips the browser', async () => {
    const controller = new AbortController();
    const abort = new DOMException('request cancelled', 'AbortError');
    let browserCalls = 0;
    const gateway = browser({ aweme_detail: {} });
    gateway.interceptJson = async () => {
      browserCalls += 1;
      return { aweme_detail: {} };
    };
    const upstream = stubFetch((url) => {
      if (!url.includes('x-secsdk-web-signature=')) return new Response(riskBody, { status: 403 });
      controller.abort();
      throw abort;
    });
    await expect(
      douyinAdapter.fetch(
        douyinInput,
        douyinUrl,
        ctx({
          signal: controller.signal,
          browser: gateway,
          douyinUifid: 'visitor',
          douyinTtwid: 'ticket',
        }),
      ),
    ).rejects.toBe(abort);
    expect(browserCalls).toBe(0);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe('kuaishou photo parsing gaps', () => {
  for (const [html, message] of [
    ['window.INIT_STATE={"photo":null};', 'photo 数据格式异常'],
    ['window.INIT_STATE={"photo":{"photoId":}};', 'photo JSON 解析失败'],
    ['window.INIT_STATE={"photo":{"caption":"truncated', 'photo JSON 未闭合'],
  ]) {
    test(`malformed share page: ${message}`, () => {
      syncError(() => extractPhotoJson(html ?? ''), 'UPSTREAM_CHANGED', message ?? '');
    });
  }

  test('image-only photo keeps valid image URLs, caption lines and headUrls fallback', () => {
    const result = parseKuaishou(
      raw(
        JSON.stringify({
          photo: {
            photoId: 'album-1',
            caption: 'first line\nsecond line',
            userName: '作者',
            headUrls: [{ url: 'https://img.yximgs.com/avatar.jpg' }],
            picUrls: [{ url: 'https://img.yximgs.com/1.jpg' }, {}, { url: 'https://img.yximgs.com/2.jpg' }],
          },
        }),
        'html-embedded-json',
      ),
    );
    expect(result).toMatchObject({
      platform: 'kuaishou',
      id: 'album-1',
      kind: 'album',
      title: 'first line',
      description: 'first line\nsecond line',
      parsedAt: 1_700_000_000,
      author: { name: '作者', avatar: 'https://img.yximgs.com/avatar.jpg' },
      assets: [
        { type: 'image', url: 'https://img.yximgs.com/1.jpg' },
        { type: 'image', url: 'https://img.yximgs.com/2.jpg' },
      ],
    });
  });

  test('multiple adaptation sets sort by height without mutating upstream representation order', () => {
    const photo = {
      photoId: 'video-1',
      duration: 4321,
      mainMvUrls: [{ url: 'https://v.kwaicdn.com/main.mp4' }],
      manifest: {
        adaptationSet: [
          {
            representation: [
              { url: 'https://v.kwaicdn.com/540.mp4', height: 540, width: 960, fileSize: 5400 },
              { url: 'https://v.kwaicdn.com/1080.mp4', height: 1080, width: 1920, fileSize: 10800 },
            ],
          },
          {
            representation: [
              {
                url: 'https://v.kwaicdn.com/720.mp4',
                qualityType: 'HD',
                height: 720,
                width: 1280,
                fileSize: 7200,
              },
            ],
          },
          {},
        ],
      },
    };
    const serialized = JSON.stringify({ photo });
    const result = parseKuaishou(raw(serialized, 'html-embedded-json'));
    expect(result.assets[0]).toMatchObject({
      url: 'https://v.kwaicdn.com/1080.mp4',
      height: 1080,
      width: 1920,
      size: 10800,
      durationMs: 4321,
      variants: [
        {
          ratio: 'HD',
          url: 'https://v.kwaicdn.com/720.mp4',
          height: 720,
          width: 1280,
          size: 7200,
          watermark: false,
        },
        {
          ratio: '540p',
          url: 'https://v.kwaicdn.com/540.mp4',
          height: 540,
          width: 960,
          size: 5400,
          watermark: false,
        },
      ],
    });
    expect(JSON.stringify({ photo })).toBe(serialized);
  });
});

describe('other platform parser malformed payloads', () => {
  for (const [html, message] of [
    ['window.__INITIAL_STATE__=undefined;', '不是对象字面量'],
    ['window.__INITIAL_STATE__={"note":};', '不是合法 JSON'],
    ['window.__INITIAL_STATE__={"note":{"caption":"truncated', '括号不配对'],
  ]) {
    test(`xhs state ${message}`, () => {
      syncError(() => extractInitialState(html ?? ''), 'UPSTREAM_CHANGED', message ?? '');
    });
  }

  test('xhs rejects wrong payload channel and non-text documents', () => {
    syncError(() => parseNote(raw({}), xhsInput), 'UPSTREAM_CHANGED', '未知载荷类型');
    syncError(() => parseNote(raw({}, 'browser-intercept'), xhsInput), 'UPSTREAM_CHANGED', '不是 HTML 文本');
  });

  test('douyin rejects a document payload before inspecting aweme fields', () => {
    syncError(() => parseAweme(raw('', 'browser-intercept')), 'UPSTREAM_CHANGED', '未知载荷类型');
  });

  test('twitter rejects valid JSON primitives', () => {
    for (const text of ['null', 'true', '42', '"tweet"']) {
      syncError(() => parseTweetResultJson(text, '123'), 'UPSTREAM_CHANGED', '非对象 JSON');
    }
  });

  test('weibo rejects wrong payload type and missing show envelope', () => {
    syncError(() => parseWeibo(raw('', 'browser-intercept')), 'UPSTREAM_CHANGED', '未知载荷类型');
    syncError(() => parseWeibo(raw({})), 'UPSTREAM_CHANGED', '缺少 show');
  });

  test('weibo plain hashtags are trimmed and deduplicated with component topics', () => {
    const result = parseWeibo(
      raw({
        show: {
          ok: 1,
          data: {
            id: '123',
            text: 'hello # 旅行 # #旅行# #摄影[超话]#',
            pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/photo.jpg' } }],
          },
        },
        component: { code: '100000', data: { Component_Play_Playinfo: { topics: [{ content: '旅行' }] } } },
      }),
    );
    expect(result.tags).toEqual(['旅行', '摄影']);
    expect(result.assets).toHaveLength(1);
  });

  test('tiktok code=0 without data is structural failure', () => {
    syncError(() => parseTiktok(raw({ code: 0 }), { id: 'tiktok-1' }), 'UPSTREAM_CHANGED', '缺少 data');
  });

  test('tiktok album with no non-empty image URL is rejected', () => {
    syncError(
      () => parseTiktok(raw({ code: 0, data: { images: ['', ''] } }), { id: 'tiktok-2' }),
      'UPSTREAM_CHANGED',
      '没有可下载资源',
    );
  });

  test('instagram video without usable video_versions is CONTENT_NOT_FOUND', () => {
    syncError(
      () =>
        parseInstagram(
          raw({
            docId: 'doc',
            data: {
              xdt_api__v1__media__shortcode__web_info: {
                items: [{ code: 'clip', media_type: 2, video_versions: [{}] }],
              },
            },
          }),
          { id: 'clip' },
        ),
      'CONTENT_NOT_FOUND',
      '没有可用视频流',
    );
  });

  test('instagram image without usable image candidate is CONTENT_NOT_FOUND', () => {
    syncError(
      () =>
        parseInstagram(
          raw({
            docId: 'doc',
            data: {
              xdt_api__v1__media__shortcode__web_info: {
                items: [{ code: 'photo', image_versions2: { candidates: [{}] } }],
              },
            },
          }),
          { id: 'photo' },
        ),
      'CONTENT_NOT_FOUND',
      '没有可用图片',
    );
  });

  test('youtube OK player missing details or streaming data is structural failure', () => {
    for (const player of [
      { playabilityStatus: { status: 'OK' }, streamingData: {} },
      { playabilityStatus: { status: 'OK' }, videoDetails: {} },
    ]) {
      syncError(
        () => parseYoutube(raw({ client: 'IOS', player }), { id: 'yt' }),
        'UPSTREAM_CHANGED',
        '缺少 videoDetails/streamingData',
      );
    }
  });

  test('youtube explicitly empty format lists are structural failure', () => {
    syncError(
      () =>
        parseYoutube(
          raw({
            client: 'IOS',
            player: {
              playabilityStatus: { status: 'OK' },
              videoDetails: {},
              streamingData: { formats: [], adaptiveFormats: [] },
            },
          }),
          { id: 'yt' },
        ),
      'UPSTREAM_CHANGED',
      '没有可用格式',
    );
  });

  test('youtube audio-only response is not accepted as a video', () => {
    syncError(
      () =>
        parseYoutube(
          raw({
            client: 'IOS',
            player: {
              playabilityStatus: { status: 'OK' },
              videoDetails: {},
              streamingData: {
                adaptiveFormats: [
                  {
                    url: 'https://r1.googlevideo.com/audio',
                    mimeType: 'audio/mp4',
                    audioQuality: 'AUDIO_QUALITY_MEDIUM',
                  },
                ],
              },
            },
          }),
          { id: 'yt' },
        ),
      'UPSTREAM_CHANGED',
      '无可用视频流',
    );
  });

  test('bilibili unknown quality IDs use dimensions then id fallback and view duration', () => {
    const result = parseBilibili(
      raw({
        view: { code: 0, data: { bvid: 'BVfixture', duration: 9 } },
        streams: [
          {
            page: 1,
            cid: 1,
            videos: [
              { id: 80, base_url: 'https://upos.example/1080.mp4', width: 1920, height: 1080 },
              { id: 999, base_url: 'https://upos.example/600.mp4', width: 1000, height: 600 },
              { id: 998, base_url: 'https://upos.example/unknown.mp4' },
            ],
            audios: [],
          },
        ],
      }),
    );
    expect(result.assets[0]?.durationMs).toBe(9000);
    expect(result.assets[0]?.variants).toEqual([
      { ratio: '600p', url: 'https://upos.example/600.mp4', width: 1000, height: 600, watermark: false },
      {
        ratio: 'id998',
        url: 'https://upos.example/unknown.mp4',
        width: undefined,
        height: undefined,
        watermark: false,
      },
    ]);
  });
});

describe('xhs and weibo remaining adapter failures', () => {
  test('xhs id-less input synthesizes the explore page without a token', async () => {
    const urls: string[] = [];
    setXhsClientForTests(async (url) => {
      urls.push(url);
      return new Response('<html>document</html>');
    });
    const result = await xhsAdapter.fetch(xhsInput, new URL('https://xhslink.com/code'), ctx());
    expect(urls).toEqual(['https://www.xiaohongshu.com/explore']);
    expect(result).toMatchObject({ body: '<html>document</html>', channel: 'http' });
  });

  test('xhs short-link response without Location is INVALID_URL', async () => {
    setXhsClientForTests(async () => new Response('not a redirect'));
    const resolve = xhsAdapter.resolve;
    if (!resolve) throw new Error('Xhs must support short-link resolution');
    const error = await errorOf(resolve(new URL('https://xhslink.com/code'), ctx()), 'INVALID_URL');
    expect(error.detail).toEqual({ url: 'https://xhslink.com/code', status: 200 });
  });

  test('xhs browser returning an empty document after login-wall rejection is structural failure', async () => {
    let httpCalls = 0;
    let documentCalls = 0;
    setXhsClientForTests(async () => {
      httpCalls += 1;
      return new Response(null, { status: 302 });
    });
    const gateway = browser({});
    gateway.getDocumentHtml = async () => {
      documentCalls += 1;
      return '';
    };
    const error = await errorOf(
      xhsAdapter.fetch(xhsInput, new URL('https://xhslink.com/code'), ctx({ browser: gateway })),
      'UPSTREAM_CHANGED',
    );
    expect(error.message).toBe('浏览器未截到主文档 HTML');
    expect(httpCalls).toBe(2);
    expect(documentCalls).toBe(1);
  });

  test('weibo malformed JSONP is rejected before using guest tickets or component API', async () => {
    const upstream = stubFetch(() => new Response('window.gen_callback({"data": invalid})'));
    const input: MatchResult = {
      platform: 'weibo',
      id: '1034:0123456789abcdef0123456789abcdef',
      kind: 'video',
      needsResolve: false,
    };
    const error = await errorOf(
      weiboAdapter.fetch(input, new URL('https://video.weibo.com/show'), ctx()),
      'UPSTREAM_CHANGED',
    );
    expect(error.message).toBe('微博访客票据响应结构变化');
    expect(error.detail?.body).toBe('window.gen_callback({"data": invalid})');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('parse orchestration cancellation and final retry classification', () => {
  test('cancelling during retry backoff prevents a second upstream call', async () => {
    createApp();
    const controller = new AbortController();
    const upstream = stubFetch(() => new Response('unavailable', { status: 500 }));
    let loggedRetry = false;
    const retryCtx = ctx({
      signal: controller.signal,
      logger: {
        info() {},
        error() {},
        warn(message) {
          if (message === 'transient upstream error, retrying once') {
            loggedRetry = true;
            setTimeout(() => controller.abort(), 5);
          }
        },
      },
    });
    await expect(parseUrl(douyinUrl.href, retryCtx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loggedRetry).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(parseCache.getPlatformRisk('douyin')).toBeUndefined();
  });

  test('abort from retry logger is observed before creating the backoff timer', async () => {
    createApp();
    const controller = new AbortController();
    const upstream = stubFetch(() => new Response('unavailable', { status: 500 }));
    await expect(
      parseUrl(
        douyinUrl.href,
        ctx({
          signal: controller.signal,
          logger: {
            info() {},
            error() {},
            warn(message) {
              if (message === 'transient upstream error, retrying once') controller.abort();
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test('risk control on the retry opens platform stop-loss for subsequent IDs', async () => {
    createApp();
    let calls = 0;
    const upstream = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? new Response('unavailable', { status: 500 })
        : new Response(riskBody, { status: 403 });
    });
    await errorOf(parseUrl(douyinUrl.href, ctx()), 'RISK_CONTROL');
    expect(parseCache.getPlatformRisk('douyin')?.message).toContain('风控拦截');
    expect(breakerSnapshot().get('douyin')?.consecutiveFailures).toBe(1);
    await errorOf(parseUrl('https://www.douyin.com/video/7600000000000000002', ctx()), 'RISK_CONTROL');
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe('API unknown errors and backup link signing', () => {
  test('unhandled route error becomes a 500 INTERNAL envelope', async () => {
    const app = createApp().get('/coverage-unhandled-error', () => {
      throw new Error('coverage route failure');
    });
    const response = await app.handle(new Request('http://localhost/coverage-unhandled-error'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'INTERNAL', message: 'coverage route failure' },
    });
  });

  test('IP-bound backups are signed while non-IP-bound backups remain unchanged and input stays immutable', () => {
    process.env.PROXY_SECRET = 'coverage-signing-secret';
    const original: ParseResult = {
      platform: 'youtube',
      id: 'yt',
      kind: 'video',
      title: 'backup test',
      author: { name: '' },
      assets: [
        {
          type: 'video',
          url: 'https://r1.googlevideo.com/main.mp4',
          backups: ['https://r2.googlevideo.com/backup.mp4', 'https://pbs.twimg.com/unbound.jpg'],
        },
      ],
      parsedAt: 1_700_000_000,
      via: 'http',
    };
    const before = structuredClone(original);
    const signed = signIpBoundLinks(original, 'https://extractor.example', 1_700_000_000);
    const backup = new URL(signed.assets[0]?.backups?.[0] ?? '');
    expect(backup.origin).toBe('https://extractor.example');
    expect(backup.pathname).toBe('/media');
    const verified = verifyMediaSignature(
      {
        u: backup.searchParams.get('u') ?? undefined,
        exp: backup.searchParams.get('exp') ?? undefined,
        sig: backup.searchParams.get('sig') ?? undefined,
      },
      1_700_000_000,
    );
    expect(verified.url).toBe('https://r2.googlevideo.com/backup.mp4');
    expect(signed.assets[0]?.backups?.[1]).toBe('https://pbs.twimg.com/unbound.jpg');
    expect(original).toEqual(before);
    expect(signed.assets[0]?.backups).not.toBe(original.assets[0]?.backups);
  });
});
