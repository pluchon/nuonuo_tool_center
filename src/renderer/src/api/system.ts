import type { DbBootState } from '@shared/api'
import { unwrap } from './request'

// 获取图库数据库的状态
export function fetchBootState(): Promise<DbBootState> {
  return unwrap(window.api.system.getBootState())
}

// 重新尝试打开图库数据库
export function retryDatabase(): Promise<DbBootState> {
  return unwrap(window.api.system.retryDatabase())
}
