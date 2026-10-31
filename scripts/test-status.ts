#!/usr/bin/env bun
/**
 * 一条命令看全状态：prettier → typecheck → bun test → 覆盖率摘要 → CI。
 * 退出码只由本地三步（prettier / tsc / bun test）决定；覆盖率与 CI 是附注节，
 * gh 不存在或失败显示 skip，不算失败。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const root = join(import.meta.dir, '..');
const REPO = 'hey-yx/allparse';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

async function run(cmd: string[], timeoutMs: number): Promise<RunResult> {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd,
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, ms: performance.now() - started };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function tail(text: string, lines = 30): string {
  const all = text.trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

const merged = (r: RunResult) => `${r.stdout}\n${r.stderr}`;

interface Step {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function step(
  name: string,
  cmd: string[],
  timeoutMs: number,
  detail: (r: RunResult) => string,
): Promise<Step> {
  const r = await run(cmd, timeoutMs);
  return { name, ok: r.code === 0, detail: detail(r), ms: r.ms };
}

function parseTestSummary(out: string): string {
  const pass = out.match(/^\s*(\d+) pass\s*$/m)?.[1] ?? '?';
  const fail = out.match(/^\s*(\d+) fail\s*$/m)?.[1] ?? '?';
  const expects = out.match(/^\s*(\d+) expect\(\) calls\s*$/m)?.[1] ?? '?';
  const ran = out.match(/Ran (\d+) tests across (\d+) files\. \[([\d.]+)ms\]/);
  const files = ran ? ` · ${ran[2]} files` : '';
  return `${pass} 用例 ${fail} fail ${expects} expect${files}`;
}

/** lcov.info → 按目录聚合行覆盖（src/ 下取前两级，其余取所在目录） */
function coverageSummary(covDir: string): string {
  const info = readFileSync(join(covDir, 'lcov.info'), 'utf8');
  const dirs = new Map<string, { lf: number; lh: number }>();
  let totalLf = 0;
  let totalLh = 0;
  for (const block of info.split('end_of_record')) {
    const sf = block.match(/^SF:(.+)$/m)?.[1];
    const lf = Number(block.match(/^LF:(\d+)$/m)?.[1] ?? 0);
    const lh = Number(block.match(/^LH:(\d+)$/m)?.[1] ?? 0);
    if (!sf) continue;
    const parts = sf.split(sep);
    const dir =
      parts[0] === 'src' && parts.length > 2 ? parts.slice(0, 2).join(sep) : parts.slice(0, -1).join(sep);
    const cur = dirs.get(dir) ?? { lf: 0, lh: 0 };
    cur.lf += lf;
    cur.lh += lh;
    dirs.set(dir, cur);
    totalLf += lf;
    totalLh += lh;
  }
  const pct = (x: { lf: number; lh: number }) => (x.lf === 0 ? '—' : `${((x.lh / x.lf) * 100).toFixed(1)}%`);
  const parts = [...dirs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dir, x]) => `${dir} ${pct(x)}`);
  parts.push(`全仓 ${pct({ lf: totalLf, lh: totalLh })}`);
  return parts.join('、');
}

async function ciStatus(): Promise<string> {
  if (!Bun.which('gh')) return 'skip（gh 不存在）';
  try {
    const r = await run(
      [
        'gh',
        'run',
        'list',
        '--repo',
        REPO,
        '--limit',
        '1',
        '--json',
        'displayTitle,status,conclusion,headBranch,createdAt',
      ],
      20_000,
    );
    if (r.code !== 0) return 'skip（gh 失败）';
    const runs = JSON.parse(r.stdout.trim() || '[]') as Array<{
      displayTitle: string;
      status: string;
      conclusion: string | null;
      headBranch: string;
      createdAt: string;
    }>;
    const latest = runs[0];
    if (!latest) return 'skip（无 run）';
    const verdict = latest.conclusion ?? latest.status;
    return `${verdict} · ${latest.headBranch} · ${latest.displayTitle} · ${latest.createdAt}`;
  } catch {
    return 'skip（gh 解析失败）';
  }
}

const steps: Step[] = [];

steps.push(
  await step('prettier', ['bun', 'x', 'prettier', '--check', 'src', 'tests', 'scripts'], 120_000, (r) =>
    r.code === 0 ? 'src tests scripts 全部符合格式' : tail(merged(r)),
  ),
);
steps.push(
  await step('tsc', ['bun', 'x', 'tsc', '--noEmit'], 120_000, (r) =>
    r.code === 0 ? '零错误' : tail(merged(r)),
  ),
);
steps.push(
  await step('bun test', ['bun', 'test'], 300_000, (r) =>
    r.code === 0 ? parseTestSummary(merged(r)) : tail(merged(r)),
  ),
);

let coverageLine = 'skip';
const covDir = mkdtempSync(join(tmpdir(), 'allparse-cov-'));
try {
  const r = await run(
    ['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir', covDir],
    300_000,
  );
  coverageLine = r.code === 0 ? coverageSummary(covDir) : `skip（覆盖率采集失败）`;
} catch {
  coverageLine = 'skip（覆盖率采集失败）';
} finally {
  rmSync(covDir, { recursive: true, force: true });
}

const ciLine = await ciStatus();

for (const s of steps) {
  console.log(`${s.ok ? '✅' : '❌'} ${s.name.padEnd(10)} ${secs(s.ms).padStart(6)}  ${s.detail}`);
}
console.log(`📊 覆盖率（行）：${coverageLine}`);
console.log(`🔁 CI：${ciLine}`);

const failed = steps.filter((s) => !s.ok);
const totalMs = steps.reduce((a, s) => a + s.ms, 0);
if (failed.length === 0) {
  console.log(`test:status 全绿：${steps.map((s) => `${s.name} ✅`).join('、')}、总耗时 ${secs(totalMs)}`);
  process.exit(0);
}
console.log(`test:status 未通过：${failed.map((s) => s.name).join('、')}、总耗时 ${secs(totalMs)}`);
process.exit(1);
