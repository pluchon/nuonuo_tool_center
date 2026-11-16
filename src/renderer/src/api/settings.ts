import type { AppSettings } from '@shared/settings'
import { unwrap } from './request'

// 读取全部设置
export function fetchSettings(): Promise<AppSettings> {
  return unwrap(window.api.settings.get())
}

// 修改若干设置，返回修改后的全部设置
export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return unwrap(window.api.settings.update(patch))
}
