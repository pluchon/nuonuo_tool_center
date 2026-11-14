import type { ApiErrorCode, ApiResponse } from '@shared/api'

// 渲染进程侧的调用失败，保留主进程给出的错误码
export class ApiError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

// 解包统一响应：成功返回 data，失败抛出 ApiError
export async function unwrap<T>(call: Promise<ApiResponse<T>>): Promise<T> {
  const res = await call
  if (res.ok) {
    return res.data
  }
  throw new ApiError(res.code, res.message)
}
