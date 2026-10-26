import { describe, expect, test } from 'bun:test';

import { Semaphore } from '@/infra/browser';

/** 稳定性加固离线用例：浏览器页并发闸（research/03 §6.3 信号量语义） */

describe('infra/browser Semaphore（最多 2 并发页）', () => {
  test('未达上限：acquire 立即成功，release 后名额归还', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats).toEqual({ active: 2, waiting: 0, max: 2 });
    r1();
    expect(sem.stats.active).toBe(1);
    r2();
    expect(sem.stats.active).toBe(0);
  });

  test('超出上限：第 3 个排队，前序释放后按序进入', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let third = false;
    const p = sem.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.stats.waiting).toBe(1);
    r2();
    const r3 = await p;
    expect(third).toBe(true);
    expect(sem.stats.active).toBe(2);
    r1();
    r3();
  });

  test('排队中被 abort：AbortError 拒绝，队列位置清理，不占用后续名额', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ctrl = new AbortController();
    const p = sem.acquire(ctrl.signal);
    await Promise.resolve();
    expect(sem.stats.waiting).toBe(1);
    ctrl.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(sem.stats.waiting).toBe(0);
    release();
    // 队列清理干净：下一个 acquire 立即成功
    const next = await sem.acquire();
    expect(sem.stats.active).toBe(1);
    next();
  });

  test('acquire 前已 abort：立即 AbortError', async () => {
    const sem = new Semaphore(2);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sem.acquire(ctrl.signal)).rejects.toThrow('aborted');
  });
});
