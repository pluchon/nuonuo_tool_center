import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel, type ThemeMode } from '@shared/api'
import type { DataPaths } from '../config/paths'
import { BizError } from '../common/bizError'
import { bootDatabase, getDbBootState, type DatabaseLocation } from '../services/databaseService'
import { listFolders } from '../services/folderService'
import { addRoot, getOverview, relocateRoot } from '../services/libraryService'
import { getScanState, startScan, stopScan } from '../services/scan/scanService'
import { getSettings, updateSettings } from '../services/settingsService'
import { applyWindowTheme, toggleMaximize } from '../window/windowControl'
import { handle } from './handle'

// 取发起调用的窗口；窗口已关闭时报错
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) {
    throw new BizError('NOT_FOUND', '窗口已关闭')
  }
  return win
}

// 需要数据库的调用先确认数据库已打开
function requireDatabase(): void {
  if (getDbBootState() !== 'READY') {
    throw new BizError('DEPENDENCY_FAILED', '图库数据还没打开')
  }
}

// 注册全部 IPC 处理器：只做参数绑定与调用服务
export function registerIpcHandlers(paths: DataPaths, location: DatabaseLocation): void {
  handle(IpcChannel.systemGetBootState, async () => getDbBootState())
  handle(IpcChannel.systemRetryDatabase, async () => bootDatabase(location))

  handle(IpcChannel.settingsGet, async () => {
    requireDatabase()
    return getSettings()
  })
  handle(IpcChannel.settingsUpdate, async (_event, patch: unknown) => {
    requireDatabase()
    return updateSettings(patch)
  })

  handle(IpcChannel.libraryGetOverview, async () => {
    requireDatabase()
    return getOverview(paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryAddRoot, async (_event, path: string) => {
    requireDatabase()
    return addRoot(path, paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryRelocateRoot, async (_event, id: number, path: string) => {
    requireDatabase()
    if (!Number.isInteger(id)) {
      throw new BizError('BAD_REQUEST', '目录 id 不对')
    }
    return relocateRoot(id, path, paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryListFolders, async (_event, parent: string | null) => {
    requireDatabase()
    return listFolders(parent, paths.categoryHomeOverride)
  })

  handle(IpcChannel.scanStart, async (_event, rootId: number | null) => {
    requireDatabase()
    if (rootId !== null && !Number.isInteger(rootId)) {
      throw new BizError('BAD_REQUEST', '目录 id 不对')
    }
    return startScan(rootId)
  })
  handle(IpcChannel.scanStop, async () => stopScan())
  handle(IpcChannel.scanGetState, async () => getScanState())

  handle(IpcChannel.windowSetTheme, async (event, theme: ThemeMode) => {
    if (theme !== 'light' && theme !== 'dark') {
      throw new BizError('BAD_REQUEST', '未知主题')
    }
    applyWindowTheme(senderWindow(event), theme)
  })
  handle(IpcChannel.windowMinimize, async (event) => {
    senderWindow(event).minimize()
  })
  handle(IpcChannel.windowToggleMaximize, async (event) => {
    toggleMaximize(senderWindow(event))
  })
  handle(IpcChannel.windowClose, async (event) => {
    senderWindow(event).close()
  })
}
