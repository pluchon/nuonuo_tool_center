import type { AiReferencePreview, AiSearchScope, DirKeyDTO } from '@shared/api'
import { BizError } from '../common/bizError'
import { getDatabase } from '../db/client'

export interface ReferenceRecord {
  id: number
  name: string
  is_r18: boolean
  tags: string[]
}

export interface ReferenceScope {
  scope?: AiSearchScope | DirKeyDTO | null
  includeR18?: boolean
}

// 草稿和历史消息共用批量查询，每次打开会话时按当前分级展示本地缩略图。
export async function referencePreviews(ids: number[]): Promise<AiReferencePreview[]> {
  if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new BizError('BAD_REQUEST', '无效的图片编号')
  if (!ids.length) return []
  const { rows } = await getDatabase().pg.query<{ id: number; content_hash: string; is_r18: boolean }>(
    `select i.id, i.content_hash, i.is_r18 from image i
     where i.id = any($1::bigint[]) and i.delete_state = 0 and i.thumb_ready = 1
       and exists (
         select 1 from image_file f join library_root r on r.id = f.root_id and r.delete_state = 0
         where f.image_id = i.id and f.delete_state = 0 and f.status <> 'DELETED'
       )`, [ids])
  return rows.map((r) => ({ imageId: Number(r.id), hash: r.content_hash, isR18: r.is_r18 }))
}

export async function currentReferenceRecords(ids: number[], withTags = true): Promise<Map<number, ReferenceRecord>> {
  if (!ids.length) return new Map()
  const tags = withTags ? `array(
    select t.name from image_tag it join tag t on t.id = it.tag_id
    where it.image_id = i.id and it.status = 'ACCEPTED' and it.delete_state = 0 and t.delete_state = 0
    order by it.id
  )` : 'array[]::text[]'
  const rows = await getDatabase().pg.query<ReferenceRecord>(`
    select i.id, coalesce(nullif(i.display_name, ''), regexp_replace(f.rel_path, '^.*/', '')) as name,
      i.is_r18, ${tags} as tags
    from image i
    join lateral (
      select replace(p.rel_path, chr(92), '/') as rel_path from image_file p
      join library_root r on r.id = p.root_id and r.delete_state = 0
      where p.image_id = i.id and p.delete_state = 0 and p.status <> 'DELETED' order by p.id limit 1
    ) f on true
    where i.id = any($1::bigint[]) and i.delete_state = 0`, [ids])
  return new Map(rows.rows.map((r) => [Number(r.id), r]))
}

// 只读取原轮次的检索范围和结果顺序，图片附件正文不进入引用查询。
export async function findReferenceOrigins(conversationId: number | null, messageIds: number[]) {
  const result = await getDatabase().pg.query<{ id: number; ids: number[]; scope: ReferenceScope['scope']; include_r18: boolean }>(`
    select m.id, m.content->'imageIds' as ids, q.content->'scope' as scope, (q.content->>'includeR18')::boolean as include_r18
    from ai_message m
    join lateral (
      select u.content from ai_message u where u.conversation_id = m.conversation_id and u.id < m.id
      and u.role = 'USER' and u.delete_state = 0 order by u.id desc limit 1
    ) q on true
    where m.conversation_id = $1 and m.id = any($2::bigint[]) and m.role = 'ASSISTANT' and m.delete_state = 0`,
    [conversationId, messageIds])
  return result.rows
}
