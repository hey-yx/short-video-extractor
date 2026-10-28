import { beforeEach, describe, expect, test } from 'bun:test';
import { metrics } from '@/infra/metrics';

/** 把 render() 输出里某 platform 的 bucket 值按 le 升序抽成数组（含 +Inf） */
function bucketValues(platform: string): number[] {
  return metrics
    .render()
    .split('\n')
    .filter((l) => l.startsWith(`parse_duration_ms_bucket{platform="${platform}"`))
    .map((l) => Number(l.split(' ').at(-1)));
}

describe('infra/metrics uifid 身份池指标', () => {
  beforeEach(() => metrics.reset());

  test('铸造/退休计数进 /metrics 文本（带 result / reason 标签）', () => {
    metrics.inc('uifid_mint_total', { result: 'ok' });
    metrics.inc('uifid_mint_total', { result: 'fail' });
    metrics.inc('uifid_retired_total', { reason: 'suspect' });

    const text = metrics.render();
    expect(text).toContain('# TYPE uifid_mint_total counter');
    expect(text).toContain('uifid_mint_total{result="ok"} 1');
    expect(text).toContain('uifid_mint_total{result="fail"} 1');
    expect(text).toContain('# TYPE uifid_retired_total counter');
    expect(text).toContain('uifid_retired_total{reason="suspect"} 1');
  });

  test('从未铸造过：不补无标签 0 序列（label 集合保持一致）', () => {
    const text = metrics.render();
    expect(text).toContain('# HELP uifid_mint_total');
    expect(text).not.toMatch(/^uifid_mint_total /m);
    expect(text).not.toMatch(/^uifid_retired_total /m);
  });
});

describe('infra/metrics histogram（Prometheus 累计语义）', () => {
  beforeEach(() => metrics.reset());

  test('单次观测：各桶为累计计数，序列单调不增反例不再出现', () => {
    metrics.observe('parse_duration_ms', { platform: 't' }, 30);
    // 30ms 落进所有 le≥50 的桶：le=50..30000 均 1，+Inf 1
    expect(bucketValues('t')).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  test('多次观测：桶值 = value ≤ le 的观测次数（累计），+Inf = 总次数', () => {
    metrics.observe('parse_duration_ms', { platform: 'u' }, 30); // ≤ 全部桶
    metrics.observe('parse_duration_ms', { platform: 'u' }, 200); // ≤ le=250..30000
    metrics.observe('parse_duration_ms', { platform: 'u' }, 8000); // ≤ le=10000,30000
    // le: 50,100,250,500,1000,2000,5000,10000,30000,+Inf
    expect(bucketValues('u')).toEqual([1, 1, 2, 2, 2, 2, 2, 3, 3, 3]);
  });
});
