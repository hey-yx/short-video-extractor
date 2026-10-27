import { getTtwid, signWebUrl } from 'abogus';

/**
 * 抖音 L2 签名通道的请求构造（纯函数 + 一个 ttwid 现铸入口）。
 *
 * 配方与实测结论（2026-10-27，证据见 docs/research/01 §12）：
 *  - 标准指纹参数集 + `signWebUrl` 追加 `uifid`/`timestamp`/`x-secsdk-web-signature`
 *    （md5(uifid_timestamp_盐_query)，与真机 SDK 签名逐字节一致）；
 *  - Cookie：`ttwid` + `UIFID_TEMP`（uifid 服务端下发，浏览器一次性铸造）；
 *  - 不带 `a_bogus`：真机 A/B 实测（同身份同时刻）带 a_bogus 被风控引擎 200 + 空 body
 *    静默拒绝（响应带 x-vc-bdturing-parameters），去掉即 200 全量——「四件套」里的
 *    a_bogus 现阶段是毒参数，真正的门是 uifid + x-secsdk-web-signature（research §3.1）；
 *  - query 里也不要放 `msToken`/`webid`/`verifyFp`：不被 a_bogus 覆盖时同样静默拒绝。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const PAGE_ORIGIN = 'https://www.douyin.com';

/** L2 标准参数集（Evil0ctal v5 `base_params()`，Apache-2.0，对照 docs/research/01 §2.1 逐项实测） */
const BASE_PARAMS: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '290100',
  version_name: '29.1.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  browser_name: 'Chrome',
  browser_version: '131.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '131.0.0.0',
  os_name: 'Mac OS',
  os_version: '10.15.7',
  cpu_core_num: '8',
  device_memory: '8',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '0',
  update_version_code: '170400',
};

export interface L2Identity {
  /** UIFID_TEMP cookie 值（浏览器铸造，长期复用） */
  uifid: string;
  /** ttwid cookie 值 */
  ttwid: string;
}

export interface L2Request {
  url: string;
  headers: Record<string, string>;
}

/**
 * 组装 detail 接口的 L2 签名请求：业务参数 → websign 追加 uifid/timestamp/签名。
 * timestamp 可注入（单测固定签名）；缺省当前秒。
 */
export function buildL2DetailRequest(
  awemeId: string,
  identity: L2Identity,
  opts: { timestamp?: number } = {},
): L2Request {
  const searchParams = new URLSearchParams({ ...BASE_PARAMS, aweme_id: awemeId });
  const url = signWebUrl(`${DETAIL_URL}?${searchParams.toString()}`, {
    uifid: identity.uifid,
    timestamp: opts.timestamp,
  });
  const q = new URL(url).searchParams;
  return {
    url,
    headers: {
      'User-Agent': UA,
      Referer: `${PAGE_ORIGIN}/`,
      Cookie: `ttwid=${identity.ttwid}; UIFID_TEMP=${identity.uifid}`,
      uifid: identity.uifid,
      'x-secsdk-web-signature': q.get('x-secsdk-web-signature') ?? '',
      'x-secsdk-web-expire': q.get('timestamp') ?? '',
      Accept: 'application/json, text/plain, */*',
    },
  };
}

/** ttwid 现铸结果进程内缓存（ttwid 有效期一年，无需每请求注册） */
let mintedTtwid: string | null = null;

/**
 * 取 L2 用 ttwid：env 注入的优先；缺省经 abogus getTtwid() 现铸一次后缓存。
 * 铸造失败（网络/被拒）返回 null —— 调用方跳过 L2 直落下一级，不硬磕。
 */
export async function resolveTtwid(
  injected: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (injected) return injected;
  if (mintedTtwid) return mintedTtwid;
  try {
    const value = await Promise.race([
      getTtwid(),
      signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
              {
                once: true,
              },
            );
          })
        : new Promise<never>(() => {}),
    ]);
    if (value) {
      mintedTtwid = value;
      return value;
    }
    return null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}
