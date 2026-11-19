import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { BizError } from '../common/bizError'
import { isWithin } from '../common/pathUtil'
import { countImagesByRoot } from '../repositories/libraryOverviewRepository'
import { effectiveCategoryHome } from '../config/paths'
import { getLogger } from '../common/logger'
import { findActiveRootsByKind, insertRoot, updateRootPath, type LibraryRootEntity } from '../repositories/libraryRootRepository'
import { getSettings, updateSettings } from './settingsService'

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

// 更换类目录保存的位置：只换到一个空的新位置，原来的类目录里还有图时不换（图不会跟着搬，换了会全部变成“文件不见了”）
export async function changeCategoryHome(raw: string, override: string | null, dataDir: string): Promise<string> {
  if (override) {
    throw new BizError('BAD_REQUEST', '现在的类目录位置由环境变量指定，不能在这里改')
  }
  if (!isAbsolute(raw)) {
    throw new BizError('BAD_REQUEST', '位置不对')
  }
  const target = resolve(raw)
  const isDir = await stat(target).then(
    (s) => s.isDirectory(),
    () => false
  )
  if (!isDir) {
    throw new BizError('NOT_FOUND', `文件夹找不到：${target}`)
  }
  const current = await categoryHomeOf(override)
  if (current.toLowerCase() === target.toLowerCase()) {
    return target
  }
  if (isWithin(dataDir, target) || isWithin(target, dataDir)) {
    throw new BizError('BAD_REQUEST', '不能放在应用的数据文件夹里')
  }
  for (const src of await findActiveRootsByKind('SOURCE')) {
    if (isWithin(src.path, target) || isWithin(target, src.path)) {
      throw new BizError('BAD_REQUEST', `和源目录「${src.name}」重叠了，换一个位置`)
    }
  }
  const [existing] = await findActiveRootsByKind('CATEGORY')
  const left = existing ? ((await countImagesByRoot()).get(existing.id) ?? 0) : 0
  if (left > 0) {
    throw new BizError('BAD_REQUEST', `类目录里还有 ${left} 张图，先把它们移走再换位置`)
  }
  await updateSettings({ categoryHome: target })
  await ensureCategoryRoot(override)
  log.info(`类目录位置改为 ${target}`)
  return target
}
