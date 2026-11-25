import { getDatabase } from '../db/client'

export interface PredictionContextRow {
  saved: string | null
  ids: number[]
  question: string
  reply: string
}

export async function findPredictionContext(
  conversationId: number,
  replyId: number,
  scopeName: string | null
): Promise<PredictionContextRow | null> {
  const { rows: [row] } = await getDatabase().pg.query<PredictionContextRow>(
    `select a.content->>'nextPrediction' as saved, a.content->'imageIds' as ids, left(q.content->>'text',150) as question,
      left(a.content->>'text',160) as reply
    from ai_message a join ai_conversation c on c.id=a.conversation_id and c.delete_state=0
    join lateral (select content from ai_message where conversation_id=c.id and role='USER' and delete_state=0 and id<a.id order by id desc limit 1) q on true
    where c.id=$1 and a.id=$2 and a.delete_state=0 and a.role='ASSISTANT'
      and q.content->'scope'->>'name' is not distinct from $3::text
      and not coalesce((q.content->>'includeR18')::boolean, false)
      and not exists (select 1 from ai_message where conversation_id=c.id and delete_state=0 and id>a.id)`,
    [conversationId, replyId, scopeName]
  )
  return row ?? null
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
