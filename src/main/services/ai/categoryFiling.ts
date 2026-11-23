import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/client'
import { confirmedForSearch } from '../../repositories/aiSearchRepository'
import { basename, dirname, join } from 'node:path'
import { BizError } from '../../common/bizError'
import { isWithin, pathKey } from '../../common/pathUtil'
import { currentReferenceRecords } from '../../repositories/aiReferenceRepository'
import { findRowsOfImages } from '../../repositories/galleryRepository'
import { categoryDirectory, categoryRel, readCategoryTree } from '../fileOps/categoryPaths'
import { copyImagesInQueue } from '../fileOps/transferService'
import { verifyImageFile } from '../fileOps/fileOpRecovery'

export interface FilingGroup { path: string; identity: string; imageIds: number[] }

async function eligible(ids: number[]) {
  if (!ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new BizError('BAD_REQUEST', '请选择要归档的图片。')
  const records = await currentReferenceRecords(ids)
  const verified = await getDatabase().db.execute(sql`select image.id from image where image.id = any(${sql.param(ids)}::bigint[])
    and image.delete_state = 0 and not image.is_r18 and ${confirmedForSearch}`)
  if (verified.rows.length !== new Set(ids).size || ids.some(id => !records.has(id)))
    throw new BizError('CONFLICT', '只能归档已有确认标签的普通图片。')
  return records
}

export async function prepareFiling(home: string, scope: string | null, ids: number[], target?: string): Promise<FilingGroup[]> {
  const records = await eligible(ids)
  const selected = target ? categoryRel(target) : null
  if (selected && scope && !isWithin(join(home, scope), join(home, selected)))
    throw new BizError('BAD_REQUEST', '目标超出当前类目录。')
  const tree = selected ? [] : await readCategoryTree(home, scope)
  const groups = new Map<string, FilingGroup>()
  for (const id of new Set(ids)) {
    const record = records.get(id)!
    const matches = selected ? [selected] : tree.filter(p => record.tags.some(tag => tag.toLowerCase() === basename(p).toLowerCase()))
    if (matches.length !== 1) throw new BizError('BAD_REQUEST', '「' + record.name + (matches.length
      ? '」匹配多个目录，请指定目标。' : '」没有匹配的类目录，请指定目标。'))
    const path = matches[0]
    let group = groups.get(path)
    if (!group) {
      const dir = await categoryDirectory(home, path)
      if (!dir) throw new BizError('NOT_FOUND', '目标类目录不存在。')
      group = { path, identity: dir.identity, imageIds: [] }
      groups.set(path, group)
    }
    group.imageIds.push(id)
  }
  return [...groups.values()]
}

export async function applyFiling(home: string, groups: FilingGroup[], begin: () => Promise<void>) {
  await eligible(groups.flatMap(g => g.imageIds))
  for (const group of groups) {
    const dir = await categoryDirectory(home, group.path)
    if (!dir || dir.identity !== group.identity) throw new BizError('CONFLICT', '目标目录已改变，请重新选择。')
    await begin()
    const result = await copyImagesInQueue({ view: 'all', sort: 'new' }, group.imageIds, [dir.abs])
    if (result.failed) throw new BizError('DEPENDENCY_FAILED', result.error || '图片复制未完成。')
    const rows = await findRowsOfImages(group.imageIds)
    const checked = new Set<number>()
    for (const row of rows) {
      const file = join(row.rootPath, row.relPath)
      if (pathKey(dirname(file)) !== pathKey(dir.abs) || row.fileStatus !== 'NORMAL') continue
      await verifyImageFile(file, row.contentHash)
      checked.add(row.imageId)
    }
    if (checked.size !== group.imageIds.length) throw new BizError('CONFLICT', '部分图片在目标目录中未找到。')
  }
}
