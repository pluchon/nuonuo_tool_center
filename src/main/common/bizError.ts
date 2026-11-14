import type { ApiErrorCode } from '@shared/api'

// 业务异常：携带可展示给用户的错误码与信息，IPC 层统一转换为失败响应
export class BizError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'BizError'
    this.code = code
  }
}
