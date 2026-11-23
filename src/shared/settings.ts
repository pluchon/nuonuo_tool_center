// 应用设置：主进程和渲染进程共用的类型与默认值（默认值照原型 SV）；校验在主进程的设置服务里

// 外观模式：浅色 / 深色 / 跟随系统
export type AppearanceMode = 'light' | 'dark' | 'system'
// 背景：默认 / 三张主题背景 / 自定义图片
export type BackgroundKey = 'none' | 'halftone' | 'plotter' | 'paper' | 'custom'
// 关闭窗口时的行为
export type CloseAction = 'quit' | 'tray'
// 排序方式
export type SortKey = 'new' | 'old' | 'taken' | 'size' | 'name'
// 跳过小图：不跳过 / 小于 10 KB / 小于 50 KB
export type SkipSmall = 'none' | '10' | '50'
// 扫描的格式
export type ScanFormat = 'JPG' | 'PNG' | 'GIF' | 'WEBP' | 'BMP' | 'AVIF' | 'HEIC' | 'RAW'

// 6 个主题色
export const ACCENT_COLORS = ['#7A63C9', '#C25B85', '#3F8F7B', '#4A86C2', '#B8732E', '#5E5270'] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]

export const APPEARANCE_MODES: readonly AppearanceMode[] = ['light', 'dark', 'system']
export const BACKGROUND_KEYS: readonly BackgroundKey[] = ['none', 'halftone', 'plotter', 'paper', 'custom']

// 自定义背景图存在数据目录 backgrounds 下的文件名（应用自己生成，只认这个格式）
export const CUSTOM_BACKGROUND_NAME = /^custom-[0-9]{13}\.webp$/
export const CLOSE_ACTIONS: readonly CloseAction[] = ['quit', 'tray']
export const SORT_KEYS: readonly SortKey[] = ['new', 'old', 'taken', 'size', 'name']
export const SKIP_SMALL_OPTIONS: readonly SkipSmall[] = ['none', '10', '50']
export const SCAN_FORMATS: readonly ScanFormat[] = ['JPG', 'PNG', 'GIF', 'WEBP', 'BMP', 'AVIF', 'HEIC', 'RAW']

// 滑块的取值范围（含两端）
export const RANGE_LIMITS = {
  backgroundDim: [0, 80],
  glassBlur: [4, 30],
  panelClarity: [0, 80]
} as const

// 全部设置项
export interface AppSettings {
  // 外观
  appearance: AppearanceMode
  accent: AccentColor
  background: BackgroundKey
  backgroundDim: number
  // 自定义背景图的文件名；还没选过为空
  customBackground: string | null
  glass: boolean
  glassBlur: number
  panelClarity: number
  groupByMonth: boolean
  // 常规
  autostart: boolean
  closeAction: CloseAction
  confirmDelete: boolean
  r18Blur: boolean
  defaultSort: SortKey
  // 图库
  autoScan: boolean
  watchChanges: boolean
  scanFormats: ScanFormat[]
  skipSmall: SkipSmall
  // 类目录保存的位置；为空时用默认的 D:\诺诺图床
  categoryHome: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: 'light',
  accent: '#7A63C9',
  background: 'none',
  backgroundDim: 35,
  customBackground: null,
  glass: true,
  glassBlur: 22,
  panelClarity: 40,
  groupByMonth: true,
  autostart: false,
  closeAction: 'quit',
  confirmDelete: true,
  r18Blur: true,
  defaultSort: 'new',
  autoScan: false,
  watchChanges: true,
  scanFormats: [...SCAN_FORMATS],
  skipSmall: 'none',
  categoryHome: null
}

export type SettingKey = keyof AppSettings

export const AI_CREDENTIAL_KEYS = ['dashscopeApiKey', 'aliyunAccessKeyId', 'aliyunAccessKeySecret'] as const
export type AiCredentialKey = (typeof AI_CREDENTIAL_KEYS)[number]
export type AiCredentialPatch = Partial<Record<AiCredentialKey, string | null>>
export type AiCredentialStatus = Record<AiCredentialKey, 'saved' | 'environment' | 'missing'> & { localOnly?: boolean }
export const TOKEN_PLAN_LOCAL_HINT = '当前为套餐本地模式，此操作需要云端模型。'
