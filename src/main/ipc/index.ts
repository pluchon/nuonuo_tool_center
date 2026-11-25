import type { DataPaths } from '../config/paths'
import type { DatabaseLocation } from '../services/databaseService'
import { registerAiIpc } from './aiIpc'
import { registerGalleryIpc } from './galleryIpc'
import { registerSystemIpc } from './systemIpc'

// 注册全部 IPC 处理器：按领域拆到系统、图库、AI 三个子模块
export function registerIpcHandlers(paths: DataPaths, location: DatabaseLocation, onDatabaseReady: () => Promise<void>): void {
  registerSystemIpc(paths, location, onDatabaseReady)
  registerGalleryIpc(paths)
  registerAiIpc(paths)
}
