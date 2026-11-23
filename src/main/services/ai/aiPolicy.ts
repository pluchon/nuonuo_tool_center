import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { AiPolicyVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { EMBEDDING_CONFIG } from '../../config/cloudConfig'
import { countPendingEmbeddings } from '../../repositories/aiSearchRepository'
import { getDatabase } from '../../db/client'
import { readSetting, upsertSettings, writeSettings } from '../../repositories/appSettingRepository'

const LIMIT = 'ai.embedding.dailyLimit'
const COUNT = 'ai.embedding.day'
// 首次使用由用户选择是否启用后台云端索引。正整数沿用旧版每日限额，-1 表示不限量。
const DEFAULT_LIMIT = 0
export const factBlockKey = (text: string) => 'ai.ruleBlock.' + createHash('sha256').update(text).digest('hex')

export function localDay(d = new Date()): string {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-')
}

export async function setEmbeddingLimit(limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < -1 || limit > 10000) throw new BizError('BAD_REQUEST', '每日限量可设为 1 至 10000 张')
  await upsertSettings([{ key: LIMIT, value: limit }])
}

export async function embeddingBudget(): Promise<'available' | 'paused' | 'exhausted'> {
  const limit = await readSetting<number>(LIMIT) ?? DEFAULT_LIMIT
  if (limit === 0) return 'paused'
  if (limit === -1) return 'available'
  const used = await readSetting<{ day: string; count: number }>(COUNT)
  return used?.day === localDay() && used.count >= limit ? 'exhausted' : 'available'
}

export async function resetOrganizeRules(): Promise<void> {
  await upsertSettings([{key:'ai.organize.rules',value:[]}])
}

// 云端请求开始前预留当日名额。遇到超时或程序退出仍计入工作量，次日自动重新计数。
export async function reserveEmbedding(day = localDay()): Promise<boolean> {
  const { rows } = await getDatabase().pg.query(`
    with budget as (select coalesce((select (value #>> '{}')::int from app_setting where key=$1 and delete_state=0),$4) as max)
    insert into app_setting(key,value)
    select $2,jsonb_build_object('day',$3::text,'count',1) from budget where max<>0
    on conflict (key) where delete_state=0 do update set value=jsonb_build_object('day',$3::text,'count',
      case when app_setting.value->>'day'=$3 then (app_setting.value->>'count')::int+1 else 1 end)
    where (select max from budget)=-1 or app_setting.value->>'day'<>$3 or (app_setting.value->>'count')::int < (select max from budget)
    returning id`, [LIMIT,COUNT,day,DEFAULT_LIMIT])
  return rows.length > 0
}

export async function getAiPolicy(): Promise<AiPolicyVO> {
  const { pg } = getDatabase()
  const [pendingImages, rules, limit, count, localHits, cloud, list] = await Promise.all([
    countPendingEmbeddings(EMBEDDING_CONFIG.model),
    readSetting<unknown[]>('ai.organize.rules'),
    readSetting<number>(LIMIT), readSetting<{ day:string; count:number }>(COUNT), readSetting<number>('ai.localHits'),
    pg.query<{ tokens: string }>('select coalesce(sum(cached_tokens),0) as tokens from api_usage where delete_state=0 and error is null'),
    pg.query<{ id:number; content:string; explicit:boolean }>("select id,content,kind='preference' as explicit from ai_memory where delete_state=0 and valid_to is null order by explicit desc, id desc")
  ])
  return { pendingImages, confirmedFolders: rules?.length ?? 0, dailyLimit: limit ?? DEFAULT_LIMIT, dailyUsed: count?.day === localDay() ? count.count : 0, localHits: localHits ?? 0,
    cloudCachedTokens: Number(cloud.rows[0].tokens), preferences: list.rows.map((r) => ({...r,id:Number(r.id)})) }
}

export async function changePreference(id: number, replacement: string | null): Promise<void> {
  if (!Number.isSafeInteger(id) || (replacement !== null && (typeof replacement !== 'string' || !replacement.trim() || replacement.trim().length > 300))) {
    throw new BizError('BAD_REQUEST', '偏好内容应为 1 至 300 个字')
  }
  await getDatabase().db.transaction(async (tx) => {
    const row = (await tx.execute<{ content:string }>(sql`select content from ai_memory where id=${id} and delete_state=0 and valid_to is null for update`)).rows[0]
    if (!row) throw new BizError('NOT_FOUND', '这项偏好已经移除')
    const after = (await tx.execute<{ id: number }>(sql`select coalesce(max(id),0) as id from ai_event`)).rows[0].id
    await writeSettings(tx,[{key:factBlockKey(row.content),value:Number(after)}])
    await tx.execute(sql`update ai_memory set content='',valid_to=now(),delete_state=1 where content=${row.content} and valid_to is null`)
    if (replacement !== null) {
      await tx.execute(sql`insert into ai_memory(content,kind,confidence) select ${replacement.trim()},'preference',1 where not exists
        (select 1 from ai_memory where content=${replacement.trim()} and kind='preference' and delete_state=0 and valid_to is null)`)
    }
    // 旧会话锁定了档案版本，忘记或纠正后其摘要也必须立即失效。
    await tx.execute(sql`update ai_profile set content='' where content<>''`)
    await tx.execute(sql`update app_setting set value=value-'digest'-'lastSuccess'
      where key='ai.dream.summary' and delete_state=0`)
  })
}
