import type { BrowserWindow, TitleBarOverlayOptions } from 'electron'
import type { ThemeMode } from '@shared/api'

// 标题栏高度，需与渲染进程的标题栏样式保持一致
export const TITLE_BAR_HEIGHT = 36

// 各主题下系统窗口按钮（最小化/最大化/关闭）的配色；底色透明，透出界面自己画的标题栏
const OVERLAY_BY_THEME: Record<ThemeMode, TitleBarOverlayOptions> = {
  light: { color: '#00000000', symbolColor: '#5B4A6B', height: TITLE_BAR_HEIGHT },
  dark: { color: '#00000000', symbolColor: '#E9DFF5', height: TITLE_BAR_HEIGHT }
}

// 创建窗口时使用的标题栏覆盖层配置
export function initialTitleBarOverlay(): TitleBarOverlayOptions {
  return OVERLAY_BY_THEME.light
}

// 切换主题时同步系统窗口按钮的颜色
export function applyTitleBarTheme(win: BrowserWindow, theme: ThemeMode): void {
  win.setTitleBarOverlay(OVERLAY_BY_THEME[theme])
}
