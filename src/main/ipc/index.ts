import { BrowserWindow, dialog } from 'electron'
import { IpcChannel } from '@shared/api'
import type { DataPaths } from '../config/paths'
import { BizError } from '../common/bizError'
import { addRoot, listRoots } from '../services/libraryService'
import { getSystemInfo } from '../services/systemService'
import { handle } from './handle'

// 注册全部 IPC 处理器：只做参数绑定与调用服务
export function registerIpcHandlers(paths: DataPaths): void {
  handle(IpcChannel.systemGetInfo, async () => getSystemInfo(paths.root))
  handle(IpcChannel.libraryListRoots, async () => listRoots())
  handle(IpcChannel.libraryAddRoot, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择要导入的图片目录', properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) {
      throw new BizError('CANCELLED', '已取消选择')
    }
    return addRoot(picked.filePaths[0])
  })
}
