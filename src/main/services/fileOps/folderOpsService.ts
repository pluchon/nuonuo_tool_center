import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DIR_NAME_MAX, type FolderRefDTO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isValidDirName, normalizeRelDir } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import {
  hideRowsUnder,
  insertBatch,
  renameRowsUnder,
  observeOrganizeTarget,
  retireRowsUnder,
  unhideRowsUnder,
  updateBatchStatus,
  updateOpStatus,
  findPendingOps
} from '../../repositories/fileOpRepository'
import { findActiveRootById, findActiveRootsByKind, removeRootWithFiles, type LibraryRootEntity } from '../../repositories/libraryRootRepository'
import { categoryHomeOf, ensureCategoryRoot } from '../categoryHome'
import { childDirs } from '../libraryService'
import { getScanState } from '../scan/scanService'
import { enqueue, trashPath } from './fileOpsService'
import { cachedCategoryTree, categoryDirectory, categoryPathIndex, categoryRel, invalidateCategoryTree } from './categoryPaths'

const log = getLogger('fileOps')

// 新建时的默认名字
const DEFAULT_SOURCE_NAME = '新建文件夹'
const DEFAULT_CATEGORY_NAME = '未命名的类目录'
const DEFAULT_SUB_NAME = '未命名的子目录'
// 同级重名时最多试到几号
const MAX_SUFFIX = 999

// 类目录位置的环境变量覆盖（启动时注入）
let categoryHomeOverride: string | null = null
export function configureFolderOps(override: string | null): void {
  categoryHomeOverride = override
}

// 一个目录在磁盘上的位置：绝对路径、所属的图库目录记录（类目录根还没登记时为空）、相对它的路径
interface ResolvedFolder {
  abs: string
  root: LibraryRootEntity | null
  rel: string
  kind: 'source' | 'category'
}

// 字数（一个中文、一个表情都算一个字）
function charCount(s: string): number {
  return Array.from(s).length
}

// 把侧栏传来的目录引用换成磁盘位置，校验路径不会跳出所属目录
export async function resolveFolder(ref: FolderRefDTO): Promise<ResolvedFolder> {
  if (ref?.kind === 'source') {
    const root = Number.isInteger(ref.id) ? await findActiveRootById(ref.id) : undefined
    if (!root || root.kind !== 'SOURCE') {
      throw new BizError('NOT_FOUND', '这个源目录已经不在图库里了')
    }
    const rel = normalizeRelDir(ref.sub)
    if (rel === null) {
      throw new BizError('BAD_REQUEST', '子文件夹路径不对')
    }
    return { abs: rel ? join(root.path, rel) : root.path, root, rel, kind: 'source' }
  }
  if (ref?.kind === 'category') {
    const rel = normalizeRelDir(ref.path)
    if (rel === null) {
      throw new BizError('BAD_REQUEST', '类目录路径不对')
    }
    const home = await categoryHomeOf(categoryHomeOverride)
    const [root] = await findActiveRootsByKind('CATEGORY')
    return { abs: rel ? join(home, rel) : home, root: root ?? null, rel, kind: 'category' }
  }
  throw new BizError('BAD_REQUEST', '目录不对')
}

// 目录名校验：去首尾空格，合法、不超长
function checkName(raw: string): string {
  const name = raw.trim()
  if (charCount(name) > DIR_NAME_MAX) {
    throw new BizError('BAD_REQUEST', `目录名最多 ${DIR_NAME_MAX} 个字`)
  }
  if (!isValidDirName(name)) {
    throw new BizError('BAD_REQUEST', '目录名里不能有 \\ / : * ? " < > | 这些字符')
  }
  return name
}

// 扫描中不改目录结构（扫描会把改了一半的目录当成文件不见了）
function checkNotScanning(): void {
  if (getScanState().progress) {
    throw new BizError('CONFLICT', '正在扫描，等扫完再改目录')
  }
}

// 新建目录：在 parent 下建一个文件夹，名字空着就用默认名，同级重名自动加编号（“名字 2”）。返回新目录相对所属根的路径
export async function createFolder(parent: FolderRefDTO, rawName: unknown): Promise<string> {
  checkNotScanning()
  const folder = await resolveFolder(parent)
  const fallback = folder.kind === 'source' ? DEFAULT_SOURCE_NAME : folder.rel ? DEFAULT_SUB_NAME : DEFAULT_CATEGORY_NAME
  const want = checkName(typeof rawName === 'string' && rawName.trim() ? rawName : fallback)
  return enqueue(async () => {
    if (folder.kind === 'category' && !folder.rel) {
      // 图库文件夹还不存在时先建出来，并登记成类目录根
      await mkdir(folder.abs, { recursive: true })
      await ensureCategoryRoot(categoryHomeOverride)
    }
    const ok = await stat(folder.abs)
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (!ok) {
      throw new BizError('NOT_FOUND', `找不到目录：${folder.abs}`)
    }
    const siblings = new Set(((await childDirs(folder.abs)) ?? []).map((n) => n.toLowerCase()))
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = n === 1 ? want : `${want} ${n}`
      if (siblings.has(name.toLowerCase())) {
        continue
      }
      try {
        await mkdir(join(folder.abs, name))
        if (folder.kind === 'category') {
          invalidateCategoryTree()
          const path = folder.rel ? join(folder.rel, name) : name
          await observeOrganizeTarget(path)
        }
        return folder.rel ? `${folder.rel}\\${name}` : name
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new BizError('DEPENDENCY_FAILED', `建不了目录：${(err as Error).message}`)
        }
      }
    }
    throw new BizError('CONFLICT', '同名目录太多了')
  })
}

// 归档方案和建议共用已存在的类目录相对路径。
export async function categoryPaths(refresh = false): Promise<string[]> {
  return cachedCategoryTree(await categoryHomeOf(categoryHomeOverride), refresh)
}

// 优先沿用现有路径。只有明确允许新建的单段目录名才能在根下创建。
export async function ensureSuggestionTarget(rawName: string, mustExist = false): Promise<string> {
  const path = categoryRel(rawName)
  const home = await categoryHomeOf(categoryHomeOverride)
  return enqueue(async () => {
    checkNotScanning()
    const direct = await categoryDirectory(home, path)
    if (direct) {
      await observeOrganizeTarget(path)
      return direct.abs
    }
    if (path.includes('\\')) throw new BizError('NOT_FOUND', '建议中的类目录位置已改变，请重新选择')
    const match = categoryPathIndex(await categoryPaths(true)).get(path.toLowerCase())
    if (match) {
      const actual = await categoryDirectory(home, match)
      if (actual) {
        await observeOrganizeTarget(path, match)
        return actual.abs
      }
    }
    if (mustExist) throw new BizError('NOT_FOUND', '建议中的类目录已不存在')
    const name = checkName(path)
    if (!await categoryDirectory(home, '')) await mkdir(home, { recursive: true })
    await mkdir(join(home, name))
    await ensureCategoryRoot(categoryHomeOverride)
    await observeOrganizeTarget(name)
    invalidateCategoryTree()
    return join(home, name)
  })
}

// 类目录改名：磁盘上改名，下面所有文件记录的路径跟着换（先写日志）。返回新的相对路径
export async function renameCategoryFolder(ref: FolderRefDTO, rawName: unknown): Promise<string> {
  checkNotScanning()
  const folder = await resolveFolder(ref)
  if (folder.kind !== 'category' || !folder.rel) {
    throw new BizError('BAD_REQUEST', '只能给类目录改名')
  }
  if (typeof rawName !== 'string') {
    throw new BizError('BAD_REQUEST', '目录名不对')
  }
  const name = checkName(rawName)
  const parts = folder.rel.split('\\')
  const oldName = parts[parts.length - 1]
  if (name === oldName) {
    return folder.rel
  }
  const parentRel = parts.slice(0, -1).join('\\')
  const newRel = parentRel ? `${parentRel}\\${name}` : name
  const parentAbs = join(folder.abs, '..')
  const siblings = ((await childDirs(parentAbs)) ?? []).map((n) => n.toLowerCase())
  // 只改大小写时目标“已存在”的就是它自己
  if (name.toLowerCase() !== oldName.toLowerCase() && siblings.includes(name.toLowerCase())) {
    throw new BizError('CONFLICT', `已经有叫「${name}」的目录了`)
  }
  const root = folder.root
  return enqueue(async () => {
    const { db } = getDatabase()
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(tx, `类目录「${oldName}」改名为「${name}」`, [
        { opType: 'RENAME', imageFileId: null, fromPath: folder.abs, toPath: join(parentAbs, name), contentHash: '' }
      ])
      await updateBatchStatus(tx, id, 'APPLYING')
      return id
    })
    const [op] = await findPendingOps(batchId)
    try {
      await rename(folder.abs, join(parentAbs, name))
    } catch (err) {
      await db.transaction(async (tx) => {
        await updateOpStatus(tx, op.id, 'FAILED', (err as Error).message)
        await updateBatchStatus(tx, batchId, 'FAILED')
      })
      const code = (err as NodeJS.ErrnoException).code
      throw new BizError('DEPENDENCY_FAILED', code === 'EPERM' || code === 'EBUSY' ? '目录里有文件正被别的程序占用，改不了名' : `改不了名：${(err as Error).message}`)
    }
    await db.transaction(async (tx) => {
      if (root) {
        await renameRowsUnder(tx, root.id, folder.rel, newRel)
      }
      await updateOpStatus(tx, op.id, 'DONE')
      await updateBatchStatus(tx, batchId, 'APPLIED')
    })
    invalidateCategoryTree()
    return newRel
  })
}

// 删除类目录：整个文件夹（连同里面的副本）放进系统回收站；源目录里的原图不受影响。返回去掉的文件位置数
export async function deleteCategoryFolder(ref: FolderRefDTO): Promise<number> {
  checkNotScanning()
  const folder = await resolveFolder(ref)
  if (folder.kind !== 'category' || !folder.rel) {
    throw new BizError('BAD_REQUEST', '只能删除类目录')
  }
  const root = folder.root
  return enqueue(async () => {
    const { db } = getDatabase()
    let hidden: number[] = []
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(tx, `删除类目录「${folder.rel}」`, [
        { opType: 'DELETE', imageFileId: null, fromPath: folder.abs, toPath: null, contentHash: '' }
      ])
      await updateBatchStatus(tx, id, 'APPLYING')
      if (root) {
        hidden = await hideRowsUnder(tx, root.id, folder.rel)
      }
      return id
    })
    const [op] = await findPendingOps(batchId)
    try {
      await trashPath(folder.abs)
    } catch (err) {
      log.warn(`类目录放进回收站失败：${folder.abs}`, err)
      await db.transaction(async (tx) => {
        if (root) {
          await unhideRowsUnder(tx, root.id, folder.rel)
        }
        await updateOpStatus(tx, op.id, 'FAILED', (err as Error).message)
        await updateBatchStatus(tx, batchId, 'FAILED')
      })
      throw new BizError('DEPENDENCY_FAILED', `删不掉：${(err as Error).message}`)
    }
    await db.transaction(async (tx) => {
      if (root) {
        await retireRowsUnder(tx, root.id, folder.rel)
      }
      await updateOpStatus(tx, op.id, 'DONE')
      await updateBatchStatus(tx, batchId, 'APPLIED')
    })
    invalidateCategoryTree()
    return hidden.length
  })
}

// 从图库移除源目录：只是不再管理，磁盘上的文件不动；以后可以重新导入（按哈希认回名字和标签）
export async function removeSource(id: unknown): Promise<void> {
  checkNotScanning()
  if (!Number.isInteger(id)) {
    throw new BizError('BAD_REQUEST', '源目录 id 不对')
  }
  const root = await findActiveRootById(id as number)
  if (!root || root.kind !== 'SOURCE') {
    throw new BizError('NOT_FOUND', '这个源目录已经不在图库里了')
  }
  await enqueue(() => removeRootWithFiles(root.id))
}
