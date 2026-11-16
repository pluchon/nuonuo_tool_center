import type { BrowserWindow } from 'electron'
import type { ThemeMode } from '@shared/api'

// 窗口底色：界面加载出来之前和缩放窗口时露出的颜色，和原型默认背景的底色一致
const WINDOW_BACKGROUND: Record<ThemeMode, string> = {
  light: '#F7F5FC',
  dark: '#1C1926'
}

// 某个明暗下的窗口底色
export function windowBackground(theme: ThemeMode): string {
  return WINDOW_BACKGROUND[theme]
}

// 切换明暗时同步窗口底色
export function applyWindowTheme(win: BrowserWindow, theme: ThemeMode): void {
  win.setBackgroundColor(WINDOW_BACKGROUND[theme])
}

// 最大化和还原之间切换
export function toggleMaximize(win: BrowserWindow): void {
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
}
