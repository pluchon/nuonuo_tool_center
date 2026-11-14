import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type ApiResponse, type LibraryRootVO, type SystemInfoVO } from '@shared/api'

// 暴露给渲染进程的接口：只开放具体方法，不暴露 ipcRenderer 本身
const api = {
  system: {
    getInfo: (): Promise<ApiResponse<SystemInfoVO>> => ipcRenderer.invoke(IpcChannel.systemGetInfo)
  },
  library: {
    listRoots: (): Promise<ApiResponse<LibraryRootVO[]>> => ipcRenderer.invoke(IpcChannel.libraryListRoots),
    addRoot: (): Promise<ApiResponse<LibraryRootVO>> => ipcRenderer.invoke(IpcChannel.libraryAddRoot)
  }
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
