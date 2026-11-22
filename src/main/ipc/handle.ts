import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ApiResponse } from '@shared/api'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { markActivity } from '../services/ai/dreamService'

const log = getLogger('ipc')

// 注册 IPC 处理器并统一包装响应：业务异常返回其错误码，其余异常只记录类型与信息，不记录入参
export function handle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<ApiResponse<TResult>> => {
    // 界面上的每次调用都算“你在用”，诺诺空闲几分钟后才开始做梦
    markActivity()
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
