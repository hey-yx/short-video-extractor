import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBunRuntime, runDev, type DevRuntime } from '../../scripts/dev-stack';

const options = { port: 7777, monitorPort: 8080, root: '/workspace/project' };

interface Scenario {
  existing?: boolean;
  identity?: string;
  alreadyRunning?: boolean;
  backendOccupied?: boolean;
  backendReady?: boolean;
  monitorReady?: boolean;
  monitorStops?: boolean;
  commandFailure?: string;
  stopFails?: boolean;
  immediateExit?: number;
  signalAt?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  naturalExit?: number;
  forceKill?: boolean;
  monitorFailsLater?: boolean;
  startExits?: boolean;
  stopRemainsRunning?: boolean;
}

function harness(scenario: Scenario = {}) {
  const commands: string[][] = [];
  const messages: string[] = [];
  let clock = 0;
  let launched = false;
  let monitorProbes = 0;
  let running = scenario.alreadyRunning ?? false;
  let signalHandler: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const killed: (number | undefined)[] = [];
  const runtime: DevRuntime = {
    async exec(args) {
      commands.push(args);
      if (args[0] === scenario.signalAt) signalHandler?.(scenario.signal ?? 'SIGINT');
      if (args[0] === scenario.commandFailure || (args[0] === 'stop' && scenario.stopFails)) {
        return { code: 1, out: '', err: 'Docker boundary failed' };
      }
      let out = '';
      if (args[0] === 'ps' && scenario.existing) out = 'sve-gatus-dev';
      if (args[0] === 'inspect') {
        out = args[2]?.includes('Labels')
          ? (scenario.identity ?? `${options.root}|7777:8080`)
          : String(running);
      }
      if (args[0] === 'start') {
        running = true;
        if (scenario.startExits) running = false;
      }
      if (args[0] === 'stop') running = scenario.stopRemainsRunning ?? false;
      return { code: 0, out, err: '' };
    },
    spawn() {
      launched = true;
      if (scenario.immediateExit !== undefined) resolveExit(scenario.immediateExit);
      return {
        exited,
        kill(signal) {
          killed.push(signal);
          if (!scenario.forceKill || signal === 9) resolveExit(143);
        },
      };
    },
    async healthy(url) {
      if (url.includes(':7777/'))
        return launched ? scenario.backendReady !== false : !!scenario.backendOccupied;
      if (scenario.monitorFailsLater && ++monitorProbes > 1) return false;
      return scenario.monitorReady !== false;
    },
    async sleep(ms) {
      clock += ms;
      if (ms === 2000) {
        if (scenario.monitorStops) running = false;
        else if (!scenario.monitorFailsLater && scenario.monitorReady !== false) {
          if (scenario.naturalExit !== undefined) resolveExit(scenario.naturalExit);
          else signalHandler?.(scenario.signal ?? 'SIGINT');
        }
      }
    },
    now: () => clock,
    onSignal(handler) {
      signalHandler = handler;
      return () => {
        signalHandler = undefined;
      };
    },
    log: (message) => {
      messages.push(message);
    },
  };
  return { runtime, commands, messages, killed, wasLaunched: () => launched };
}

describe('开发与独立 Gatus 的生命周期', () => {
  test('无效端口在操作 Docker 前被拒绝', async () => {
    const h = harness();
    expect(await runDev(h.runtime, { ...options, port: 0 })).toBe(1);
    expect(h.commands).toHaveLength(0);
  });

  test('创建独立监控，检查容器，Ctrl-C 时停止且回读停止状态', async () => {
    const h = harness();
    expect(await runDev(h.runtime, options)).toBe(130);
    const create = h.commands.find((command) => command[0] === 'create')!;
    expect(create).toContain('--restart=no');
    expect(create).toContain('SVE_BASE_URL=http://host.docker.internal:7777');
    expect(create).toContain('127.0.0.1:8080:8080');
    expect(h.commands.some((command) => command.includes('compose'))).toBe(false);
    expect(h.commands.at(-1)).toEqual(['inspect', '--format', '{{.State.Running}}', 'sve-gatus-dev']);
    expect(h.messages).toContain('Gatus 已停止，监控历史保留');
    expect(h.killed).toHaveLength(1);
  });

  for (const [name, scenario, expected] of [
    ['SIGTERM', { signal: 'SIGTERM' }, 143],
    ['正常结束', { naturalExit: 0 }, 0],
    ['进程异常退出', { naturalExit: 3 }, 3],
    ['启动监控时收到信号', { signalAt: 'start' }, 130],
    ['容器运行时退出', { monitorStops: true }, 1],
    ['启动命令失败仍尝试收尾', { commandFailure: 'start' }, 1],
    ['监控 HTTP 无响应', { monitorReady: false }, 1],
    ['开发进程忽略终止信号，超时后强制结束', { forceKill: true }, 130],
  ] satisfies [string, Scenario, number][]) {
    test(name, async () => {
      const h = harness(scenario);
      expect(await runDev(h.runtime, options)).toBe(expected);
      expect(h.commands.some((command) => command[0] === 'stop')).toBe(true);
      if (scenario.forceKill) expect(h.killed).toContain(9);
    });
  }

  for (const [name, scenario, expected] of [
    ['Docker 不可用', { commandFailure: 'info' }, 1],
    ['后端端口已经在使用', { backendOccupied: true }, 1],
    ['拒绝接管其他项目的监控容器', { existing: true, identity: '/other|7777:8080' }, 1],
    ['拒绝重复启动运行中的监控', { existing: true, alreadyRunning: true }, 1],
    ['缺少监控镜像', { commandFailure: 'image' }, 1],
    ['后端未就绪', { backendReady: false }, 1],
    ['后端立即崩溃', { immediateExit: 3 }, 3],
    ['创建时取消', { signalAt: 'create' }, 130],
  ] satisfies [string, Scenario, number][]) {
    test(name, async () => {
      const h = harness(scenario);
      expect(await runDev(h.runtime, options)).toBe(expected);
      expect(h.commands.some((command) => command[0] === 'start')).toBe(false);
    });
  }

  test('复用归属及端口一致的停止容器，不重建、不删除历史', async () => {
    const h = harness({ existing: true });
    expect(await runDev(h.runtime, options)).toBe(130);
    expect(h.commands.some((command) => command[0] === 'create' || command[0] === 'rm')).toBe(false);
  });

  test('容器停止失败不能报告清理成功', async () => {
    const h = harness({ stopFails: true, naturalExit: 0 });
    expect(await runDev(h.runtime, options)).toBe(1);
    expect(h.messages.some((message) => message.includes('停止监控失败'))).toBe(true);
    expect(h.messages).not.toContain('Gatus 已停止，监控历史保留');
  });

  test('停止命令成功但容器仍在运行时判失败', async () => {
    const h = harness({ stopRemainsRunning: true, naturalExit: 0 });
    expect(await runDev(h.runtime, options)).toBe(1);
    expect(h.messages.some((message) => message.includes('停止监控失败'))).toBe(true);
  });

  test('容器启动后立即退出判失败', async () => {
    const h = harness({ startExits: true });
    expect(await runDev(h.runtime, options)).toBe(1);
  });

  test('运行中监控连续无响应三分钟后结束开发', async () => {
    const h = harness({ monitorFailsLater: true });
    expect(await runDev(h.runtime, options)).toBe(1);
    expect(h.messages.some((message) => message.includes('连续三次未响应'))).toBe(true);
    expect(h.commands.some((command) => command[0] === 'stop')).toBe(true);
  });
});

const root = new URL('../../', import.meta.url);

describe('真实运行时适配', () => {
  const projectRoot = new URL('../../', import.meta.url).pathname;
  const runtime = createBunRuntime(projectRoot, ['bun', '-e', 'process.exit(0)']);

  test('docker CLI 走参数数组并回收输出', async () => {
    const result = await runtime.exec(['version', '--format', '{{.Server.Version}}']);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^\d+\.\d+/);
  });

  test('探测本机 HTTP：就绪返回 true，拒绝连接返回 false', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: 'ok' }) });
    try {
      expect(await runtime.healthy(`http://127.0.0.1:${server.port}/health`)).toBe(true);
    } finally {
      server.stop(true);
    }
    expect(await runtime.healthy('http://127.0.0.1:1/health')).toBe(false);
  });

  test('开发子进程正常退出并被回收', async () => {
    expect(await runtime.spawn().exited).toBe(0);
  });

  test('信号订阅与退订成对', () => {
    const before = process.listenerCount('SIGINT');
    const off = runtime.onSignal(() => {});
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    off();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  test('sleep 与时钟可用', async () => {
    const started = runtime.now();
    await runtime.sleep(5);
    expect(runtime.now()).toBeGreaterThanOrEqual(started);
  });
});

describe('本地开发入口', () => {
  test('bun run dev 直接联动 Gatus，不需要第二个启动命令', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    expect(pkg.scripts.dev).toBe('bun scripts/dev-stack.ts');
    expect(pkg.scripts['dev:stack']).toBeUndefined();
  });

  test('本地开发不使用服务端 Compose', () => {
    const script = readFileSync(new URL('scripts/dev-stack.ts', root), 'utf8');
    expect(script).not.toContain("'compose'");
  });
});
