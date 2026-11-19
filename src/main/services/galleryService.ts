import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { shell } from 'electron'
import type { GalleryItemVO, GalleryListVO, GalleryQueryDTO, ImageDetailVO, ThumbState } from '@shared/api'
import { SORT_KEYS, type ScanFormat } from '@shared/settings'
import { BizError } from '../common/bizError'
import type { ExifInfo } from './scan/exifInfo'
import {
  findFileLocation,
  findGalleryRows,
  findImageExif,
  findImageRows,
  type GalleryFilter,
  type GalleryRow
} from '../repositories/galleryRepository'
import { findActiveRootById, findActiveRootsByKind } from '../repositories/libraryRootRepository'
import { THUMB_FAILED, THUMB_READY } from '../repositories/imageRepository'

// “最近导入”的天数（和侧栏计数一致）
export const RECENT_DAYS = 30

const VIEWS = ['all', 'untagged', 'recent', 'r18', 'source', 'category'] as const
// 搜索词最长多少字
const MAX_QUERY = 100

// 名称排序：和资源管理器一样，数字和英文开头的在前、中文在后；中文按拼音，数字按大小
const nameCollator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })

// 名字是不是 ASCII 字符开头（数字、英文、符号）
function asciiFirst(name: string): number {
  return name.charCodeAt(0) < 128 ? 0 : 1
}

// 按名字比较
export function compareNames(a: string, b: string): number {
  return asciiFirst(a) - asciiFirst(b) || nameCollator.compare(a, b)
}

// 缩略图状态
function thumbOf(ready: number): ThumbState {
  return ready === THUMB_READY ? 'READY' : ready === THUMB_FAILED ? 'FAILED' : 'PENDING'
}

// 显示的名字：起过名就用名字，否则用文件名
function nameOf(row: GalleryRow): string {
  return row.displayName ?? basename(row.relPath)
}

// 校验并规范化查询条件，转成仓库层的过滤条件
async function toFilter(q: GalleryQueryDTO): Promise<GalleryFilter> {
  if (!q || !VIEWS.includes(q.view) || !SORT_KEYS.includes(q.sort)) {
    throw new BizError('BAD_REQUEST', '查询条件不对')
  }
  const text = typeof q.q === 'string' ? q.q.trim().toLowerCase().slice(0, MAX_QUERY) : ''
  const filter: GalleryFilter = { scope: 'dir', recentDays: RECENT_DAYS, q: text || undefined }
  if (q.view === 'source') {
    const root = Number.isInteger(q.sourceId) ? await findActiveRootById(q.sourceId as number) : undefined
    if (!root || root.kind !== 'SOURCE') {
      throw new BizError('NOT_FOUND', '这个源目录已经不在图库里了')
    }
    // 源目录只按图片名搜
    return { ...filter, rootId: root.id, prefix: '', onlyHere: q.onlyHere === true }
  }
  if (q.view === 'category') {
    const name = typeof q.category === 'string' ? q.category : ''
    if (!name || name.includes('\\') || name.includes('/')) {
      throw new BizError('BAD_REQUEST', '类目录名不对')
    }
    const [catRoot] = await findActiveRootsByKind('CATEGORY')
    if (!catRoot) {
      return { ...filter, rootId: -1 }
    }
    return { ...filter, rootId: catRoot.id, prefix: name, onlyHere: q.onlyHere === true, byTag: true, onlyR18: q.onlyR18 === true }
  }
  // 还没打标签、最近导入只按图片名搜；全部图片、R-18 图还按标签名
  const byTag = q.view === 'all' || q.view === 'r18'
  return { ...filter, scope: q.view, byTag, onlyR18: q.view === 'all' && q.onlyR18 === true }
}

// 这些目录现在能不能访问
async function offlineRoots(rows: GalleryRow[]): Promise<Set<number>> {
  const roots = new Map(rows.map((r) => [r.rootId, r.rootPath]))
  const off = new Set<number>()
  await Promise.all(
    [...roots].map(async ([id, path]) => {
      const ok = await stat(path)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!ok) {
        off.add(id)
      }
    })
  )
  return off
}

// 同一张图的多个位置里挑一个代表：正常且目录在线的优先，其次正常的，最后随便一个（按位置先后）
function pickRepresentative(rows: GalleryRow[], offline: Set<number>): GalleryRow {
  return (
    rows.find((r) => r.fileStatus === 'NORMAL' && !offline.has(r.rootId)) ??
    rows.find((r) => r.fileStatus === 'NORMAL') ??
    rows[0]
  )
}

// 一行转成网格项
function toItem(row: GalleryRow, offline: Set<number>): GalleryItemVO {
  return {
    imageId: row.imageId,
    fileId: row.fileId,
    name: nameOf(row),
    format: row.format as ScanFormat,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    hash: row.contentHash,
    thumb: thumbOf(row.thumbReady),
    missing: row.fileStatus === 'MISSING',
    offline: offline.has(row.rootId),
    isR18: row.isR18,
    tagged: row.tagged,
    importedAt: row.createTime.toISOString(),
    takenAt: row.takenAt ? row.takenAt.toISOString() : null
  }
}

// 排序：时间相同时按图片 id 保证顺序稳定
function sortItems(items: GalleryItemVO[], sort: GalleryQueryDTO['sort']): GalleryItemVO[] {
  const t = (iso: string | null): number => (iso ? new Date(iso).getTime() : 0)
  const byNew = (a: GalleryItemVO, b: GalleryItemVO): number => t(b.importedAt) - t(a.importedAt) || b.imageId - a.imageId
  const compare: Record<GalleryQueryDTO['sort'], (a: GalleryItemVO, b: GalleryItemVO) => number> = {
    new: byNew,
    old: (a, b) => -byNew(a, b),
    // 没有拍摄时间的排在最后
    taken: (a, b) => (b.takenAt ? 1 : 0) - (a.takenAt ? 1 : 0) || t(b.takenAt) - t(a.takenAt) || byNew(a, b),
    size: (a, b) => b.byteSize - a.byteSize || byNew(a, b),
    name: (a, b) => compareNames(a.name, b.name) || byNew(a, b)
  }
  return items.sort(compare[sort])
}

// 网格数据：按视图和条件查出图片，同一内容只出一张，按排序排好
export async function listGallery(query: GalleryQueryDTO): Promise<GalleryListVO> {
  const filter = await toFilter(query)
  const rows = await findGalleryRows(filter)
  const offline = await offlineRoots(rows)
  const byImage = new Map<number, GalleryRow[]>()
  for (const row of rows) {
    const list = byImage.get(row.imageId)
    if (list) {
      list.push(row)
    } else {
      byImage.set(row.imageId, [row])
    }
  }
  const items = [...byImage.values()].map((list) => toItem(pickRepresentative(list, offline), offline))
  return { items: sortItems(items, query.sort) }
}

// 详情面板：一张图的信息和它在磁盘上的所有位置
export async function getImageDetail(imageId: number): Promise<ImageDetailVO> {
  if (!Number.isInteger(imageId)) {
    throw new BizError('BAD_REQUEST', '图片 id 不对')
  }
  const rows = await findImageRows(imageId)
  if (rows.length === 0) {
    throw new BizError('NOT_FOUND', '这张图已经不在图库里了')
  }
  const offline = await offlineRoots(rows)
  const rep = pickRepresentative(rows, offline)
  return {
    imageId,
    name: nameOf(rep),
    format: rep.format as ScanFormat,
    width: rep.width,
    height: rep.height,
    byteSize: rep.byteSize,
    hash: rep.contentHash,
    thumb: thumbOf(rep.thumbReady),
    isR18: rep.isR18,
    importedAt: rep.createTime.toISOString(),
    takenAt: rep.takenAt ? rep.takenAt.toISOString() : null,
    exif: ((await findImageExif(imageId)) as ExifInfo | null) ?? null,
    locations: rows.map((r) => ({
      fileId: r.fileId,
      path: join(r.rootPath, r.relPath),
      missing: r.fileStatus === 'MISSING',
      offline: offline.has(r.rootId)
    }))
  }
}

// 按文件 id 拼出绝对路径；路径由主进程按记录拼出，不接受界面传来的路径
async function filePathOf(fileId: number): Promise<string> {
  if (!Number.isInteger(fileId)) {
    throw new BizError('BAD_REQUEST', '文件 id 不对')
  }
  const loc = await findFileLocation(fileId)
  if (!loc) {
    throw new BizError('NOT_FOUND', '这个文件已经不在图库里了')
  }
  return join(loc.rootPath, loc.relPath)
}

// 用系统默认程序打开文件（“无法预览”的图）
export async function openFileWithDefault(fileId: number): Promise<void> {
  const abs = await filePathOf(fileId)
  const err = await shell.openPath(abs)
  if (err) {
    throw new BizError('DEPENDENCY_FAILED', `打不开：${err}`)
  }
}

// 在资源管理器里打开文件所在的文件夹并选中它
export async function showFileInFolder(fileId: number): Promise<void> {
  const abs = await filePathOf(fileId)
  const exists = await stat(abs)
    .then(() => true)
    .catch(() => false)
  if (exists) {
    shell.showItemInFolder(abs)
    return
  }
  // 文件不见了就打开它原来所在的文件夹；文件夹也没有就报错
  const dir = join(abs, '..')
  const dirOk = await stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!dirOk) {
    throw new BizError('NOT_FOUND', `文件夹找不到：${dir}`)
  }
  const err = await shell.openPath(dir)
  if (err) {
    throw new BizError('DEPENDENCY_FAILED', `打不开文件夹：${err}`)
  }
}
