import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  listSigners,
  pickSigner,
  registerSigner,
  resetSignersForTests,
  type SignerProvider,
} from '@/core/signers';
import { buildL2DetailRequest, resolveTtwid } from '@/platforms/douyin/signing';
import { douyinAbogusSigner } from '@/platforms/douyin/abogus-signer';

/**
 * 签名器注册表回归：P0-1 的落点是「算法过期时换 provider，不改 adapter」。
 * 这里锚住选择规则（优先级/可用性/替换）与热替换语义（注册新实现后请求构造立刻换算法）。
 */

const UIFID = 'uifid-swap-test'.padEnd(160, '0');
const TTWID = '1%7Cttwid%7C1793100000%7Cdead';
const AWEME_ID = '7142091187963399427';

function fakeSigner(name: string, opts: { available?: boolean; version?: string } = {}): SignerProvider {
  return {
    name,
    platform: 'douyin',
    version: opts.version ?? `${name}@test`,
    isAvailable: () => opts.available ?? true,
    signRequest: (req) => ({
      url: `${req.url}&x-secsdk-web-signature=${name}-sig&timestamp=${req.timestamp ?? 1}`,
      headers: { uifid: req.uifid, 'x-secsdk-web-signature': `${name}-sig` },
    }),
    mintTtwid: async () => `${name}-ttwid`,
  };
}

/** 注册表是进程级共享（路由用例靠 createApp 注册默认签名器），快照恢复防串味 */
let saved: SignerProvider[] = [];
beforeEach(() => {
  saved = [...listSigners('douyin')];
});
afterEach(() => {
  resetSignersForTests();
  for (const s of saved) registerSigner(s);
});

describe('签名器注册表（core/signers）', () => {
  test('注册表空时请求构造回落内置默认实现，签名仍是 32 位 md5', () => {
    resetSignersForTests();
    expect(pickSigner('douyin')).toBeNull();
    // 内置默认签名器自检可用（纯函数探测，不碰真网）
    expect(douyinAbogusSigner.isAvailable()).toBe(true);
    const req = buildL2DetailRequest(AWEME_ID, { uifid: UIFID, ttwid: TTWID }, { timestamp: 1793100000 });
    expect(req.headers['x-secsdk-web-signature']).toMatch(/^[0-9a-f]{32}$/);
  });

  test('priority 高者优先，不可用的自动跳过', () => {
    resetSignersForTests();
    registerSigner(fakeSigner('low'), { priority: 0 });
    registerSigner(fakeSigner('high'), { priority: 10 });
    registerSigner(fakeSigner('dead', { available: false }), { priority: 99 });
    expect(pickSigner('douyin')?.name).toBe('high');
  });

  test('同名重复注册视为替换，不堆重复项', () => {
    resetSignersForTests();
    registerSigner(fakeSigner('a', { version: 'a@1' }));
    registerSigner(fakeSigner('a', { version: 'a@2' }));
    const list = listSigners('douyin');
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe('a@2');
  });

  test('热替换：注册新签名器后请求构造立刻换算法，signing/adapter 一行不改', () => {
    resetSignersForTests();
    registerSigner(fakeSigner('next-gen', { version: 'next-gen@2' }), { priority: 10 });
    const req = buildL2DetailRequest(AWEME_ID, { uifid: UIFID, ttwid: TTWID }, { timestamp: 1793100000 });
    expect(req.headers['x-secsdk-web-signature']).toBe('next-gen-sig');
    expect(pickSigner('douyin')).toMatchObject({ name: 'next-gen', version: 'next-gen@2' });
  });

  test('resolveTtwid：env 注入优先；缺省由签名器现铸；没实现 mintTtwid 则返回 null（跳过 L2）', async () => {
    resetSignersForTests();
    registerSigner(fakeSigner('minter'));
    expect(await resolveTtwid('injected-ttwid')).toBe('injected-ttwid');
    expect(await resolveTtwid(undefined)).toBe('minter-ttwid');

    resetSignersForTests();
    const noMint = { ...fakeSigner('no-mint') } as Partial<SignerProvider>;
    delete noMint.mintTtwid;
    registerSigner(noMint as SignerProvider);
    expect(await resolveTtwid(undefined)).toBeNull();
  });
});
