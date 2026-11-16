import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ApiResponse } from '@shared/api'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'

const log = getLogger('ipc')

// 注册 IPC 处理器并统一包装响应：业务异常返回其错误码，其余异常只记录类型与信息，不记录入参
export function handle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<ApiResponse<TResult>> => {
    try {
      const data = await fn(event, ...(args as TArgs))
      return { ok: true, data }
    } catch (err) {
      if (err instanceof BizError) {
        return { ok: false, code: err.code, message: err.message }
      }
      log.error(`${channel} 失败`, err)
      return { ok: false, code: 'INTERNAL', message: '内部错误，请查看日志' }
    }
  })
}
