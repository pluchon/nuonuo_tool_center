import { watchEffect, onBeforeUnmount } from 'vue'
import { setWindowTheme } from '@/api/window'
import { useSettingsStore } from '@/stores/settings'
import { themeVars } from '@/theme/palette'

// 把设置里的主题色和明暗同步到页面：根节点 CSS 变量、html.dark（Element Plus 深色变量）、窗口底色
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
    for (const [name, value] of Object.entries(themeVars(accent, isDark, { panelClarity, glass, glassBlur }))) {
      root.style.setProperty(name, value)
    }
    root.classList.toggle('dark', isDark)
    // 窗口底色只影响缩放时露出的边缘，同步失败不打扰用户
    setWindowTheme(settings.theme).catch(() => undefined)
  })
}
