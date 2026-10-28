/**
 * uifid 身份池（P0-3 提前量，做法参考同类项目 Evil0ctal 的身份池状态机）。
 *
 * uifid 是服务端下发的访客身份（UIFID_TEMP cookie），每个值就是一个「访客」：
 * 用废了要换，但「5 个新访客一秒出现」本身就是风控信号，所以铸造必须节流。
 * 池子负责三件事：
 *  1. 复用：拿到过的身份反复用（省铸造，也显得像稳定访客）；
 *  2. 健康跟踪：签名失效（Sign Invalid / Uifid Not Found / 静默拒绝）怀疑身份用废，
 *     冷却后重试一次，再废就退休，永不复用；
 *  3. 铸造节流：全局每次铸造之间至少 60s，连续失败指数退避到 1h 上限，绝不连铸。
 *
 * 池子不认识浏览器：铸造动作由调用方以 minter 函数注入（adapter 用 ctx.browser 造），
 * 纯状态机，离线可测。
 */

import { metrics } from '@/infra/metrics';

export interface PoolIdentity {
  uifid: string;
  /** 与 uifid 同场带出的 ttwid（同身份体系组合最稳）；可能拿不到 */
  ttwid: string | null;
}

/** 铸造器：一次性拿一个新访客身份；失败/拿不到返回 null */
export type UifidMinter = (signal?: AbortSignal) => Promise<PoolIdentity | null>;

interface Entry {
  identity: PoolIdentity;
  /** active = 可用；cooling = 怀疑用废，到期后回来再试一次；retired = 已退休，永不复用 */
  status: 'active' | 'cooling' | 'retired';
  /** 连续失败次数（成功清零） */
  failures: number;
  /** cooling 到期时刻（ms） */
  retryAt: number;
}

/** 池子上限：退休最旧的。个人服务规模 3 个访客足够覆盖单值失效 */
const MAX_ENTRIES = 3;
/** 两次铸造之间的最小间隔：首个成功铸造除外 */
const MINT_INTERVAL_MS = 60_000;
/** 铸造失败退避上限 */
const MINT_BACKOFF_CAP_MS = 3_600_000;
/** 怀疑用废后的冷却时长（一次） */
const COOLING_MS = 60_000;

export class UifidPool {
  private entries: Entry[] = [];
  /** 下一次允许铸造的时刻；0 = 无限制（还没铸过或刚成功过重置） */
  private nextMintAt = 0;
  private mintFailures = 0;
  private minting: Promise<PoolIdentity | null> | null = null;

  /**
   * 取一个可用身份：优先复用池里的；没有就按节流规则铸造一个。
   * 返回 null = 这一拍不给身份（节流未到/铸造失败），调用方跳过 L2 落下一级，不硬磕。
   */
  async acquire(minter: UifidMinter, signal?: AbortSignal, now = Date.now()): Promise<PoolIdentity | null> {
    const usable = this.pickUsable(now);
    if (usable) return usable.identity;

    if (now < this.nextMintAt) return null;
    // 并发去重：同一时刻只有一个铸造在跑，后来者共用结果（避免一秒冒出多个新访客）
    if (!this.minting) {
      this.minting = this.mint(minter, signal, now).finally(() => {
        this.minting = null;
      });
    }
    return this.minting;
  }

  private pickUsable(now: number): Entry | null {
    // cooling 到期的回到可用队列（退休的不回来）
    for (const e of this.entries) {
      if (e.status === 'cooling' && now >= e.retryAt) e.status = 'active';
    }
    const usable = this.entries.filter((e) => e.status === 'active');
    // 失败少的优先，同分用新的（新访客通常更干净）
    usable.sort((a, b) => a.failures - b.failures || b.retryAt - a.retryAt);
    return usable[0] ?? null;
  }

  private async mint(
    minter: UifidMinter,
    signal: AbortSignal | undefined,
    now: number,
  ): Promise<PoolIdentity | null> {
    const identity = await minter(signal).catch(() => null);
    if (!identity) {
      this.mintFailures += 1;
      const backoff = Math.min(MINT_INTERVAL_MS * 2 ** (this.mintFailures - 1), MINT_BACKOFF_CAP_MS);
      this.nextMintAt = now + backoff;
      metrics.inc('uifid_mint_total', { result: 'fail' });
      return null;
    }
    this.mintFailures = 0;
    this.nextMintAt = now + MINT_INTERVAL_MS;
    metrics.inc('uifid_mint_total', { result: 'ok' });
    this.addEntry(identity);
    return identity;
  }

  private addEntry(identity: PoolIdentity): void {
    this.entries.unshift({
      identity,
      status: 'active',
      failures: 0,
      retryAt: Date.now(),
    });
    while (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.pop();
      if (dropped && dropped.status !== 'retired') metrics.inc('uifid_retired_total', { reason: 'evicted' });
    }
  }

  /** 用成功：清零失败计数 */
  reportSuccess(uifid: string): void {
    const e = this.entries.find((x) => x.identity.uifid === uifid);
    if (e) {
      e.failures = 0;
      e.status = 'active';
    }
  }

  /** 怀疑用废（Sign Invalid / Uifid Not Found / 200 空 body 静默拒绝）：冷却一次，再废退休 */
  reportSuspect(uifid: string, now = Date.now()): void {
    const e = this.entries.find((x) => x.identity.uifid === uifid);
    if (!e) return;
    e.failures += 1;
    if (e.failures >= 2) {
      e.status = 'retired';
      metrics.inc('uifid_retired_total', { reason: 'suspect' });
    } else {
      e.status = 'cooling';
      e.retryAt = now + COOLING_MS;
    }
  }

  /** 运维观测：池子现状 */
  snapshot(): Array<{ uifid: string; status: Entry['status']; failures: number }> {
    return this.entries.map((e) => ({
      uifid: `${e.identity.uifid.slice(0, 8)}…`,
      status: e.status,
      failures: e.failures,
    }));
  }

  resetForTests(): void {
    this.entries = [];
    this.nextMintAt = 0;
    this.mintFailures = 0;
    this.minting = null;
  }
}

export const uifidPool = new UifidPool();
