import type { ErrorCode } from './errors';

/** 唯一响应工厂：所有路由的返回都经过这里，保证信封一致 */
interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error?: { code: ErrorCode; message: string; detail?: Record<string, unknown> };
}

export function ok<T>(data: T): ApiEnvelope<T> {
  return { success: true, data };
}

export function fail(code: ErrorCode, message: string, detail?: Record<string, unknown>): ApiEnvelope<never> {
  return { success: false, data: null, error: { code, message, detail } };
}
