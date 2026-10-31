import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { buildL2DetailRequest } from '@/platforms/douyin/signing';

/** L2 请求构造纯函数回归：锚定 websign 算法（md5）与参数布局，防 abogus 升版漂移 */

const SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';
const UIFID = 'uifid-value-160chars'.padEnd(160, '0');
const TTWID = '1%7Cttwid-value%7C1793100000%7Cdeadbeef';
const AWEME_ID = '7142091187963399427';
const TS = 1793100000;

const req = buildL2DetailRequest(AWEME_ID, { uifid: UIFID, ttwid: TTWID }, { timestamp: TS });

describe('douyin L2 请求构造（buildL2DetailRequest）', () => {
  test('query 布局：业务参数 → uifid/timestamp/签名追加在其后', () => {
    const u = new URL(req.url);
    const keys = [...u.searchParams.keys()];
    expect(keys.at(-3)).toBe('uifid');
    expect(keys.at(-2)).toBe('timestamp');
    expect(keys.at(-1)).toBe('x-secsdk-web-signature');
    expect(keys.at(-4)).toBe('aweme_id');
    // 标准指纹参数集 + aweme_id（对照 research/01 §2.1 / Evil0ctal base_params）
    expect(u.searchParams.get('device_platform')).toBe('webapp');
    expect(u.searchParams.get('channel')).toBe('channel_pc_web');
    expect(u.searchParams.get('version_code')).toBe('290100');
    expect(u.searchParams.get('aweme_id')).toBe(AWEME_ID);
    expect(u.searchParams.get('aid')).toBe('6383');
  });

  test('query 不带 a_bogus / msToken：真机 A/B 实测两者都会触发 200 空 body 静默拒绝', () => {
    const u = new URL(req.url);
    expect(u.searchParams.get('a_bogus')).toBeNull();
    expect(u.searchParams.get('msToken')).toBeNull();
    expect(u.searchParams.get('webid')).toBeNull();
    expect(u.searchParams.get('verifyFp')).toBeNull();
  });

  test('websign 签名 = md5(uifid_timestamp_盐_query)（与真机 SDK 逐字节一致的算法）', () => {
    const u = new URL(req.url);
    const sentSig = u.searchParams.get('x-secsdk-web-signature');
    expect(sentSig).toMatch(/^[0-9a-f]{32}$/);
    // 原始编码保序重建 query（去掉签名参数本身），与 websign.py 的 encode_pairs 同口径
    const parts = u.href
      .split('?')[1]!
      .split('&')
      .filter((p) => !p.startsWith('x-secsdk-web-signature='));
    const preimageQuery = parts.join('&');
    const recomputed = createHash('md5')
      .update(`${uifidSafe(u)}_${TS}_${SALT}_${preimageQuery}`)
      .digest('hex');
    expect(recomputed).toBe(sentSig!);
  });

  test('无随机熵：同 timestamp 两次构造 URL 完全一致', () => {
    const again = buildL2DetailRequest(AWEME_ID, { uifid: UIFID, ttwid: TTWID }, { timestamp: TS });
    expect(again.url).toBe(req.url);
  });

  test('请求头：Cookie 携带 ttwid + UIFID_TEMP，签名三件套透传', () => {
    expect(req.headers['Cookie']).toBe(`ttwid=${TTWID}; UIFID_TEMP=${UIFID}`);
    const u = new URL(req.url);
    expect(req.headers['x-secsdk-web-signature']).toBe(u.searchParams.get('x-secsdk-web-signature') ?? '');
    expect(req.headers['x-secsdk-web-expire']).toBe(String(TS));
    expect(req.headers['uifid']).toBe(UIFID);
    expect(req.headers['Referer']).toBe('https://www.douyin.com/');
    expect(req.headers['User-Agent']).toContain('Chrome');
  });
});

function uifidSafe(u: URL): string {
  return u.searchParams.get('uifid')!;
}
