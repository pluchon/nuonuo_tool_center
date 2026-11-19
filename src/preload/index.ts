import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type ApiResponse,
  type AppSettings,
  type DbBootState,
  type FolderNodeVO,
  type LibraryOverviewVO,
  type LibraryRootVO,
  type ScanStateVO,
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
    addRoot: (path: string): Promise<ApiResponse<LibraryRootVO>> => ipcRenderer.invoke(IpcChannel.libraryAddRoot, path),
    relocateRoot: (id: number, path: string): Promise<ApiResponse<LibraryRootVO>> =>
      ipcRenderer.invoke(IpcChannel.libraryRelocateRoot, id, path),
    listFolders: (parent: string | null): Promise<ApiResponse<FolderNodeVO[]>> =>
      ipcRenderer.invoke(IpcChannel.libraryListFolders, parent)
  },
  scan: {
    start: (rootId: number | null): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanStart, rootId),
    stop: (): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanStop),
    getState: (): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanGetState),
    // 订阅扫描状态推送，返回取消订阅的函数
    onState: (fn: (state: ScanStateVO) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, state: ScanStateVO): void => fn(state)
      ipcRenderer.on(IpcEvent.scanState, wrapped)
      return () => ipcRenderer.removeListener(IpcEvent.scanState, wrapped)
    }
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
