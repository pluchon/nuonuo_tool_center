import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { BizError } from '../../common/bizError'
import { isWithin, pathKey } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import { recordCopiedFile, recordMovedFile, renameRowsUnder, retireRowsUnder, unhideRowsUnder, updateOpStatus, type FileOpEntity } from '../../repositories/fileOpRepository'
import { findFileLocation } from '../../repositories/galleryRepository'
import { findImageByHash } from '../../repositories/imageRepository'
import { findActiveRoots, findActiveRootsByKind } from '../../repositories/libraryRootRepository'
import { hashFile } from '../scan/imageProbe'
import { categoryDirectory } from './categoryPaths'

function infoAt(path: string) {
  return lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
}

async function settleTransferOp(op: FileOpEntity, fileId: number): Promise<void> {
  const { db } = getDatabase()
  const to = op.toPath
  const target = to ? await infoAt(to) : null
  if (!to || !target) {
    await updateOpStatus(db, op.id, 'REVERTED')
    return
  }
  // 旧版本的空占位没有身份标记。重启后无法证明它仍属于本任务，因此保留所有磁盘内容。
  await verifyImageFile(to, op.contentHash)
  const root = (await findActiveRoots()).filter((r) => isWithin(r.path, to)).sort((a, b) => b.path.length - a.path.length)[0] ?? null
  if (op.opType === 'COPY') {
    const image = await findImageByHash(op.contentHash)
    if (!image) throw new Error('找不到副本对应的图片记录')
    await db.transaction(async (tx) => {
      await recordCopiedFile(tx, image.id, root, to, target.mtime)
      await updateOpStatus(tx, op.id, 'DONE')
    })
    return
  }
  const location = await findFileLocation(fileId)
  if (!location || pathKey(join(location.rootPath, location.relPath)) !== pathKey(op.fromPath) ||
    !(await stat(location.rootPath)).isDirectory()) {
    throw new Error('原目录无法核对，已保留当前文件和索引')
  }
  if (await infoAt(op.fromPath)) throw new Error('移动中断，源位置和目标位置的内容均已保留')
  await db.transaction(async (tx) => {
    await recordMovedFile(tx, fileId, root, to)
    await updateOpStatus(tx, op.id, 'DONE')
  })
}

// 只有已确认的磁盘结果才能提交索引。无法核实时保留文件并记录原因。
export async function recoverJournalOp(op: FileOpEntity): Promise<string | null> {
  try {
    if (op.imageFileId === null) return await settleFolderOp(op)
    await settleTransferOp(op, op.imageFileId)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateOpStatus(getDatabase().db, op.id, 'FAILED', message)
    return message
  }
}

// 延迟执行或撤销时，路径可能已经换成另一张图片、文件夹或链接。
export async function verifyImageFile(path: string, expectedHash: string): Promise<void> {
  if (!(await lstat(path)).isFile() || await hashFile(path) !== expectedHash) {
    throw new BizError('CONFLICT', '文件已经更换，已保留当前位置的内容')
  }
}

// 目录没有内容哈希。恢复时核对父目录中的实际名称，不向可能被替换的目录重放删除命令。
async function settleFolderOp(op: FileOpEntity): Promise<string | null> {
  const { db } = getDatabase()
  const [root] = await findActiveRootsByKind('CATEGORY')
  if (!root || !isWithin(root.path, op.fromPath)) throw new Error('类目录位置已经更改')
  const rel = relative(root.path, op.fromPath)
  if (!rel) throw new Error('无效的类目录操作')
  const acrossParents = op.opType === 'RENAME' && !!op.toPath && pathKey(dirname(op.fromPath)) !== pathKey(dirname(op.toPath))
  const entries = acrossParents ? [] : await readdir(dirname(op.fromPath), { withFileTypes: true }).catch(async (err: unknown) => {
    // 无法读取父目录时不能确认删除。恢复索引，移动硬盘重新连接后仍可浏览图片。
    if (op.opType === 'DELETE') await unhideRowsUnder(db, root.id, rel)
    throw err
  })
  const oldName = basename(op.fromPath)
  if (op.opType === 'DELETE') {
    const present = entries.some((e) => pathKey(e.name) === pathKey(oldName))
    await db.transaction(async (tx) => {
      if (present) await unhideRowsUnder(tx, root.id, rel)
      else await retireRowsUnder(tx, root.id, rel)
      await updateOpStatus(tx, op.id, present ? 'REVERTED' : 'DONE')
    })
    return present ? '目录删除中断，已保留当前目录' : null
  }
  if (op.opType !== 'RENAME' || !op.toPath || !isWithin(root.path, op.toPath)) {
    throw new Error('无效的类目录改名记录')
  }
  const nextRel = relative(root.path, op.toPath)
  if (!nextRel) throw new Error('无效的类目录目标')
  const newName = basename(op.toPath)
  // Windows 支持只改大小写。必须取实际拼写，分别查询两个路径会命中同一目录。
  const destination = acrossParents ? await categoryDirectory(root.path, nextRel) : null
  const initial = acrossParents ? await categoryDirectory(root.path, rel) : null
  if (acrossParents && destination && destination.identity !== op.contentHash) throw new Error('迁移目标已被替换')
  if (acrossParents && initial && initial.identity !== op.contentHash) throw new Error('原目录已被替换')
  const renamed = acrossParents ? !!destination : entries.some((e) => e.isDirectory() && e.name === newName)
  const original = acrossParents ? !!initial : entries.some((e) => e.isDirectory() && e.name === oldName)
  if (renamed === original) throw new Error('目录位置已经变化，无法确认改名结果')
  await db.transaction(async (tx) => {
    if (renamed) await renameRowsUnder(tx, root.id, rel, nextRel)
    await updateOpStatus(tx, op.id, renamed ? 'DONE' : 'REVERTED')
  })
  return null
}
