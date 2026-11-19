import type { CacheCleanVO, DataInfoVO, DbBootState } from '@shared/api'
import { unwrap } from './request'

// 获取图库数据库的状态
export function fetchBootState(): Promise<DbBootState> {
  return unwrap(window.api.system.getBootState())
}

// 重新尝试打开图库数据库
export function retryDatabase(): Promise<DbBootState> {
  return unwrap(window.api.system.retryDatabase())
}

// 设置里“数据与缓存”“关于”要的信息
export function fetchDataInfo(): Promise<DataInfoVO> {
  return unwrap(window.api.system.dataInfo())
}

// 在资源管理器里打开数据文件夹
export function openDataDir(): Promise<void> {
  return unwrap(window.api.system.openDataDir())
}

// 清理缩略图缓存（库里已经没有的图）
export function cleanCache(): Promise<CacheCleanVO> {
  return unwrap(window.api.system.cleanCache())
}

// 导出备份：返回保存的位置，取消时为 null
export function exportBackup(): Promise<string | null> {
  return unwrap(window.api.system.exportBackup())
}

// Windows 自己的选文件夹对话框；取消返回 null
export function pickFolder(title: string): Promise<string | null> {
  return unwrap(window.api.system.pickFolder(title))
}
