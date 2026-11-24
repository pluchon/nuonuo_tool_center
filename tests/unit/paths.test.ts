import { join, resolve } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  resolveCategoryHomeOverride,
  resolveDataRoot
} from '../../src/main/config/paths'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { upsertSettings } from '../../src/main/repositories/appSettingRepository'
import { categoryHomeOf, ensureCategoryRoot } from '../../src/main/services/categoryHome'

describe('数据目录', () => {
  it('没设 LTM_DATA_DIR 时固定为 AppData 下的 LocalToolManage，与 productName 无关', () => {
    expect(resolveDataRoot({}, 'C:\\Users\\x\\AppData\\Roaming')).toBe(
      join('C:\\Users\\x\\AppData\\Roaming', 'LocalToolManage')
    )
  })

  it('设了 LTM_DATA_DIR 就用它', () => {
    expect(resolveDataRoot({ LTM_DATA_DIR: 'D:\\ltm-dev\\data' }, 'C:\\ignored')).toBe(resolve('D:\\ltm-dev\\data'))
  })

  it('LTM_DATA_DIR 只有空白时当作没设', () => {
    expect(resolveDataRoot({ LTM_DATA_DIR: '  ' }, 'C:\\AppData')).toBe(join('C:\\AppData', 'LocalToolManage'))
  })
})

describe('类目录位置', () => {
  it('旧设置离线时保留路径；全新图库首次建目录后，重启仍沿用原位置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ltm-category-home-'))
    const db = join(dir, 'pgdata')
    const legacy = join(dir, '外置图库')
    const managed = join(dir, '类目录')
    try {
      const { pg } = await openDatabase(db, resolve('drizzle'))
      await upsertSettings([{ key: 'categoryHome', value: legacy }])
      expect(await categoryHomeOf(managed)).toBe(legacy)
      await expect(ensureCategoryRoot(managed, true)).rejects.toThrow('暂时不可用')
      expect(existsSync(legacy)).toBe(false)
      await pg.query('DELETE FROM app_setting WHERE key = $1', ['categoryHome'])
      const [first, concurrent] = await Promise.all([ensureCategoryRoot(null, true), ensureCategoryRoot(null, true)])
      expect(first?.path).toBe(managed)
      expect(concurrent?.id).toBe(first?.id)
      await closeDatabase()
      await openDatabase(db, resolve('drizzle'))
      expect((await ensureCategoryRoot(legacy, true))?.path).toBe(managed)
      expect(existsSync(legacy)).toBe(false)
    } finally {
      await closeDatabase()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('新图库可通过环境变量指定隔离位置', () => {
    const home = resolve('隔离图库')
    expect(resolveCategoryHomeOverride({ LTM_CATEGORY_HOME: home })).toBe(home)
    expect(resolveCategoryHomeOverride({})).toBeNull()
  })
})
