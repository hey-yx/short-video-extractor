#!/usr/bin/env bun
/**
 * 本地开发 + 监控一条命令：起 bun dev，等它 /health 通了再拉起 Docker 里的 Gatus，
 * 退出（Ctrl-C / 编译失败 / SIGTERM）时把 Gatus 一起停掉，Docker 不留在后台空转。
 *
 * 用法：
 *   bun run dev:stack              # 默认 bun --watch src/index.ts
 *   bun run dev:stack -- bun src/index.ts   # 换掉开发进程命令
 *
 * 只动 Gatus 一个容器；app 服务容器在 docker-compose.override.yml 里被 profile 关掉了
 * （要复现容器部署形态时显式 --profile docker-app up -d app）。
 */
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const port = Number(process.env.PORT ?? 7777);
const healthUrl = `http://127.0.0.1:${port}/health`;
const HEALTH_TIMEOUT_MS = 30_000;

const passthrough = process.argv.slice(2);
const devCmd = passthrough.length > 0 ? passthrough : ['bun', '--watch', 'src/index.ts'];

const log = (msg: string) => console.log(`[dev-stack] ${msg}`);

async function composeUp(): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['docker', 'compose', 'up', '-d', 'gatus'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (out.trim()) console.log(out.trim());
  if (err.trim()) console.error(err.trim());
  return code;
}

/** 收尾必须走同步调用：进程一 exit，Bun 会连带杀掉未完成的子进程，异步 stop 会半途夭折。 */
function composeStopSync(): number {
  const result = Bun.spawnSync({
    cmd: ['docker', 'compose', 'stop', 'gatus'],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode ?? 1;
}

/** 等开发服务自己的 /health 通；进程提前退出或超时都返回 false，不阻塞收尾。 */
async function waitForHealth(dev: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) return false;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await Bun.sleep(400);
  }
  return false;
}

log(`启动开发进程: ${devCmd.join(' ')}（端口 ${port}）`);
const dev = Bun.spawn({
  cmd: devCmd,
  cwd: root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: process.env,
});

let gatusUp = false;
let stopping = false;

async function shutdown(code: number): Promise<never> {
  if (stopping) process.exit(code);
  stopping = true;
  dev.kill();
  if (gatusUp) {
    log('开发进程结束，停 Gatus…');
    if (composeStopSync() !== 0) log('停 Gatus 失败，手动收尾: docker compose stop gatus');
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

if (await waitForHealth(dev)) {
  log(`/health 已通，拉起 Gatus: http://localhost:${process.env.GATUS_PORT ?? 8080}`);
  gatusUp = (await composeUp()) === 0;
  if (!gatusUp) log('Gatus 没起来（Docker Desktop 没运行？），解析服务继续跑，退出时不会动容器');
} else if (dev.exitCode === null) {
  log(
    `${HEALTH_TIMEOUT_MS / 1000}s 内 /health 没通，先不起 Gatus；服务起好后可另开终端 docker compose up -d gatus`,
  );
} else {
  log('开发进程已退出，不启动 Gatus');
}

await shutdown((await dev.exited) ?? 0);
