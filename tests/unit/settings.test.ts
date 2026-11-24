import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import {
  getSettings,
  mergeStoredSettings,
  updateSettings,
  validateSettingsPatch
} from '../../src/main/services/settingsService'

const MIGRATIONS = resolve('drizzle')

describe('设置校验', () => {
  it('类目录位置只读取旧设置，普通设置更新不能修改或清空路径', () => {
    expect(validateSettingsPatch({ appearance: 'dark', backgroundDim: 80 })).toEqual({ appearance: 'dark', backgroundDim: 80 })
    const path = resolve('旧图库')
    expect(mergeStoredSettings([{ key: 'categoryHome', value: path }]).categoryHome).toBe(path)
    for (const value of [path, '', null]) expect(() => validateSettingsPatch({ categoryHome: value })).toThrow('只读')
  })

  it.each([
    [{ appearance: 'blue' }],
    [{ accent: '#000000' }],
    [{ backgroundDim: 81 }],
    [{ glassBlur: 3 }],
    [{ panelClarity: 1.5 }],
    [{ glass: 'yes' }],
    [{ scanFormats: [] }],
    [{ scanFormats: ['TIFF'] }],
    [{ categoryHome: 'relative\\dir' }],
    [{ unknownKey: 1 }],
    [{ constructor: null }],
    [JSON.parse('{"__proto__":{"glass":false}}')],
    [null],
    [[]]
  ])('拒绝不合法的修改 %j', (patch) => {
    expect(() => validateSettingsPatch(patch)).toThrow()
  })

  it('扫描格式去重并按固定顺序保存', () => {
    expect(validateSettingsPatch({ scanFormats: ['RAW', 'JPG', 'JPG'] })).toEqual({ scanFormats: ['JPG', 'RAW'] })
  })

  it('库里不合法或不认识的值被忽略，回到默认值', () => {
    const merged = mergeStoredSettings([
      { key: 'appearance', value: 'dark' },
      { key: 'glassBlur', value: 999 },
      { key: '__proto__', value: null },
      { key: 'legacyKey', value: true }
    ])
    expect(merged.appearance).toBe('dark')
    expect(merged.glassBlur).toBe(DEFAULT_SETTINGS.glassBlur)
    expect(merged).not.toHaveProperty('legacyKey')
  })
})

describe('设置读写（PGlite）', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-settings-'))
    await openDatabase(join(dir, 'pgdata'), MIGRATIONS)
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('新库读出的是默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('同一个键再次修改是覆盖，返回全部设置', async () => {
    await updateSettings({ appearance: 'dark', accent: '#C25B85' })
    const after = await updateSettings({ appearance: 'system' })
    expect(after.appearance).toBe('system')
    expect(after.accent).toBe('#C25B85')
  })

  it('像数字的选项（跳过小图 10 KB）存进去读回来还是原值', async () => {
    const after = await updateSettings({ skipSmall: '10' })
    expect(after.skipSmall).toBe('10')
    expect((await getSettings()).skipSmall).toBe('10')
  })

  it('不合法的修改整体不写入', async () => {
    await expect(updateSettings({ appearance: 'light', glassBlur: 0 })).rejects.toThrow()
    expect((await getSettings()).appearance).toBe('system')
  })

  it('关掉再打开后设置还在', async () => {
    await closeDatabase()
    await openDatabase(join(dir, 'pgdata'), MIGRATIONS)
    const s = await getSettings()
    expect(s.appearance).toBe('system')
    expect(s.accent).toBe('#C25B85')
  })
})
