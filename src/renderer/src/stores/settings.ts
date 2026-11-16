import { defineStore } from 'pinia'
import type { ThemeMode } from '@shared/api'
import { ACCENT_COLORS, APPEARANCE_MODES, DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import { fetchSettings, saveSettings } from '@/api/settings'

// 上次的外观（明暗和主题色）缓存在本机：图库数据打不开时读不到设置，靠它让“打不开”页面保持用户习惯的外观
const LOOK_CACHE_KEY = 'ltm.look'

type CachedLook = Pick<AppSettings, 'appearance' | 'accent'>

function readCachedLook(): Partial<CachedLook> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_CACHE_KEY) ?? '{}') as Partial<CachedLook>
    return {
      ...(APPEARANCE_MODES.includes(raw.appearance as never) ? { appearance: raw.appearance } : {}),
      ...(ACCENT_COLORS.includes(raw.accent as never) ? { accent: raw.accent } : {})
    }
  } catch {
    return {}
  }
}

function writeCachedLook(values: AppSettings): void {
  try {
    localStorage.setItem(LOOK_CACHE_KEY, JSON.stringify({ appearance: values.appearance, accent: values.accent }))
  } catch {
    // 存不下只影响下次“打不开”页面的外观
  }
}

// 系统当前是否是深色
function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

// 应用设置：数据库打不开时用默认值（外观用本机缓存）；修改即时生效
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    values: { ...DEFAULT_SETTINGS, scanFormats: [...DEFAULT_SETTINGS.scanFormats], ...readCachedLook() } as AppSettings,
    loaded: false,
    systemDark: systemPrefersDark()
  }),
  getters: {
    // 实际生效的明暗
    theme: (s): ThemeMode =>
      s.values.appearance === 'system' ? (s.systemDark ? 'dark' : 'light') : s.values.appearance
  },
  actions: {
    // 从主进程读取设置
    async load(): Promise<void> {
      this.values = await fetchSettings()
      this.loaded = true
      writeCachedLook(this.values)
    },
    // 修改设置，以主进程返回的结果为准
    async update(patch: Partial<AppSettings>): Promise<void> {
      this.values = await saveSettings(patch)
      writeCachedLook(this.values)
    },
    // 读设置失败时用当前值继续
    markLoaded(): void {
      this.loaded = true
    },
    // 系统明暗变化时记录下来（“跟随系统”用）
    setSystemDark(dark: boolean): void {
      this.systemDark = dark
    }
  }
})
