import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BizError } from '../common/bizError'
import { isWithin } from '../common/pathUtil'
import { bumpLibraryVersion } from '../common/readCache'
import { getDatabase } from '../db/client'
import { findActiveRootsByKind, registerCategoryRoot, type LibraryRootEntity } from '../repositories/libraryRootRepository'
import { getSettings } from './settingsService'

// 登记前优先沿用旧版保存的位置；全新图库与数据库同属一个应用数据目录。
function initialHome(saved: string | null, override: string | null): string {
  return saved ?? override ?? join(dirname(getDatabase().directory), '类目录')
}

export async function categoryHomeOf(override: string | null): Promise<string> {
  const [root] = await findActiveRootsByKind('CATEGORY')
  return root?.path ?? initialHome((await getSettings()).categoryHome, override)
}

// 仅首次建立图库时创建根目录。已登记的路径离线时保留记录，写入须等原目录恢复。
export async function ensureCategoryRoot(override: string | null, create = false): Promise<LibraryRootEntity | null> {
  const [root] = await findActiveRootsByKind('CATEGORY')
  if (root && !create) return root
  const saved = root ? null : (await getSettings()).categoryHome
  const home = root?.path ?? initialHome(saved, override)
  if (!root) {
    const sources = await findActiveRootsByKind('SOURCE')
    if (sources.some(source => isWithin(source.path, home) || isWithin(home, source.path))) {
      throw new BizError('CONFLICT', '类目录位置与已导入的源目录重叠')
    }
    if (create && !saved) await mkdir(home, { recursive: true })
  }
  const online = await stat(home).then(s => s.isDirectory(), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  })
  if (!online) {
    if (create) throw new BizError('NOT_FOUND', `类目录暂时不可用：${home}`)
    return null
  }
  if (root) return root
  const created = await registerCategoryRoot(home)
  bumpLibraryVersion()
  return created
}
