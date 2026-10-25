/**
 * 轻量 Prometheus 指标：自写文本格式渲染，不引 prom-client（依赖要瘦）。
 * Bun 单线程，Map 直读直写；低频自用场景无性能压力。
 *
 * 指标清单（PLAN §14 / research 03 §6.6）：
 *  - parse_total{platform,code}        解析计数（code = ok 或业务错误码）
 *  - parse_duration_ms (histogram)     解析耗时分布
 *  - cache_hit_total                   缓存命中（P4 接入，先暴露 0）
 *  - upstream_error_total{platform,reason}  上游失败/风控
 */

type Labels = Readonly<Record<string, string>>;

const DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];

const counters = new Map<string, number>();
const histograms = new Map<string, { counts: number[]; sum: number; count: number }>();

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function series(name: string, labels?: Labels): string {
  if (!labels) return name;
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const inner = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `${name}{${inner}}`;
}

export const metrics = {
  inc(name: string, labels?: Labels, value = 1): void {
    const key = series(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + value);
  },

  observe(name: string, labels: Labels, value: number): void {
    const key = series(name, labels);
    let h = histograms.get(key);
    if (!h) {
      h = { counts: new Array<number>(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      histograms.set(key, h);
    }
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      if (value <= DURATION_BUCKETS[i]!) h.counts[i]!++;
    }
    h.sum += value;
    h.count++;
  },

  /** Prometheus 文本格式（version 0.0.4） */
  render(): string {
    const lines: string[] = [];

    lines.push('# HELP parse_total 解析请求计数（code=ok 或业务错误码）');
    lines.push('# TYPE parse_total counter');
    for (const [key, v] of sortedEntries(counters)) {
      if (key.startsWith('parse_total')) lines.push(`${key} ${v}`);
    }

    lines.push('# HELP parse_duration_ms 解析耗时分布（毫秒）');
    lines.push('# TYPE parse_duration_ms histogram');
    for (const [key, h] of sortedEntries(histograms)) {
      const labelPart = key.includes('{') ? key.slice(key.indexOf('{')) : '';
      for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        const cumulative = h.counts.slice(0, i + 1).reduce((a, b) => a + b, 0);
        lines.push(`parse_duration_ms_bucket${insertLabel(labelPart, `le="${DURATION_BUCKETS[i]}"`)} ${cumulative}`);
      }
      lines.push(`parse_duration_ms_bucket${insertLabel(labelPart, 'le="+Inf"')} ${h.count}`);
      lines.push(`parse_duration_ms_sum${labelPart} ${h.sum}`);
      lines.push(`parse_duration_ms_count${labelPart} ${h.count}`);
    }

    lines.push('# HELP cache_hit_total 缓存命中次数（P4 接入）');
    lines.push('# TYPE cache_hit_total counter');
    emitCounter(lines, counters, 'cache_hit_total');

    lines.push('# HELP upstream_error_total 上游失败/风控次数');
    lines.push('# TYPE upstream_error_total counter');
    emitCounter(lines, counters, 'upstream_error_total');

    return `${lines.join('\n')}\n`;
  },

  reset(): void {
    counters.clear();
    histograms.clear();
    prewarm();
  },
};

function prewarm(): void {
  metrics.inc('cache_hit_total', undefined, 0);
  metrics.inc('upstream_error_total', undefined, 0);
}

function emitCounter(lines: string[], source: Map<string, number>, prefix: string): void {
  let found = false;
  for (const [key, v] of sortedEntries(source)) {
    if (key === prefix || key.startsWith(`${prefix}{`)) {
      lines.push(`${key} ${v}`);
      found = true;
    }
  }
  if (!found) lines.push(`${prefix} 0`);
}

function sortedEntries<T>(m: Map<string, T>): Array<[string, T]> {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 把 le="..." 插进已有 label 块（{a="b"} → {a="b",le="50"}），无 label 则新建块 */
function insertLabel(labelPart: string, le: string): string {
  if (!labelPart) return `{${le}}`;
  return labelPart.replace(/\}$/, `,${le}}`);
}

export const recordParse = (platform: string, code: string): void => metrics.inc('parse_total', { platform, code });

export const observeParseDuration = (platform: string, ms: number): void =>
  metrics.observe('parse_duration_ms', { platform }, ms);

export const recordCacheHit = (): void => metrics.inc('cache_hit_total');

export const recordUpstreamError = (platform: string, reason: string): void =>
  metrics.inc('upstream_error_total', { platform, reason });
