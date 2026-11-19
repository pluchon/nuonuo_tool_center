import { watchEffect, onBeforeUnmount } from 'vue'
import type { AppSettings } from '@shared/settings'
import { backgroundUrl } from '@/api/settings'
import { setWindowTheme } from '@/api/window'
import { useSettingsStore } from '@/stores/settings'
import { themeVars, type Backdrop } from '@/theme/palette'
import { sceneOf } from '@/theme/scenes'

// 设置里的背景换成整窗背景：主题背景是图加纸色；自定义图片铺满；自定义还没有图时按默认
export function backdropOf(values: AppSettings, isDark: boolean): Backdrop {
  const bg = values.background
  if (bg === 'halftone' || bg === 'plotter' || bg === 'paper') {
    const scene = sceneOf(bg, isDark)
    return { kind: 'image', layers: `url("${scene.url}") center / cover no-repeat, ${scene.paper}`, glass: scene.glass, dim: values.backgroundDim }
  }
  if (bg === 'custom' && values.customBackground) {
    const base = isDark ? '#1C1926' : '#F7F5FC'
    return { kind: 'image', layers: `url("${backgroundUrl(values.customBackground)}") center / cover no-repeat, ${base}`, glass: null, dim: values.backgroundDim }
  }
  return { kind: 'none' }
}

// 把设置里的主题色、明暗、背景同步到页面：根节点 CSS 变量、html.dark（Element Plus 深色变量）、窗口底色
export function useThemeSync(): void {
  const settings = useSettingsStore()
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  const onMedia = (e: MediaQueryListEvent): void => settings.setSystemDark(e.matches)
  media?.addEventListener('change', onMedia)
  onBeforeUnmount(() => media?.removeEventListener('change', onMedia))

  watchEffect(() => {
    const isDark = settings.theme === 'dark'
    const root = document.documentElement
    const { accent, panelClarity, glass, glassBlur } = settings.values
    const vars = themeVars(accent, isDark, { panelClarity, glass, glassBlur }, backdropOf(settings.values, isDark))
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
    root.classList.toggle('dark', isDark)
    // 窗口底色只影响缩放时露出的边缘，同步失败不打扰用户
    setWindowTheme(settings.theme).catch(() => undefined)
  })
}
