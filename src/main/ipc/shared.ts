import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { BizError } from '../common/bizError'
import { getDbBootState } from '../services/databaseService'
import { scheduleEmbedding } from '../services/ai/embeddingService'

// 取发起调用的窗口；窗口已关闭时报错
export function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) {
    throw new BizError('NOT_FOUND', '窗口已关闭')
  }
  return win
}

// 需要数据库的调用先确认数据库已打开
export function requireDatabase(): void {
  if (getDbBootState() !== 'READY') {
    throw new BizError('DEPENDENCY_FAILED', '图库数据还没打开')
  }
}

// 标签或复核状态提交成功后，已有图库可能首次出现可建立向量索引的图片。
export function refreshImageIndex<T>(result: T): T {
  scheduleEmbedding()
  return result
}
