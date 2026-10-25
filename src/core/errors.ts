/** 业务错误：code 是稳定枚举，httpStatus 由 error-handler 统一映射 */
export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_CONTENT'
  | 'CONTENT_NOT_FOUND'
  | 'CONTENT_RESTRICTED'
  | 'AUTH_REQUIRED'
  | 'RISK_CONTROL'
  | 'UPSTREAM_CHANGED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  UNSUPPORTED_PLATFORM: 422,
  UNSUPPORTED_CONTENT: 422,
  CONTENT_NOT_FOUND: 404,
  CONTENT_RESTRICTED: 403,
  AUTH_REQUIRED: 424,
  RISK_CONTROL: 503,
  UPSTREAM_CHANGED: 502,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}
