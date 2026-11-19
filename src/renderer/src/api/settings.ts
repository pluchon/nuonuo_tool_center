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

// 用系统对话框选类目录的新位置；取消返回 null
export function pickCategoryHome(): Promise<AppSettings | null> {
  return unwrap(window.api.settings.pickCategoryHome())
}

// 用系统对话框选自定义背景图；取消返回 null
export function pickBackground(): Promise<AppSettings | null> {
  return unwrap(window.api.settings.pickBackground())
}

// 自定义背景图的地址
export function backgroundUrl(name: string): string {
  return `ltm://bg/${name}`
}
