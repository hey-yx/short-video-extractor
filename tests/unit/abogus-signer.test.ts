import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';

import { SECSDK_WEB_SIGNATURE_SALT } from 'abogus';

import { douyinAbogusSigner, resetMintedTtwidForTests } from '@/platforms/douyin/abogus-signer';

/**
 * abogus 签名器行为测试：真实 abogus 算法（signWebUrl 纯函数，不 mock），
 * 只在 ttwid 现铸的网络边界（global fetch）打桩并在 afterEach 还原。
 *
 * 锚定点（防 abogus 升版漂移）：
 *  - websign 签名 = md5(uifid_timestamp_盐_query)，盐字面量固定；
 *  - ttwid 注册端点与 Set-Cookie 解析后的失败语义（空值/缺失都回 null，不冒泡）。
 */

const SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';
const UIFID = 'uifid-value-160chars'.padEnd(160, '0');
const TS = 1793100000;
const DETAIL_URL =
  'https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&aweme_id=7142091187963399427';

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  resetMintedTtwidForTests();
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchSpy: { mockRestore(): void } | null = null;

/** 只替换网络边界：global fetch 打桩（afterEach 还原），真实 getTtwid 请求构造与 Set-Cookie 解析照跑 */
function stubFetch(impl: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: FetchCall = { url: input instanceof Request ? input.url : String(input), init };
        calls.push(call);
        return impl(call);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return calls;
}

const ttwidResponse = (value: string): Response =>
  new Response('', { status: 200, headers: { 'Set-Cookie': `ttwid=${value}; Path=/; Domain=.douyin.com` } });

/** 以拒绝值落袋（区别于「挂起不结算」与「兑现」） */
const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

const mint = (signal?: AbortSignal): Promise<string | null> => douyinAbogusSigner.mintTtwid!(signal);

/** 原始编码保序重建签名前的 query（去掉签名参数本身），与 websign 算法同口径 */
function preimageQuery(signedUrl: string): string {
  return signedUrl
    .split('?')[1]!
    .split('&')
    .filter((p) => !p.startsWith('x-secsdk-web-signature='))
    .join('&');
}

function recomputeMd5(uifid: string, ts: number, query: string): string {
  return createHash('md5').update(`${uifid}_${ts}_${SALT}_${query}`).digest('hex');
}

describe('abogus 签名器（signRequest，真实算法）', () => {
  test('元数据：platform=douyin，版本标识与依赖版本对齐（升版红 = 排查标识要同步）', () => {
    expect(douyinAbogusSigner.platform).toBe('douyin');
    expect(douyinAbogusSigner.name).toBe('abogus');
    expect(douyinAbogusSigner.version).toBe('abogus@2.1.1');
  });

  test('isAvailable：纯算法自检通过（无网络、无配置依赖）', () => {
    expect(douyinAbogusSigner.isAvailable()).toBe(true);
  });

  test('签名三件套追加在业务参数后，请求头与 URL 参数一致', () => {
    const signed = douyinAbogusSigner.signRequest({ url: DETAIL_URL, uifid: UIFID, timestamp: TS });
    const u = new URL(signed.url);
    const keys = [...u.searchParams.keys()];
    // 业务参数保序在前，uifid/timestamp/签名追加在其后
    expect(keys.slice(0, 3)).toEqual(['device_platform', 'aid', 'aweme_id']);
    expect(keys.at(-3)).toBe('uifid');
    expect(keys.at(-2)).toBe('timestamp');
    expect(keys.at(-1)).toBe('x-secsdk-web-signature');
    expect(u.searchParams.get('uifid')).toBe(UIFID);
    expect(u.searchParams.get('timestamp')).toBe(String(TS));
    // 头与 URL 同源：签名头取 URL 上的签名值，expire 头取 timestamp
    expect(signed.headers['uifid']).toBe(UIFID);
    expect(signed.headers['x-secsdk-web-signature']).toBe(u.searchParams.get('x-secsdk-web-signature') ?? '');
    expect(signed.headers['x-secsdk-web-expire']).toBe(String(TS));
    expect(signed.url.startsWith(`${DETAIL_URL}&uifid=`)).toBe(true);
  });

  test('签名 = md5(uifid_timestamp_盐_query)：独立重算逐字节一致，盐锚定防漂移', () => {
    expect(SECSDK_WEB_SIGNATURE_SALT).toBe(SALT);
    const signed = douyinAbogusSigner.signRequest({ url: DETAIL_URL, uifid: UIFID, timestamp: TS });
    const sent = new URL(signed.url).searchParams.get('x-secsdk-web-signature');
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    const recomputed = recomputeMd5(UIFID, TS, preimageQuery(signed.url));
    expect(recomputed).toBe(sent!);
  });

  test('无随机熵：同输入同 timestamp 两次签名逐字节一致', () => {
    const a = douyinAbogusSigner.signRequest({ url: DETAIL_URL, uifid: UIFID, timestamp: TS });
    const b = douyinAbogusSigner.signRequest({ url: DETAIL_URL, uifid: UIFID, timestamp: TS });
    expect(b.url).toBe(a.url);
    expect(b.headers).toEqual(a.headers);
  });

  test('缺省 timestamp：取当前秒，签名与 expire 头都锚定同一个时间戳', () => {
    const before = Math.floor(Date.now() / 1000);
    const signed = douyinAbogusSigner.signRequest({ url: DETAIL_URL, uifid: UIFID });
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(new URL(signed.url).searchParams.get('timestamp'));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(signed.headers['x-secsdk-web-expire']).toBe(String(ts));
    // 追加的 timestamp 即签名前缀里的时间戳，重算仍逐字节一致
    const recomputed = recomputeMd5(UIFID, ts, preimageQuery(signed.url));
    expect(recomputed).toBe(new URL(signed.url).searchParams.get('x-secsdk-web-signature')!);
  });

  test('URL 已带签名：原样透传，头从既有参数取值', () => {
    const presigned = `${DETAIL_URL}&uifid=other-uifid&timestamp=1700000000&x-secsdk-web-signature=abcdef0123456789abcdef0123456789`;
    const signed = douyinAbogusSigner.signRequest({ url: presigned, uifid: UIFID, timestamp: TS });
    expect(signed.url).toBe(presigned);
    expect(signed.headers['x-secsdk-web-signature']).toBe('abcdef0123456789abcdef0123456789');
    expect(signed.headers['x-secsdk-web-expire']).toBe('1700000000');
  });

  test('URL 已带签名但缺 timestamp：expire 头回落空串（不抛不编造）', () => {
    const presigned = `${DETAIL_URL}&x-secsdk-web-signature=abcdef0123456789abcdef0123456789`;
    const signed = douyinAbogusSigner.signRequest({ url: presigned, uifid: UIFID, timestamp: TS });
    expect(signed.url).toBe(presigned);
    expect(signed.headers['x-secsdk-web-expire']).toBe('');
    expect(signed.headers['x-secsdk-web-signature']).toBe('abcdef0123456789abcdef0123456789');
  });
});

describe('ttwid 现铸（mintTtwid，网络边界打桩）', () => {
  test('成功铸造：POST 注册端点拿 Set-Cookie 值；二次调用命中进程内缓存不再打网络', async () => {
    const calls = stubFetch(() => ttwidResponse('1%7Cminted-ttwid%7C1793100000%7Ccafe'));
    expect(await mint()).toBe('1%7Cminted-ttwid%7C1793100000%7Ccafe');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('ttwid.bytedance.com/ttwid/union/register/');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ aid: 6383, service: 'www.douyin.com' });
    // 缓存命中：不再打网络，返回同一个值
    expect(await mint()).toBe('1%7Cminted-ttwid%7C1793100000%7Ccafe');
    expect(calls).toHaveLength(1);
  });

  test('resetMintedTtwidForTests 清缓存：下次重新现铸（测试钩子可用）', async () => {
    const calls = stubFetch(() => ttwidResponse('fresh-mint'));
    await mint();
    resetMintedTtwidForTests();
    await mint();
    expect(calls).toHaveLength(2);
  });

  test('race 分出胜负后不残留 abort 监听（长寿命 signal 不泄漏）', async () => {
    stubFetch(() => ttwidResponse('cached'));
    const controller = new AbortController();
    await expect(mint(controller.signal)).resolves.toBe('cached');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('非 2xx（网络被拒）→ null，且失败不进缓存（下次可正常铸）', async () => {
    let n = 0;
    const calls = stubFetch(() =>
      ++n === 1 ? new Response('boom', { status: 500, statusText: 'ISE' }) : ttwidResponse('after-failure'),
    );
    expect(await mint()).toBeNull();
    expect(await mint()).toBe('after-failure');
    expect(calls).toHaveLength(2);
  });

  test('200 但响应无 Set-Cookie（网络空值失败）→ null，不冒泡', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    expect(await mint()).toBeNull();
  });

  test('200 但 ttwid 空值（Set-Cookie: ttwid=; …）→ null，且空值不进缓存', async () => {
    let n = 0;
    const calls = stubFetch(() =>
      ++n === 1
        ? new Response('', { status: 200, headers: { 'Set-Cookie': 'ttwid=; Path=/' } })
        : ttwidResponse('real-value'),
    );
    expect(await mint()).toBeNull();
    expect(await mint()).toBe('real-value');
    expect(calls).toHaveLength(2);
  });

  test('Set-Cookie 畸形（无 name=value 对）→ null', async () => {
    stubFetch(
      () => new Response('', { status: 200, headers: { 'Set-Cookie': 'not-a-cookie-pair; Path=/' } }),
    );
    expect(await mint()).toBeNull();
  });

  test('fetch 网络异常（TypeError）→ null，不冒泡（调用方跳过 L2 语义）', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await mint()).toBeNull();
  });
});

describe('取消与超时（AbortSignal：取消/超时原因原样上抛，网络失败吞成 null）', () => {
  test('预中止信号不发网络请求：以 signal.reason 拒绝', async () => {
    const calls = stubFetch(() => ttwidResponse('never-returned'));
    const controller = new AbortController();
    controller.abort();
    const err = await rejectionOf(mint(controller.signal));
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(calls).toHaveLength(0);
  });

  test('自定义取消原因原样上抛（同一错误对象，不包不吞）', async () => {
    stubFetch(() => ttwidResponse('never-returned'));
    const controller = new AbortController();
    const reason = new Error('caller-cancelled');
    controller.abort(reason);
    const err = await rejectionOf(mint(controller.signal));
    expect(err).toBe(reason);
  });

  test('飞行中取消：以原因拒绝且不挂起；取消不进缓存，随后可正常铸造', async () => {
    let mode: 'hang' | 'ok' = 'hang';
    const calls = stubFetch(() =>
      mode === 'hang' ? new Promise<Response>(() => {}) : ttwidResponse('after-cancel'),
    );
    const controller = new AbortController();
    const p = mint(controller.signal);
    const reason = new Error('mid-flight');
    controller.abort(reason);
    const err = await rejectionOf(p);
    expect(err).toBe(reason);
    // 取消不是失败缓存：切回可响应后仍能铸出
    mode = 'ok';
    expect(await mint()).toBe('after-cancel');
    expect(calls).toHaveLength(2);
  });

  test('请求级超时（AbortSignal.timeout）：以 TimeoutError 拒绝，不吞成 null 也不挂起', async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const err = await rejectionOf(mint(AbortSignal.timeout(10)));
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
  });

  test('信号在场但未触发：网络失败照旧回 null（abort 判定只看 signal.aborted）', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const controller = new AbortController();
    expect(await mint(controller.signal)).toBeNull();
  });
});
