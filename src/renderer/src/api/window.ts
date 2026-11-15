import type { ThemeMode } from '@shared/api'
import { unwrap } from './request'

// 通知主进程按主题调整系统窗口按钮配色
export function setWindowTheme(theme: ThemeMode): Promise<void> {
  return unwrap(window.api.window.setTheme(theme))
}
