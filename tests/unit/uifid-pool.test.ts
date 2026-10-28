import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { metrics } from '@/infra/metrics';
import { UifidPool, type PoolIdentity, type UifidMinter } from '@/platforms/douyin/uifid-pool';

/**
 * uifid 身份池回归：复用、健康跟踪（怀疑 → 冷却 → 退休）、铸造节流与并发去重。
 * 铸造器是注入的假函数，全程离线；时间用 now 参数推进，不真等。
 */

const T0 = 1_793_100_000_000;
const MINUTE = 60_000;

const ident = (n: number): PoolIdentity => ({
  uifid: `uifid-${n}`.padEnd(160, '0'),
  ttwid: `ttwid-${n}`,
});

function countingMinter(results: Array<PoolIdentity | null>): { minter: UifidMinter; calls: () => number } {
  let calls = 0;
  const minter: UifidMinter = async () => {
    const r = results[Math.min(calls, results.length - 1)] ?? null;
    calls += 1;
    return r;
  };
  return { minter, calls: () => calls };
}

let pool: UifidPool;
beforeEach(() => {
  pool = new UifidPool();
  metrics.reset();
});
afterEach(() => {
  pool.resetForTests();
});

describe('uifid 身份池（复用与健康跟踪）', () => {
  test('空池 acquire 触发铸造一次，之后复用不再铸', async () => {
    const { minter, calls } = countingMinter([ident(1)]);
    const a = await pool.acquire(minter, undefined, T0);
    const b = await pool.acquire(minter, undefined, T0 + 1000);
    expect(a?.uifid).toBe(ident(1).uifid);
    expect(b?.uifid).toBe(ident(1).uifid);
    expect(calls()).toBe(1);
  });

  test('铸造失败返回 null，节流窗口内不重试（避免连铸成风控信号）', async () => {
    const { minter, calls } = countingMinter([null, ident(1)]);
    expect(await pool.acquire(minter, undefined, T0)).toBeNull();
    expect(calls()).toBe(1);
    // 60s 退避窗口内：不碰铸造器
    expect(await pool.acquire(minter, undefined, T0 + 30_000)).toBeNull();
    expect(calls()).toBe(1);
    // 到点后放行
    expect((await pool.acquire(minter, undefined, T0 + MINUTE + 1))?.uifid).toBe(ident(1).uifid);
    expect(calls()).toBe(2);
  });

  test('连续铸造失败指数退避：60s → 120s 逐级拉长', async () => {
    const { minter, calls } = countingMinter([null]);
    await pool.acquire(minter, undefined, T0);
    expect(calls()).toBe(1);
    // 第一次失败退避 60s：到点放行一次，又失败，退避升到 120s
    expect(await pool.acquire(minter, undefined, T0 + MINUTE + 1)).toBeNull();
    expect(calls()).toBe(2);
    // 120s 退避内不重试
    expect(await pool.acquire(minter, undefined, T0 + MINUTE + 2)).toBeNull();
    expect(calls()).toBe(2);
    // 到点才再放行
    expect(await pool.acquire(minter, undefined, T0 + MINUTE + 1 + 2 * MINUTE)).toBeNull();
    expect(calls()).toBe(3);
  });

  test('怀疑一次进冷却：窗口内不用该身份也不立刻换', async () => {
    const { minter, calls } = countingMinter([ident(1), ident(2)]);
    await pool.acquire(minter, undefined, T0);
    pool.reportSuspect(ident(1).uifid, T0 + 1000);
    // 冷却中：铸造又有节流（上次成功 +60s），这一拍给不出身份 → 调用方落浏览器，符合设计
    expect(await pool.acquire(minter, undefined, T0 + 2000)).toBeNull();
    expect(calls()).toBe(1);
  });

  test('怀疑两次退休，节流到点后铸新身份接替', async () => {
    const { minter, calls } = countingMinter([ident(1), ident(2)]);
    await pool.acquire(minter, undefined, T0);
    pool.reportSuspect(ident(1).uifid, T0 + 1000);
    pool.reportSuspect(ident(1).uifid, T0 + 2000);
    expect(pool.snapshot()[0]).toMatchObject({ status: 'retired', failures: 2 });
    // 节流到点：铸出 2 号身份，1 号永不复用
    const next = await pool.acquire(minter, undefined, T0 + MINUTE + 1);
    expect(next?.uifid).toBe(ident(2).uifid);
    expect(calls()).toBe(2);
    const again = await pool.acquire(minter, undefined, T0 + MINUTE + 2);
    expect(again?.uifid).toBe(ident(2).uifid);
  });

  test('冷却到期后回来再试，成功清零失败计数', async () => {
    const { minter } = countingMinter([ident(1)]);
    await pool.acquire(minter, undefined, T0);
    pool.reportSuspect(ident(1).uifid, T0 + 1000);
    // 60s 冷却到期：该身份回到可用
    const again = await pool.acquire(minter, undefined, T0 + MINUTE + 2000);
    expect(again?.uifid).toBe(ident(1).uifid);
    pool.reportSuccess(ident(1).uifid);
    expect(pool.snapshot()[0]).toMatchObject({ status: 'active', failures: 0 });
  });

  test('并发 acquire 共用一次铸造（同时只出一个新访客）', async () => {
    let calls = 0;
    const minter: UifidMinter = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return ident(1);
    };
    const [a, b] = await Promise.all([
      pool.acquire(minter, undefined, T0),
      pool.acquire(minter, undefined, T0),
    ]);
    expect(a?.uifid).toBe(ident(1).uifid);
    expect(b?.uifid).toBe(ident(1).uifid);
    expect(calls).toBe(1);
  });

  test('池子上限 3：新身份挤掉最旧的', async () => {
    const { minter } = countingMinter([ident(1), ident(2), ident(3), ident(4)]);
    const retire = (n: number, at: number) => {
      pool.reportSuspect(ident(n).uifid, at);
      pool.reportSuspect(ident(n).uifid, at + 1);
    };
    await pool.acquire(minter, undefined, T0);
    retire(1, T0 + 1);
    await pool.acquire(minter, undefined, T0 + MINUTE + 1);
    retire(2, T0 + MINUTE + 2);
    await pool.acquire(minter, undefined, T0 + 2 * MINUTE + 2);
    retire(3, T0 + 2 * MINUTE + 3);
    await pool.acquire(minter, undefined, T0 + 3 * MINUTE + 3);
    const ids = pool.snapshot().map((s) => s.uifid);
    expect(ids).toHaveLength(3);
    expect(ids.some((id) => id.includes('uifid-1'))).toBe(false); // 最旧的已挤出
  });
});
