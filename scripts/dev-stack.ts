#!/usr/bin/env bun
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const container = 'sve-gatus-dev';
const image = 'twinproduction/gatus:stable';
const ownerLabel = 'sve.dev.root';

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

interface DevProcess {
  exited: Promise<number>;
  kill(signal?: number): void;
}

export interface DevRuntime {
  exec(args: string[]): Promise<CommandResult>;
  spawn(): DevProcess;
  healthy(url: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  onSignal(handler: (signal: 'SIGINT' | 'SIGTERM') => void): () => void;
  log(message: string): void;
}

export interface DevOptions {
  port: number;
  monitorPort: number;
  root: string;
}

/** 本地入口只控制独立 Gatus 容器，不使用部署用的 Compose。 */
export async function runDev(runtime: DevRuntime, options: DevOptions): Promise<number> {
  const { port, monitorPort, root: projectRoot } = options;
  if (
    ![port, monitorPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535) ||
    port === monitorPort
  ) {
    runtime.log('PORT 与 GATUS_PORT 必须是不同的有效端口');
    return 1;
  }
  const backendUrl = `http://127.0.0.1:${port}/health`;
  const monitorUrl = `http://127.0.0.1:${monitorPort}/health`;
  const target = `http://host.docker.internal:${port}`;
  let dev: DevProcess | undefined;
  let stopMonitor = false;
  let exitCode = 0;
  let finished = false;
  const abort = new AbortController();
  const offSignal = runtime.onSignal((signal) => {
    if (abort.signal.aborted) return;
    exitCode = signal === 'SIGINT' ? 130 : 143;
    abort.abort();
    dev?.kill();
  });

  async function docker(args: string[]): Promise<string> {
    const result = await runtime.exec(args);
    if (result.code !== 0) throw new Error(result.err.trim() || `docker ${args[0]} 失败`);
    return result.out.trim();
  }

  async function running(): Promise<boolean> {
    return (await docker(['inspect', '--format', '{{.State.Running}}', container])) === 'true';
  }

  async function waitHealthy(url: string): Promise<void> {
    const deadline = runtime.now() + 30_000;
    while (!abort.signal.aborted && runtime.now() < deadline) {
      if (await runtime.healthy(url)) return;
      await runtime.sleep(200);
    }
    if (!abort.signal.aborted) throw new Error(`${url} 在 30 秒内没有就绪`);
  }

  /** 预检 + 建容器。任何一步不过都只跳过监控，不拦住后端。 */
  async function prepareMonitor(): Promise<boolean> {
    try {
      await docker(['info', '--format', '{{.ServerVersion}}']);
      if (await runtime.healthy(backendUrl)) {
        throw new Error(`端口 ${port} 已有服务在响应，监控容器会指向它`);
      }
      const existing = await docker([
        'ps',
        '-a',
        '--filter',
        `name=^/${container}$`,
        '--format',
        '{{.Names}}',
      ]);
      if (existing) {
        const identity = await docker([
          'inspect',
          '--format',
          `{{index .Config.Labels "${ownerLabel}"}}|{{index .Config.Labels "sve.dev.ports"}}`,
          container,
        ]);
        if (identity !== `${projectRoot}|${port}:${monitorPort}`) {
          throw new Error(`${container} 属于其他配置（${identity}），不接管`);
        }
        if (await running()) throw new Error(`${container} 已在运行，先结束原开发进程`);
        return true;
      }
      await docker(['image', 'inspect', image]);
      await docker([
        'create',
        '--name',
        container,
        '--restart=no',
        '--memory=256m',
        '--label',
        `${ownerLabel}=${projectRoot}`,
        '--label',
        `sve.dev.ports=${port}:${monitorPort}`,
        '--publish',
        `127.0.0.1:${monitorPort}:8080`,
        '--add-host',
        'host.docker.internal:host-gateway',
        '--env',
        'GATUS_CONFIG_PATH=/config',
        '--env',
        `SVE_BASE_URL=${target}`,
        '--volume',
        `${join(projectRoot, 'gatus')}:/config:ro`,
        '--volume',
        'sve-gatus-dev-data:/data',
        image,
      ]);
      return true;
    } catch (error) {
      runtime.log(`跳过可用性监控：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 启动容器并确认真的在跑、面板可达。失败只停掉监控，不影响后端。 */
  async function startMonitor(): Promise<boolean> {
    try {
      await docker(['start', container]);
      if (abort.signal.aborted) return false;
      if (!(await running())) throw new Error('容器启动后退出，看 docker logs sve-gatus-dev');
      await waitHealthy(monitorUrl);
      runtime.log(`可用性面板 http://localhost:${monitorPort}`);
      return true;
    } catch (error) {
      if (!abort.signal.aborted) {
        runtime.log(`监控启动失败，后端继续：${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  /** 运行中巡检；监控本身坏了只报告，不终止开发进程。 */
  async function watchMonitor(): Promise<void> {
    let failures = 0;
    while (!abort.signal.aborted) {
      await runtime.sleep(2000);
      if (abort.signal.aborted) break;
      try {
        if (!(await running())) throw new Error('容器已退出');
        failures = (await runtime.healthy(monitorUrl)) ? 0 : failures + 1;
        if (failures >= 3) throw new Error('面板连续三次未响应');
      } catch (error) {
        if (!abort.signal.aborted) {
          runtime.log(`监控已停止，后端继续：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
    }
  }

  try {
    // 预检与建容器都可跳过：监控是附加能力，缺 Docker 不该挡住后端。
    const monitorPlanned = await prepareMonitor();
    if (abort.signal.aborted) return exitCode;
    try {
      dev = runtime.spawn();
    } catch (error) {
      runtime.log(`启动开发进程失败：${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const spawned = dev;
    void spawned.exited.then((code) => {
      finished = true;
      if (!abort.signal.aborted) {
        exitCode = code;
        abort.abort();
      }
    });
    if (abort.signal.aborted) return exitCode;
    await waitHealthy(backendUrl);
    if (abort.signal.aborted) return exitCode;
    if (monitorPlanned) {
      stopMonitor = true;
      if (await startMonitor()) await watchMonitor();
    } else {
      runtime.log(`后端已就绪：http://localhost:${port}（可用性监控已跳过）`);
    }
    if (!abort.signal.aborted) {
      exitCode = await spawned.exited;
      finished = true;
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      exitCode = 1;
      runtime.log(`启动或监控失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    abort.abort();
    if (dev && !finished) {
      dev.kill();
      await Promise.race([dev.exited, runtime.sleep(3000)]);
      if (!finished) {
        dev.kill(9);
        await dev.exited;
      }
    }
    if (stopMonitor) {
      try {
        await docker(['stop', '--time', '5', container]);
        if (await running()) throw new Error('停止后容器仍在运行');
        runtime.log('Gatus 已停止，监控历史保留');
      } catch (error) {
        exitCode ||= 1;
        runtime.log(`停止监控失败：${String(error)}。请执行 docker stop sve-gatus-dev`);
      }
    }
    offSignal();
  }
  return exitCode;
}

/** 真实运行时：docker CLI、子进程、HTTP 探测。开发命令可替换，测试用。 */
export function createBunRuntime(
  projectRoot: string,
  devCommand: string[] = ['bun', '--watch', 'src/index.ts'],
): DevRuntime {
  return {
    async exec(args) {
      const proc = Bun.spawn(['docker', ...args], {
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => proc.kill(9), 15_000);
      try {
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code, out, err };
      } finally {
        clearTimeout(timer);
      }
    },
    spawn: () =>
      Bun.spawn(devCommand, {
        cwd: projectRoot,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: process.env,
      }),
    async healthy(url) {
      try {
        const init: RequestInit & { proxy: null } = {
          signal: AbortSignal.timeout(1500),
          proxy: null,
        };
        const response = await fetch(url, init);
        await response.arrayBuffer();
        return response.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    onSignal(handler) {
      const interrupt = () => handler('SIGINT');
      const terminate = () => handler('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      return () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      };
    },
    log: (message) => console.log(message),
  };
}

if (import.meta.main) {
  process.exitCode = await runDev(createBunRuntime(root), {
    port: Number(process.env.PORT ?? 7777),
    monitorPort: Number(process.env.GATUS_PORT ?? 8080),
    root,
  });
}
