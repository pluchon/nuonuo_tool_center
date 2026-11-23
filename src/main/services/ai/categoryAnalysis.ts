import { basename, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { DIR_NAME_MAX, type CategoryProposalVO } from '@shared/api'
import { isSkippedDir, isValidDirName } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import { confirmedForSearch } from '../../repositories/aiSearchRepository'
import { readCategoryTree } from '../fileOps/categoryPaths'

export async function analyzeNewTags(home: string, scope: string | null) {
  const { db } = getDatabase()
  const position = scope ? sql`and r.kind = 'CATEGORY' and starts_with(lower(replace(f.rel_path, chr(92), '/')), ${scope.replaceAll('\\', '/').toLowerCase() + '/'})` : sql``
  const rows = await db.execute<{ id: number; name: string; category: string }>(sql`
    select image.id as id, t.name, tc.name as category from image
    join image_tag it on it.image_id = image.id and it.delete_state = 0 and it.status = 'ACCEPTED'
    join tag t on t.id = it.tag_id and t.delete_state = 0
    join tag_category tc on tc.id = t.category_id and tc.delete_state = 0
    where image.delete_state = 0 and not image.is_r18 and ${confirmedForSearch}
      and not exists (select 1 from category_analyzed_image a where a.image_id = image.id)
      and exists (select 1 from image_file f join library_root r on r.id = f.root_id
        where f.image_id = image.id and f.delete_state = 0 and f.status = 'NORMAL' and r.delete_state = 0 ${position})
    order by image.id, t.name`)
  const images = new Map<number, string[]>()
  const category = new Map<string, string>()
  for (const row of rows.rows) {
    const id = Number(row.id)
    let names = images.get(id)
    if (!names) images.set(id, names = [])
    if (!isValidDirName(row.name) || isSkippedDir(row.name) || Array.from(row.name).length > DIR_NAME_MAX) continue
    names.push(row.name)
    category.set(row.name, row.category)
  }
  const groups = new Map<string, CategoryProposalVO['entries'][number]>()
  if (images.size) {
    const existing = new Map<string, string>()
    const tree = await readCategoryTree(home, scope)
    for (const path of tree) {
      const key = basename(path).toLowerCase()
      if (!existing.has(key)) existing.set(key, path)
    }
    // 未确认提案仍保留标签映射。目录已迁移时，采用磁盘上实际存在的位置。
    const previous = await db.execute<{ tag: string; path: string; status: string }>(sql`
      select distinct on (entry->>'tag') entry->>'tag' as tag, entry->>'path' as path, p.status
      from category_proposal p cross join lateral jsonb_array_elements(p.payload->'entries') entry
      where p.home = ${home} and p.status <> 'cancelled'
        and (p.payload->>'scope') is not distinct from ${scope}::text
        and entry->>'tag' = any(${sql.param([...category.keys()])}::text[])
      order by entry->>'tag', p.id desc`)
    const present = new Set(tree.map((p) => p.toLowerCase()))
    const mapped = new Map(previous.rows.filter((r) => r.status === 'pending' || present.has(r.path.toLowerCase())).map((r) => [r.tag, r.path]))
    const dimensions = ['作品', '角色', '画师', '主题']
    const dimension = (tag: string) => {
      const type = category.get(tag)!
      return type === '人物' ? '角色' : dimensions.includes(type) ? type : '主题'
    }
    for (const names of images.values()) {
      const [tag] = names.sort((a, b) =>
        Number(mapped.has(b)) - Number(mapped.has(a))
        || Number(existing.has(b.toLowerCase())) - Number(existing.has(a.toLowerCase()))
        || dimensions.indexOf(dimension(a)) - dimensions.indexOf(dimension(b))
        || a.localeCompare(b, 'zh-CN'))
      if (!tag) continue
      const known = existing.get(tag.toLowerCase())
      const group = dimension(tag)
      const dimensionPath = scope && basename(scope) === group ? scope : join(scope ?? '', group)
      const path = mapped.get(tag) ?? known ?? (tag === group ? dimensionPath : join(dimensionPath, tag))
      const entry = groups.get(path) ?? { kind: present.has(path.toLowerCase()) ? 'existing' : 'create', path, tag, count: 0 }
      entry.count = (entry.count ?? 0) + 1
      groups.set(path, entry)
    }
  }
  return { ids: [...images.keys()], entries: [...groups.values()] }
}
