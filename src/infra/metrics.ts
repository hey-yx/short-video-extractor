/**
 * 轻量 Prometheus 指标：自写文本格式渲染，不引 prom-client（依赖要瘦）。
 * Bun 单线程，Map 直读直写；低频自用场景无性能压力。
 *
 * 指标清单（research 03 §6.6）：
 *  - parse_total{platform,code}        解析计数（code = ok 或业务错误码）
 *  - parse_duration_ms (histogram)     解析耗时分布
 *  - cache_hit_total                   缓存命中（P4 接入，先暴露 0）
 *  - upstream_error_total{platform,reason}  上游失败/风控
 *  - channel_downgrade_total{platform,from,to}  通道降级
 *  - parse_retry_total{platform}       瞬态错误重试
 *  - channel_breaker_open{platform}    熔断粘性 gauge
 *  - uifid_mint_total{result} / uifid_retired_total{reason}  抖音 uifid 身份池
 */

type Labels = Readonly<Record<string, string>>;

const DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];

const counters = new Map<string, number>();
const histograms = new Map<string, { counts: number[]; sum: number; count: number }>();
/** gauge（熔断等状态量）：每次 render 时取即时值，不累加 */
const gauges = new Map<string, number>();

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

  /** gauge：直接设值（不是累加）；render 时原样输出 */
  setGauge(name: string, labels: Labels, value: number): void {
    gauges.set(series(name, labels), value);
  },

  observe(name: string, labels: Labels, value: number): void {
    const key = series(name, labels);
    let h = histograms.get(key);
    if (!h) {
      h = { counts: new Array<number>(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      histograms.set(key, h);
    }
    // Prometheus 语义：bucket 是累计计数。这里只记首个命中桶，render() 统一做前缀和
    const idx = DURATION_BUCKETS.findIndex((b) => value <= b);
    if (idx >= 0) h.counts[idx]!++;
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
        lines.push(
          `parse_duration_ms_bucket${insertLabel(labelPart, `le="${DURATION_BUCKETS[i]}"`)} ${cumulative}`,
        );
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

    lines.push('# HELP channel_downgrade_total 解析通道降级次数（platform, from→to）');
    lines.push('# TYPE channel_downgrade_total counter');
    emitCounter(lines, counters, 'channel_downgrade_total');

    lines.push('# HELP parse_retry_total 瞬态错误重试次数');
    lines.push('# TYPE parse_retry_total counter');
    emitCounter(lines, counters, 'parse_retry_total');

    // uifid 身份池：带标签（result / reason），只在真发生过时输出，不伪造无标签 0 序列
    lines.push('# HELP uifid_mint_total uifid 铸造次数（result=ok|fail；身份池自动铸造访客身份）');
    lines.push('# TYPE uifid_mint_total counter');
    emitSeenCounter(lines, counters, 'uifid_mint_total');

    lines.push('# HELP uifid_retired_total uifid 退休次数（reason=suspect|evicted）');
    lines.push('# TYPE uifid_retired_total counter');
    emitSeenCounter(lines, counters, 'uifid_retired_total');

    lines.push('# HELP channel_breaker_open 通道熔断粘性状态（1=该平台 HTTP 通道熔断中，固定走浏览器）');
    lines.push('# TYPE channel_breaker_open gauge');
    for (const [key, v] of sortedEntries(gauges)) {
      if (key.startsWith('channel_breaker_open')) lines.push(`${key} ${v}`);
    }

    return `${lines.join('\n')}\n`;
  },

  reset(): void {
    counters.clear();
    histograms.clear();
    gauges.clear();
    prewarm();
  },
};

function prewarm(): void {
  metrics.inc('cache_hit_total', undefined, 0);
  metrics.inc('upstream_error_total', undefined, 0);
  metrics.inc('channel_downgrade_total', undefined, 0);
  metrics.inc('parse_retry_total', undefined, 0);
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

/** 只输出已出现的序列：带标签的计数器不补无标签 0 基线（否则同一指标混出两种 label 集合） */
function emitSeenCounter(lines: string[], source: Map<string, number>, prefix: string): void {
  for (const [key, v] of sortedEntries(source)) {
    if (key === prefix || key.startsWith(`${prefix}{`)) lines.push(`${key} ${v}`);
  }
}

function sortedEntries<T>(m: Map<string, T>): Array<[string, T]> {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 把 le="..." 插进已有 label 块（{a="b"} → {a="b",le="50"}），无 label 则新建块 */
function insertLabel(labelPart: string, le: string): string {
  if (!labelPart) return `{${le}}`;
  return labelPart.replace(/\}$/, `,${le}}`);
}

export const recordParse = (platform: string, code: string): void =>
  metrics.inc('parse_total', { platform, code });

export const observeParseDuration = (platform: string, ms: number): void =>
  metrics.observe('parse_duration_ms', { platform }, ms);

export const recordCacheHit = (): void => metrics.inc('cache_hit_total');

export const recordUpstreamError = (platform: string, reason: string): void =>
  metrics.inc('upstream_error_total', { platform, reason });

export const recordChannelDowngrade = (platform: string, from: string, to: string): void =>
  metrics.inc('channel_downgrade_total', { platform, from, to });

export const recordParseRetry = (platform: string): void => metrics.inc('parse_retry_total', { platform });

/** 通道熔断状态发布到 /metrics（ops routes 每次抓取时刷新即时值） */
export function recordChannelBreaker(platform: string, open: boolean): void {
  metrics.setGauge('channel_breaker_open', { platform }, open ? 1 : 0);
}
