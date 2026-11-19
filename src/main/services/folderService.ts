import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FolderNodeVO } from '@shared/api'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { isWithin } from '../common/pathUtil'
import { findActiveRootsByKind } from '../repositories/libraryRootRepository'
import { categoryHomeOf } from './categoryHome'
import { childDirs, hasChildDirs } from './libraryService'

const log = getLogger('folder')

// 探测盘符的超时：断开的网络盘可能卡很久
const DRIVE_PROBE_TIMEOUT = 1500
// A、B 是软驱位，不探测
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// 一个盘符现在能不能访问
async function driveReady(root: string): Promise<boolean> {
  const probe = stat(root)
    .then(() => true)
    .catch(() => false)
  const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), DRIVE_PROBE_TIMEOUT))
  return Promise.race([probe, timeout])
}

// 列出导入对话框的一层：parent 为空时列盘符，否则列它下面的子文件夹，并标出哪些不能选
export async function listFolders(parent: string | null, categoryHomeOverride: string | null): Promise<FolderNodeVO[]> {
  if (parent === null) {
    const drives = await Promise.all(
      DRIVE_LETTERS.map(async (letter) => ((await driveReady(`${letter}:\\`)) ? letter : null))
    )
    const ready = drives.filter((d): d is string => d !== null)
    return Promise.all(
      ready.map(async (letter) => ({
        path: `${letter}:\\`,
        label: `${letter}: 盘`,
        isDrive: true,
        hasChildren: await hasChildDirs(`${letter}:\\`),
        lock: null
      }))
    )
  }
  if (typeof parent !== 'string' || parent.trim() === '') {
    throw new BizError('BAD_REQUEST', '文件夹路径不对')
  }
  const base = resolve(parent)
  let names: string[] | null
  try {
    names = await childDirs(base)
  } catch (err) {
    log.info(`列子文件夹失败：${base}`, err)
    throw new BizError('DEPENDENCY_FAILED', `打不开这个文件夹：${base}`)
  }
  if (!names) {
    throw new BizError('NOT_FOUND', `文件夹不存在：${base}`)
  }
  const home = await categoryHomeOf(categoryHomeOverride)
  const sources = (await findActiveRootsByKind('SOURCE')).map((r) => r.path)
  return Promise.all(
    names.map(async (name) => {
      const path = join(base, name)
      return { path, label: name, isDrive: false, hasChildren: await hasChildDirs(path), lock: lockOf(path, home, sources) }
    })
  )
}

// 不能选的原因：就是图库文件夹（或在它里面）/ 在已导入的源目录里 / 包含了已导入的源目录或图库文件夹
export function lockOf(path: string, home: string, sources: string[]): FolderNodeVO['lock'] {
  if (isWithin(home, path)) {
    return 'LIBRARY'
  }
  if (sources.some((s) => isWithin(s, path))) {
    return 'IMPORTED'
  }
  if (isWithin(path, home) || sources.some((s) => isWithin(path, s))) {
    return 'HOLDS'
  }
  return null
}
