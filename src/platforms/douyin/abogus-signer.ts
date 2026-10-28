/**
 * 抖音 L2 默认签名器：npm abogus（MIT，零依赖）。
 *
 * 实测（2026-10-27，docs/research/01 §12）：signWebUrl 产出的 x-secsdk-web-signature
 * 与真机 SDK 自己发的签名逐字节一致（md5(uifid_timestamp_盐_query)）。
 * 算法过期（bdms 升级）时，按 core/signers 注册一个新 provider 换掉本实现即可，adapter 不动。
 */

import { getTtwid, signWebUrl } from 'abogus';

import type { SignerProvider, SignedRequest, UnsignedRequest } from '@/core/signers';

/** ttwid 现铸结果进程内缓存（ttwid 有效期一年，无需每请求注册） */
let mintedTtwid: string | null = null;

export const douyinAbogusSigner: SignerProvider = {
  name: 'abogus',
  platform: 'douyin',
  version: 'abogus@2.1.1',

  isAvailable(): boolean {
    try {
      signWebUrl('https://www.douyin.com/?probe=1', { uifid: 'probe', timestamp: 1 });
      return true;
    } catch {
      return false;
    }
  },

  signRequest(req: UnsignedRequest): SignedRequest {
    const signed = signWebUrl(req.url, { uifid: req.uifid, timestamp: req.timestamp });
    const q = new URL(signed).searchParams;
    return {
      url: signed,
      headers: {
        uifid: req.uifid,
        'x-secsdk-web-signature': q.get('x-secsdk-web-signature') ?? '',
        'x-secsdk-web-expire': q.get('timestamp') ?? '',
      },
    };
  },

  async mintTtwid(signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (mintedTtwid) return mintedTtwid;
    let onAbort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        getTtwid(),
        signal
          ? new Promise<never>((_, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener('abort', onAbort, { once: true });
            })
          : new Promise<never>(() => {}),
      ]);
      mintedTtwid = value;
      return value;
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    } finally {
      // race 分出胜负就摘监听，长寿命 signal 上不残留
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  },
};

export function resetMintedTtwidForTests(): void {
  mintedTtwid = null;
}
