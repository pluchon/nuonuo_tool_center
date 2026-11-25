import { getDatabase } from '../db/client'

export interface PredictionContextRow {
  saved: string | null
  ids: number[] | null
  question: string
  reply: string
  how: string | null
  allAlreadyShown: boolean
}

export interface RecentTurnRow {
  role: 'user' | 'assistant'
  text: string
  how?: string | null
  count?: number
}

export async function findPredictionContext(
  conversationId: number,
  replyId: number,
  scopeName: string | null,
  includeR18 = false
): Promise<PredictionContextRow | null> {
  const { rows: [row] } = await getDatabase().pg.query<PredictionContextRow>(
    `select a.content->>'nextPrediction' as saved,
      a.content->'imageIds' as ids,
      left(coalesce(q.content->>'text', ''), 240) as question,
      left(coalesce(a.content->>'text', ''), 360) as reply,
      a.content->>'how' as how,
      (
        coalesce((a.content->>'allAlreadyShown')::boolean, false)
        or (
          a.content->>'how' is not null
          and coalesce(jsonb_array_length(case when jsonb_typeof(a.content->'imageIds') = 'array' then a.content->'imageIds' else '[]'::jsonb end), 0) = 0
          and coalesce(a.content->>'text', '') ~ '(展示过|都看过|没有其他|没有别的|全展示)'
        )
      ) as "allAlreadyShown"
    from ai_message a join ai_conversation c on c.id=a.conversation_id and c.delete_state=0
    join lateral (select content from ai_message where conversation_id=c.id and role='USER' and delete_state=0 and id<a.id order by id desc limit 1) q on true
    where c.id=$1 and a.id=$2 and a.delete_state=0 and a.role='ASSISTANT'
      and q.content->'scope'->>'name' is not distinct from $3::text
      and coalesce((q.content->>'includeR18')::boolean, false) = $4::boolean
      and not exists (select 1 from ai_message where conversation_id=c.id and delete_state=0 and id>a.id)`,
    [conversationId, replyId, scopeName, includeR18]
  )
  return row ?? null
}

// 获取截至指定回复的最近若干条对话轮次；未开启 includeR18 时严格排除开启 R-18 的提问及其配对回复。
export async function findRecentTurns(
  conversationId: number,
  upToReplyId: number,
  limit = 4,
  includeR18 = false
): Promise<RecentTurnRow[]> {
  const { rows } = await getDatabase().pg.query<{
    role: 'USER' | 'ASSISTANT'
    text: string
    how: string | null
    count: number | null
  }>(
    `select m.role,
      case when m.role = 'USER' then left(coalesce(m.content->>'text', ''), 240)
           else left(coalesce(m.content->>'text', ''), 360) end as text,
      case when m.role = 'ASSISTANT' then m.content->>'how' else null end as how,
      case when m.role = 'ASSISTANT' and jsonb_typeof(m.content->'imageIds') = 'array'
           then jsonb_array_length(m.content->'imageIds')::int else null end as count
    from ai_message m
    left join lateral (
      select u.content from ai_message u
      where u.conversation_id = m.conversation_id and u.role = 'USER' and u.delete_state = 0 and u.id < m.id
      order by u.id desc limit 1
    ) q on m.role = 'ASSISTANT'
    where m.conversation_id = $1
      and m.delete_state = 0
      and m.id <= $2
      and m.role in ('USER', 'ASSISTANT')
      and ($4::boolean or (
        not coalesce((m.content->>'includeR18')::boolean, false)
        and (m.role = 'USER' or (q.content is not null and not coalesce((q.content->>'includeR18')::boolean, false)))
      ))
    order by m.id desc
    limit $3`,
    [conversationId, upToReplyId, limit, includeR18]
  )
  return rows.reverse().map((r) =>
    r.role === 'USER'
      ? { role: 'user', text: r.text }
      : { role: 'assistant', text: r.text, how: r.how, ...(r.count !== null ? { count: r.count } : {}) }
  )
}

export async function findRecentUserTexts(
  conversationId: number,
  beforeReplyId: number,
  limit = 3
): Promise<string[]> {
  const { rows } = await getDatabase().pg.query<{ text: string }>(
    `select left(content->>'text',100) as text from ai_message
    where conversation_id=$1 and role='USER' and delete_state=0 and id<$2
    and not coalesce((content->>'includeR18')::boolean,false) order by id desc limit $3`,
    [conversationId, beforeReplyId, limit]
  )
  return rows.reverse().map((r) => r.text)
}
