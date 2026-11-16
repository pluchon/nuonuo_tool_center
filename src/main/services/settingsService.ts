import { isAbsolute, resolve } from 'node:path'
import {
  ACCENT_COLORS,
  APPEARANCE_MODES,
  BACKGROUND_KEYS,
  CLOSE_ACTIONS,
  DEFAULT_SETTINGS,
  RANGE_LIMITS,
  SCAN_FORMATS,
  SKIP_SMALL_OPTIONS,
  SORT_KEYS,
  type AppSettings,
  type SettingKey
} from '@shared/settings'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { findActiveSettings, upsertSettings } from '../repositories/appSettingRepository'

const log = getLogger('settings')

// 单项校验：合法时返回规范化后的值，不合法时返回 undefined
type Validator = (value: unknown) => unknown

const oneOf =
  (options: readonly string[]): Validator =>
  (v) =>
    typeof v === 'string' && options.includes(v) ? v : undefined

const bool: Validator = (v) => (typeof v === 'boolean' ? v : undefined)

const intIn =
  ([min, max]: readonly [number, number]): Validator =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined

// 扫描格式：至少选一种，去重后按固定顺序保存
const formats: Validator = (v) => {
  if (!Array.isArray(v) || v.some((f) => typeof f !== 'string' || !SCAN_FORMATS.includes(f as never))) {
    return undefined
  }
  const picked = SCAN_FORMATS.filter((f) => v.includes(f))
  return picked.length > 0 ? picked : undefined
}

// 类目录位置：空值表示用默认位置；否则必须是绝对路径
const dirPath: Validator = (v) => {
  if (v === null) {
    return null
  }
  if (typeof v !== 'string') {
    return undefined
  }
  const trimmed = v.trim()
  if (!trimmed) {
    return null
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : undefined
}

const VALIDATORS: Record<SettingKey, Validator> = {
  appearance: oneOf(APPEARANCE_MODES),
  accent: oneOf(ACCENT_COLORS),
  background: oneOf(BACKGROUND_KEYS),
  backgroundDim: intIn(RANGE_LIMITS.backgroundDim),
  glass: bool,
  glassBlur: intIn(RANGE_LIMITS.glassBlur),
  panelClarity: intIn(RANGE_LIMITS.panelClarity),
  groupByMonth: bool,
  autostart: bool,
  closeAction: oneOf(CLOSE_ACTIONS),
  confirmDelete: bool,
  r18Blur: bool,
  defaultSort: oneOf(SORT_KEYS),
  autoScan: bool,
  watchChanges: bool,
  scanFormats: formats,
  skipSmall: oneOf(SKIP_SMALL_OPTIONS),
  categoryHome: dirPath
}

// 校验一次修改：不认识的键或不合法的值整体拒绝，返回规范化后的修改
export function validateSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new BizError('BAD_REQUEST', '设置格式不对')
  }
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(patch)) {
    const validator = VALIDATORS[key as SettingKey]
    if (!validator) {
      throw new BizError('BAD_REQUEST', `没有这项设置：${key}`)
    }
    const value = validator(raw)
    if (value === undefined) {
      throw new BizError('BAD_REQUEST', `设置的值不合法：${key}`)
    }
    result[key] = value
  }
  return result as Partial<AppSettings>
}

// 把库里的设置行合并到默认值上；库里存了不认识或不合法的值时忽略并记一条警告
export function mergeStoredSettings(rows: Array<{ key: string; value: unknown }>): AppSettings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, scanFormats: [...DEFAULT_SETTINGS.scanFormats] }
  for (const row of rows) {
    const validator = VALIDATORS[row.key as SettingKey]
    const value = validator ? validator(row.value) : undefined
    if (value === undefined) {
      log.warn(`忽略库里不合法的设置项：${row.key}`)
      continue
    }
    merged[row.key] = value
  }
  return merged as unknown as AppSettings
}

// 读取全部设置
export async function getSettings(): Promise<AppSettings> {
  return mergeStoredSettings(await findActiveSettings())
}

// 修改若干设置并返回修改后的全部设置；即时生效，没有单独的保存步骤
export async function updateSettings(patch: unknown): Promise<AppSettings> {
  const valid = validateSettingsPatch(patch)
  const entries = Object.entries(valid).map(([key, value]) => ({ key, value }))
  if (entries.length > 0) {
    await upsertSettings(entries)
  }
  return getSettings()
}
