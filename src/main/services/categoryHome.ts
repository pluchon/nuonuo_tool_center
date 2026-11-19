import { stat } from 'node:fs/promises'
import { effectiveCategoryHome } from '../config/paths'
import { getLogger } from '../common/logger'
import { findActiveRootsByKind, insertRoot, updateRootPath, type LibraryRootEntity } from '../repositories/libraryRootRepository'
import { getSettings } from './settingsService'

const log = getLogger('library')

// 当前生效的类目录位置：环境变量 > 设置 > 默认值
export async function categoryHomeOf(override: string | null): Promise<string> {
  const { categoryHome } = await getSettings()
  return effectiveCategoryHome(override, categoryHome)
}

// 确保类目录所在的图库文件夹登记为一条 CATEGORY 目录：文件夹还不存在就不登记；位置变了就跟着改
export async function ensureCategoryRoot(override: string | null): Promise<LibraryRootEntity | null> {
  const home = await categoryHomeOf(override)
  const [existing] = await findActiveRootsByKind('CATEGORY')
  const exists = await stat(home)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (existing) {
    if (existing.path.toLowerCase() !== home.toLowerCase() && exists) {
      log.warn(`类目录位置从 ${existing.path} 改到了 ${home}`)
      return updateRootPath(existing.id, home)
    }
    return existing
  }
  if (!exists) {
    return null
  }
  return insertRoot({ kind: 'CATEGORY', name: '类目录', path: home })
}
