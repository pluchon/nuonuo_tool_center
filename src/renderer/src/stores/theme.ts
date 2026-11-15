import { defineStore } from 'pinia'
import type { ThemeMode } from '@shared/api'
import { setWindowTheme } from '@/api/window'

// 主题偏好只存在本机渲染进程的 localStorage，读写失败时退回浅色
const STORAGE_KEY = 'nn.theme'

function readSavedTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

// 界面主题：切换 html 上的 dark 类（同时驱动 Element Plus 深色变量），并同步系统窗口按钮颜色
export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: readSavedTheme()
  }),
  actions: {
    // 把当前主题应用到页面与窗口
    async apply(): Promise<void> {
      document.documentElement.classList.toggle('dark', this.mode === 'dark')
      try {
        localStorage.setItem(STORAGE_KEY, this.mode)
      } catch {
        // 存不下只影响下次启动的默认主题
      }
      await setWindowTheme(this.mode)
    },
    // 在浅色与深色之间切换
    async toggle(): Promise<void> {
      this.mode = this.mode === 'dark' ? 'light' : 'dark'
      await this.apply()
    }
  }
})
