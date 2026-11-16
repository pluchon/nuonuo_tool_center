import type { ThemeMode } from '@shared/api'
import { unwrap } from './request'

// 通知主进程按明暗调整窗口底色
export function setWindowTheme(theme: ThemeMode): Promise<void> {
  return unwrap(window.api.window.setTheme(theme))
}

// 最小化窗口
export function minimizeWindow(): Promise<void> {
  return unwrap(window.api.window.minimize())
}

// 最大化与还原之间切换
export function toggleMaximizeWindow(): Promise<void> {
  return unwrap(window.api.window.toggleMaximize())
}

// 关闭窗口
export function closeWindow(): Promise<void> {
  return unwrap(window.api.window.close())
}
