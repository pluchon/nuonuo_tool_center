import { defineStore } from 'pinia'
import type { ThemeMode } from '@shared/api'
import { ACCENT_COLORS, APPEARANCE_MODES, DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import { fetchSettings, pickBackground, pickCategoryHome, saveSettings } from '@/api/settings'

// 设置弹窗左侧的分类
export type SettingsTab = 'look' | 'general' | 'library' | 'data' | 'keys' | 'about'

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
    systemDark: systemPrefersDark(),
    // 设置弹窗开着没有、在哪个分类
    dialogOpen: false,
    tab: 'look' as SettingsTab
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
    // 拖滑块时先在界面上生效，松手后再存（不用每动一下都写库）
    preview(patch: Partial<AppSettings>): void {
      this.values = { ...this.values, ...patch }
    },
    // 选自定义背景图（系统对话框）；取消时什么都不变
    async pickBackground(): Promise<void> {
      const next = await pickBackground()
      if (next) {
        this.values = next
      }
    },
    // 换类目录的位置；返回是否换了
    async pickCategoryHome(): Promise<boolean> {
      const next = await pickCategoryHome()
      if (next) {
        this.values = next
      }
      return next !== null
    },
    openDialog(): void {
      this.dialogOpen = true
    },
    closeDialog(): void {
      this.dialogOpen = false
    },
    setTab(tab: SettingsTab): void {
      this.tab = tab
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
