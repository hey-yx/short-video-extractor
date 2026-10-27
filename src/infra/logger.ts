import pino from 'pino';
import type { DestinationStream } from 'pino';
import type { FetchCtx } from '@/types/platform';

/**
 * pino 结构化日志。
 * 两道防线保证 url query（xsec_token 等）不进日志：
 *  1. 记录点显式用 redactUrl()/redactRequestUrl()（请求日志、错误消息）
 *  2. formatters.log 对最终输出对象做深度 redact 兜底（含 AppError.detail、Error 实例）
 */

const REDACTED = 'REDACTED';

/** 行内 URL（消息文本里夹带的链接，正则保证不含空白与常见包裹符） */
const INLINE_URL = /https?:\/\/[^\s"'<>）」』\]]+/g;

/** 参数名含这些词的 query 值直接打码 */
const SECRET_PARAM_RE = /token|secret|sig|key|pass|auth|cookie/i;

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

function resolveLevel(): string {
  const v = process.env.LOG_LEVEL;
  return v && (LEVELS as readonly string[]).includes(v) ? v : 'info';
}

/** URL 或相对路径的 query 值整体打码，参数名保留（参数名本身不含秘密） */
export function redactUrl(value: string): string {
  const q = value.indexOf('?');
  if (q === -1) return value;
  try {
    const u = new URL(value);
    for (const [k] of u.searchParams) u.searchParams.set(k, REDACTED);
    return u.toString();
  } catch {
    // 相对路径形态（/parse?url=...）：query 到下一个空白/引号为止
    let end = value.length;
    for (let i = q + 1; i < value.length; i++) {
      const c = value[i]!;
      if (c === ' ' || c === '"' || c === "'") {
        end = i;
        break;
      }
    }
    return `${value.slice(0, q + 1)}${REDACTED}${value.slice(end)}`;
  }
}

/**
 * 请求 URL 脱敏：保留 pathname 与可读的嵌套链接（去掉其 query），
 * 嵌套 URL（如 GET /parse?url=https://...xsec_token=...）解码后递归脱敏。
 */
export function redactRequestUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const [k, v] of u.searchParams) {
      if (/^https?:\/\//.test(v)) {
        u.searchParams.set(k, redactUrl(v));
      } else if (SECRET_PARAM_RE.test(k)) {
        u.searchParams.set(k, REDACTED);
      }
    }
    const q = u.searchParams.toString();
    return `${u.pathname}${q ? `?${q}` : ''}`;
  } catch {
    return redactUrl(rawUrl);
  }
}

/** 文本内所有 URL 的 query 打码（用于 message、title 等自由文本字段） */
export function redactText(text: string): string {
  return text.replace(INLINE_URL, (u) => redactUrl(u));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth === 0) return value;
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    const plain: Record<string, unknown> = { name: value.name, message: redactText(value.message) };
    // stack 里会带上出错时的 URL（含 query），必须走同一套脱敏，否则等于从后门漏出去
    if (value.stack) plain.stack = redactText(value.stack);
    for (const [k, v] of Object.entries(value)) plain[k] = redactValue(v, depth - 1);
    return plain;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth - 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, depth - 1);
    return out;
  }
  return value;
}

function redactLog(obj: Record<string, unknown>): Record<string, unknown> {
  return redactValue(obj, 4) as Record<string, unknown>;
}

export function createLogger(destination?: DestinationStream): pino.Logger {
  return pino({ level: resolveLevel(), base: undefined, formatters: { log: redactLog } }, destination);
}

export const logger = createLogger();

// ---- 每请求关联：requestId 与计时挂在 Request 实例上（WeakMap，零侵入路由签名）----

interface RequestMeta {
  id: string;
  startedAt: number;
}

const requestMeta = new WeakMap<Request, RequestMeta>();

/** 取（或首次生成）请求的 requestId；同一次请求内恒定 */
export function reqIdOf(request: Request): string {
  let meta = requestMeta.get(request);
  if (!meta) {
    meta = {
      id: request.headers.get('x-request-id')?.trim() || crypto.randomUUID(),
      startedAt: performance.now(),
    };
    requestMeta.set(request, meta);
  }
  return meta.id;
}

export function reqStartedAt(request: Request): number {
  return requestMeta.get(request)?.startedAt ?? performance.now();
}

/** 请求级子 logger（info/warn/error 自动带 requestId） */
export function requestLogger(request: Request): pino.Logger {
  return logger.child({ reqId: reqIdOf(request) });
}

/** 适配 FetchCtx.logger 的调用约定（msg 在前，data 在后） */
export function asFetchLogger(log: pino.Logger): FetchCtx['logger'] {
  return {
    info: (msg, data) => log.info(data ?? {}, msg),
    warn: (msg, data) => log.warn(data ?? {}, msg),
    error: (msg, data) => log.error(data ?? {}, msg),
  };
}
