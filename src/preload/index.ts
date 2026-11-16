import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannel,
  type ApiResponse,
  type AppSettings,
  type DbBootState,
  type LibraryOverviewVO,
  type LibraryRootVO,
  type ThemeMode
} from '@shared/api'

// 暴露给渲染进程的接口：只开放具体方法，不暴露 ipcRenderer 本身
const api = {
  system: {
    getBootState: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemGetBootState),
    retryDatabase: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemRetryDatabase)
  },
  settings: {
    get: (): Promise<ApiResponse<AppSettings>> => ipcRenderer.invoke(IpcChannel.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<ApiResponse<AppSettings>> =>
      ipcRenderer.invoke(IpcChannel.settingsUpdate, patch)
  },
  library: {
    getOverview: (): Promise<ApiResponse<LibraryOverviewVO>> => ipcRenderer.invoke(IpcChannel.libraryGetOverview),
    addRoot: (): Promise<ApiResponse<LibraryRootVO>> => ipcRenderer.invoke(IpcChannel.libraryAddRoot)
  },
  window: {
    setTheme: (theme: ThemeMode): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowSetTheme, theme),
    minimize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowMinimize),
    toggleMaximize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowToggleMaximize),
    close: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowClose)
  }
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
