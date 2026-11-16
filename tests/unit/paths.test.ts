import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CATEGORY_HOME,
  effectiveCategoryHome,
  resolveCategoryHomeOverride,
  resolveDataRoot
} from '../../src/main/config/paths'

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
  it('环境变量优先，其次设置，最后默认值', () => {
    const override = resolveCategoryHomeOverride({ LTM_CATEGORY_HOME: 'D:\\ltm-dev\\library' })
    expect(effectiveCategoryHome(override, 'E:\\图库')).toBe(resolve('D:\\ltm-dev\\library'))
    expect(effectiveCategoryHome(null, 'E:\\图库')).toBe('E:\\图库')
    expect(effectiveCategoryHome(null, null)).toBe(DEFAULT_CATEGORY_HOME)
  })
})
