import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import { IpcChannel, type DbBootState, type ThemeMode } from '@shared/api'
import { BizError } from '../common/bizError'
import type { DataPaths } from '../config/paths'
import { getAiCredentialStatus, saveAiCredentialSettings } from '../services/aiCredentialSettings'
import { categoryHomeOf } from '../services/categoryHome'
import { bootDatabase, getDbBootState, type DatabaseLocation } from '../services/databaseService'
import { syncWatching } from '../services/scan/watchService'
import { getSettings, updateSettings } from '../services/settingsService'
import { backupFileName, cleanThumbCache, exportBackup, folderBytes, importCustomBackground } from '../services/systemService'
import { applySystemSettings } from '../window/systemSettings'
import { applyWindowTheme, toggleMaximize } from '../window/windowControl'
import { handle } from './handle'
import { requireDatabase, senderWindow } from './shared'

// 注册系统、设置、AI 凭证、备份与窗口控制 IPC 处理器
export function registerSystemIpc(paths: DataPaths, location: DatabaseLocation, onDatabaseReady: () => Promise<void>): void {
  let retry: Promise<DbBootState> | null = null
  handle(IpcChannel.systemGetBootState, async () => getDbBootState())
  handle(IpcChannel.systemRetryDatabase, async () => {
    if (retry) return retry
    if (getDbBootState() === 'READY') return 'READY'
    retry = bootDatabase(location).then(async state => {
      if (state === 'READY') await onDatabaseReady()
      return state
    }).finally(() => { retry = null })
    return retry
  })

  handle(IpcChannel.settingsGet, async () => {
    requireDatabase()
    return getSettings()
  })
  handle(IpcChannel.settingsUpdate, async (_event, patch: unknown) => {
    requireDatabase()
    const next = await updateSettings(patch)
    applySystemSettings(next, patch as Record<string, unknown>)
    if (Object.hasOwn(patch as object, 'watchChanges')) {
      await syncWatching()
    }
    return next
  })
  handle(IpcChannel.settingsGetAiCredentials, async () => getAiCredentialStatus())
  handle(IpcChannel.settingsSaveAiCredentials, async (_event, patch: unknown) => saveAiCredentialSettings(patch))
  // 自定义背景：选一张图，缩好存进数据目录再换上；取消返回 null
  handle(IpcChannel.settingsPickBackground, async (event) => {
    requireDatabase()
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: '选一张背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return null
    }
    return importCustomBackground(picked.filePaths[0], paths.backgrounds)
  })

  handle(IpcChannel.systemDataInfo, async () => {
    requireDatabase()
    return {
      dataDir: paths.root,
      cacheBytes: await folderBytes(paths.thumbs),
      version: app.getVersion(),
      categoryHome: await categoryHomeOf(paths.categoryHomeOverride)
    }
  })
  // Windows 自己的选文件夹对话框（导入源目录、重新选择位置、复制 / 移动到其他位置）；取消返回 null
  handle(IpcChannel.systemPickFolder, async (event, title: unknown) => {
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: typeof title === 'string' && title.length <= 40 ? title : '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })
  handle(IpcChannel.systemOpenDataDir, async () => {
    const err = await shell.openPath(paths.root)
    if (err) {
      throw new BizError('DEPENDENCY_FAILED', `打不开文件夹：${err}`)
    }
  })
  handle(IpcChannel.systemCleanCache, async () => {
    requireDatabase()
    return cleanThumbCache(paths.thumbs)
  })
  // 导出备份：系统的保存对话框选位置，取消返回 null
  handle(IpcChannel.systemExportBackup, async (event) => {
    requireDatabase()
    const picked = await dialog.showSaveDialog(senderWindow(event), {
      title: '导出备份',
      defaultPath: join(app.getPath('documents'), backupFileName(new Date())),
      filters: [{ name: '备份', extensions: ['gz'] }]
    })
    if (picked.canceled || !picked.filePath) {
      return null
    }
    await exportBackup(picked.filePath)
    return picked.filePath
  })

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
