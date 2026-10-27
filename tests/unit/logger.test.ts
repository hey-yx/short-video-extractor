import { afterEach, describe, expect, test } from 'bun:test';

import {
  asFetchLogger,
  createLogger,
  redactRequestUrl,
  redactText,
  redactUrl,
  reqIdOf,
  reqStartedAt,
  requestLogger,
} from '@/infra/logger';

/**
 * 日志脱敏离线用例：URL/文本 query 打码、Error 实例展开脱敏、requestId 关联。
 * 两道防线中的「记录点显式 redact」与「formatters.log 深度兜底」都覆盖。
 */

const savedLogLevel = process.env.LOG_LEVEL;

afterEach(() => {
  if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLogLevel;
});

describe('redactUrl：URL query 值整体打码，参数名保留', () => {
  test('完整 URL：所有 query 值 → REDACTED，参数名与 pathname 原样', () => {
    expect(redactUrl('https://v.douyin.com/x/?xsec_token=abc123&u_code=xyz789')).toBe(
      'https://v.douyin.com/x/?xsec_token=REDACTED&u_code=REDACTED',
    );
  });

  test('无 query 的 URL 原样返回', () => {
    expect(redactUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
  });

  test('相对路径形态（URL 解析失败走兜底）：query 打码到空白为止', () => {
    expect(redactUrl('/parse?url=https%3A%2F%2Fa.com')).toBe('/parse?REDACTED');
    expect(redactUrl('/parse?url=abc def')).toBe('/parse?REDACTED def');
    expect(redactUrl('/parse?url=abc"x')).toBe('/parse?REDACTED"x');
  });
});

describe('redactRequestUrl：请求 URL 脱敏', () => {
  test('secret 参数名（sig/token 等）的值打码，普通参数保留', () => {
    const out = redactRequestUrl('http://localhost/media?sig=abc123&u=xyz&exp=1&foo=bar');
    expect(out).toContain('sig=REDACTED');
    expect(out).toContain('foo=bar');
    expect(out).not.toContain('abc123');
  });

  test('嵌套 http URL 参数递归脱敏（保留内层可读链接、去掉其 query）', () => {
    const out = redactRequestUrl('http://localhost/parse?url=https://v.douyin.com/x/?xsec_token=abc123');
    expect(out).toContain('url=https%3A%2F%2Fv.douyin.com');
    expect(out).toContain('xsec_token%3DREDACTED');
    expect(out).not.toContain('abc123');
  });

  test('无 query：只回 pathname', () => {
    expect(redactRequestUrl('http://localhost/health')).toBe('/health');
  });

  test('非法 URL 兜底走 redactUrl 相对路径分支', () => {
    expect(redactRequestUrl('not a url?token=1')).toBe('not a url?REDACTED');
  });
});

describe('redactText：自由文本里的行内 URL 打码', () => {
  test('消息文本夹带的 URL query 全部打码', () => {
    const out = redactText('失败链接 https://a.com/v?id=1&sig=2 以及）包裹 https://b.com/w?t=3');
    expect(out).toBe(
      '失败链接 https://a.com/v?id=REDACTED&sig=REDACTED 以及）包裹 https://b.com/w?t=REDACTED',
    );
    expect(out).not.toContain('id=1');
  });

  test('不含 URL 的文本原样返回', () => {
    expect(redactText('普通消息')).toBe('普通消息');
  });
});

describe('createLogger：formatters.log 深度兜底（Error 实例展开脱敏）', () => {
  test('Error 字段展开成 plain 对象，message/自定义属性里的 URL query 被打码', () => {
    let captured = '';
    const log = createLogger({
      write(s: string) {
        captured += s;
      },
    });
    const err = new Error('拉流失败 https://cdn.x.com/v?token=abc123');
    (err as Error & { detail?: unknown }).detail = { url: 'https://cdn.x.com/v?sig=def456' };
    log.error({ err }, 'boom');

    const line = JSON.parse(captured.trim().split('\n').pop()!) as {
      err: { name: string; message: string; stack?: string; detail?: { url: string } };
    };
    expect(line.err.name).toBe('Error');
    expect(line.err.message).toBe('拉流失败 https://cdn.x.com/v?token=REDACTED');
    expect(typeof line.err.stack).toBe('string');
    expect(line.err.detail?.url).toBe('https://cdn.x.com/v?sig=REDACTED');
    expect(line.err.detail?.url).not.toContain('def456');
    // 现状：stack 是原样保留的（未过脱敏），这里固化记录该行为
    expect(line.err.stack).toContain('token=abc123');
  });

  test('嵌套数组/对象字段递归打码', () => {
    let captured = '';
    const log = createLogger({
      write(s: string) {
        captured += s;
      },
    });
    log.info({ list: [{ u: 'https://a.com/?k=1' }] }, 'msg');
    expect(captured).toContain('k=REDACTED');
    expect(captured).not.toContain('k=1');
  });

  test('LOG_LEVEL 环境变量生效，非法值回退 info', () => {
    process.env.LOG_LEVEL = 'debug';
    expect(createLogger({ write() {} }).level).toBe('debug');
    process.env.LOG_LEVEL = 'bogus';
    expect(createLogger({ write() {} }).level).toBe('info');
    delete process.env.LOG_LEVEL;
    expect(createLogger({ write() {} }).level).toBe('info');
  });
});

describe('requestId 关联与子 logger', () => {
  test('reqIdOf：透传 X-Request-Id，缺省生成 UUID 且同请求恒定', () => {
    const withId = new Request('http://localhost/', { headers: { 'x-request-id': 'req-fixture' } });
    expect(reqIdOf(withId)).toBe('req-fixture');
    expect(reqIdOf(withId)).toBe('req-fixture');

    const anon = new Request('http://localhost/');
    const id = reqIdOf(anon);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(reqIdOf(anon)).toBe(id);
  });

  test('reqStartedAt：已登记请求返回起点，未登记回当前时刻', () => {
    const req = new Request('http://localhost/');
    expect(typeof reqStartedAt(req)).toBe('number');
    const id = reqIdOf(req); // 登记后 WeakMap 有记录
    expect(typeof id).toBe('string');
    expect(reqStartedAt(req)).toBeLessThanOrEqual(performance.now());
  });

  test('asFetchLogger：msg 在前、data 在后的调用约定适配', () => {
    const seen: Array<{ level: string; data: unknown; msg: unknown }> = [];
    const fake = {
      info: (data: unknown, msg: unknown) => seen.push({ level: 'info', data, msg }),
      warn: (data: unknown, msg: unknown) => seen.push({ level: 'warn', data, msg }),
      error: (data: unknown, msg: unknown) => seen.push({ level: 'error', data, msg }),
    };
    const fetchLog = asFetchLogger(fake as never);
    fetchLog.info('一条消息', { a: 1 });
    fetchLog.warn('警告', undefined);
    fetchLog.error('错误');

    expect(seen).toEqual([
      { level: 'info', data: { a: 1 }, msg: '一条消息' },
      { level: 'warn', data: {}, msg: '警告' },
      { level: 'error', data: {}, msg: '错误' },
    ]);
  });

  test('requestLogger：子 logger 可用且 reqIdOf 绑定同请求恒定', () => {
    const req = new Request('http://localhost/', { headers: { 'x-request-id': 'rid-1' } });
    const child = requestLogger(req);
    expect(typeof child.info).toBe('function');
    expect(reqIdOf(req)).toBe('rid-1');
  });
});
