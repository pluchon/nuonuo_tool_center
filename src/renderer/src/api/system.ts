import type { SystemInfoVO } from '@shared/api'
import { unwrap } from './request'

// 获取系统信息
export function fetchSystemInfo(): Promise<SystemInfoVO> {
  return unwrap(window.api.system.getInfo())
}
