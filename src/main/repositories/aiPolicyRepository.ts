import { desc, eq, inArray } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { BizError } from '../common/bizError'
import { getDatabase, type AppDatabase } from '../db/client'
import { aiMemory, aiProfile } from '../db/schema'
import { getWorkflow, upsertWorkflow } from './aiWorkflowRepository'
import { writeSettings } from './appSettingRepository'

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

export async function reserveDailyEmbedding(
  limitKey: string,
  countKey: string,
  day: string,
  defaultLimit: number
): Promise<boolean> {
  const { rows } = await getDatabase().pg.query(
    `with budget as (select coalesce((select (value #>> '{}')::int from app_setting where key=$1 and delete_state=0),$4) as max)
    insert into app_setting(key,value)
    select $2,jsonb_build_object('day',$3::text,'count',1) from budget where max<>0
    on conflict (key) where delete_state=0 do update set value=jsonb_build_object('day',$3::text,'count',
      case when app_setting.value->>'day'=$3 then (app_setting.value->>'count')::int+1 else 1 end)
    where (select max from budget)=-1 or app_setting.value->>'day'<>$3 or (app_setting.value->>'count')::int < (select max from budget)
    returning id`,
    [limitKey, countKey, day, defaultLimit]
  )
  return rows.length > 0
}

export async function sumCloudCachedTokens(): Promise<number> {
  const { rows } = await getDatabase().pg.query<{ tokens: string }>(
    'select coalesce(sum(cached_tokens),0) as tokens from api_usage where delete_state=0 and error is null'
  )
  return Number(rows[0]?.tokens ?? 0)
}

export async function findActivePreferences(): Promise<Array<{ id: number; content: string; explicit: boolean }>> {
  const { rows } = await getDatabase().pg.query<{ id: number; content: string; explicit: boolean }>(
    "select id,content,kind='preference' as explicit from ai_memory where delete_state=0 and valid_to is null order by explicit desc, id desc"
  )
  return rows.map((r) => ({ ...r, id: Number(r.id) }))
}

export async function findRuleBlocks(): Promise<Map<string, number>> {
  const { rows } = await getDatabase().pg.query<{ key: string; value: number }>(
    "select key,value from app_setting where starts_with(key,'ai.ruleBlock.') and delete_state=0"
  )
  return new Map(rows.map((r) => [r.key, r.value]))
}

export async function replaceOrDeletePreference(
  id: number,
  replacement: string | null,
  blockKeyFn: (text: string) => string
): Promise<void> {
  await getDatabase().db.transaction(async (tx) => {
    const row = (await tx.execute<{ content: string }>(sql`select content from ai_memory where id=${id} and delete_state=0 and valid_to is null for update`)).rows[0]
    if (!row) throw new BizError('NOT_FOUND', '这项偏好已经移除')
    const after = (await tx.execute<{ id: number }>(sql`select coalesce(max(id),0) as id from ai_event`)).rows[0].id
    await writeSettings(tx, [{ key: blockKeyFn(row.content), value: Number(after) }])
    await tx.execute(sql`update ai_memory set content='',valid_to=now(),delete_state=1 where content=${row.content} and valid_to is null`)
    if (replacement !== null) {
      const trimmed = replacement.trim()
      await tx.execute(sql`insert into ai_memory(content,kind,confidence) select ${trimmed},'preference',1 where not exists
        (select 1 from ai_memory where content=${trimmed} and kind='preference' and delete_state=0 and valid_to is null)`)
    }
    // 旧会话锁定了档案版本，忘记或纠正后其摘要也必须立即失效。
    await tx.execute(sql`update ai_profile set content='' where content<>''`)
    const dreamWf = await getWorkflow<Record<string, unknown>>('DREAM', 'default', tx)
    if (dreamWf) {
      const nextState = { ...(dreamWf.state ?? {}) }
      delete nextState.digest
      delete nextState.lastSuccess
      await upsertWorkflow(
        'DREAM',
        'default',
        { status: dreamWf.status, phase: dreamWf.phase, state: nextState, error: dreamWf.error },
        dreamWf.version,
        tx
      )
    }
    await tx.execute(sql`update app_setting set value=value-'digest'-'lastSuccess'
      where key='ai.dream.summary' and delete_state=0`)
  })
}

export async function runDreamTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
  return getDatabase().db.transaction(fn)
}

export async function clearActiveProfiles(tx: Tx): Promise<void> {
  await tx.update(aiProfile).set({ content: '' })
}

export async function retireDuplicateMemories(tx: Tx, ids: number[], validTo: Date): Promise<void> {
  if (ids.length === 0) return
  await tx.update(aiMemory).set({ validTo }).where(inArray(aiMemory.id, ids))
}

export async function insertNextProfile(tx: Tx, content: string, tagVocab: unknown): Promise<void> {
  const [latest] = await tx
    .select({ version: aiProfile.version })
    .from(aiProfile)
    .where(eq(aiProfile.deleteState, 0))
    .orderBy(desc(aiProfile.version))
    .limit(1)
  await tx.insert(aiProfile).values({ version: (latest?.version ?? 0) + 1, content, tagVocab })
}
