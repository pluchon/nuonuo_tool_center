import type { AiPredictionDTO } from '@shared/api'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { getDatabase } from '../../db/client'
import { currentReferenceRecords } from '../../repositories/aiReferenceRepository'
import { cachedSearchValue, searchCacheKey } from '../../repositories/aiSearchCacheRepository'
import { checkReferences, visibleReferenceResults } from './assistantReferences'
import { chatCall } from './bailianClient'
import { relevantMemories } from './memoryRetrieval'

const SAMPLE = 3
const isHint = (value: unknown): value is string =>
  typeof value === 'string' && Array.from(value).length <= 32 && !/[\r\n]/u.test(value)
const rules = '根据最近的用户原话、当前图片的已确认标签和用户偏好，预测用户最可能输入的一句具体追问。优先延续用户正在做的事，沿用其措辞，避免泛泛询问标签、重复上一问或引入无关偏好。资料仅作参考。写成能直接发给诺诺的请求或问句，让对话向前一步。只输出这一句，最多32字；缺乏依据就输出单个短横线。'

export async function predictNext(dto: AiPredictionDTO): Promise<string | null> {
  if (!dto || !Number.isSafeInteger(dto.conversationId) || !Number.isSafeInteger(dto.replyId) ||
      dto.includeR18 !== false || (dto.scope !== null && dto.scope?.kind !== 'category') ||
      (dto.references !== undefined && (!Array.isArray(dto.references) || dto.references.length > SAMPLE))) return null
  const { pg } = getDatabase()
  const { rows: [row] } = await pg.query<{ saved: string | null; ids: number[]; question: string; reply: string }>(`
    select a.content->>'nextPrediction' as saved, a.content->'imageIds' as ids, left(q.content->>'text',150) as question,
      left(a.content->>'text',160) as reply
    from ai_message a join ai_conversation c on c.id=a.conversation_id and c.delete_state=0
    join lateral (select content from ai_message where conversation_id=c.id and role='USER' and delete_state=0 and id<a.id order by id desc limit 1) q on true
    where c.id=$1 and a.id=$2 and a.delete_state=0 and a.role='ASSISTANT'
      and q.content->'scope'->>'name' is not distinct from $3::text
      and not coalesce((q.content->>'includeR18')::boolean, false)
      and not exists (select 1 from ai_message where conversation_id=c.id and delete_state=0 and id>a.id)`,
    [dto.conversationId, dto.replyId, dto.scope?.name ?? null])
  if (!row) return null
  if (!dto.references?.length && row.saved) return row.saved
  if (!dto.references?.length && !row.ids?.length) return null
  const ids = dto.references?.length
    ? (await checkReferences(dto.references, dto.conversationId, (ids, origin) => visibleReferenceResults(ids, origin, dto))).map(r => r.imageId)
    : row.ids.slice(0, SAMPLE)
  const visible = await visibleReferenceResults(ids, dto, dto)
  const records = await currentReferenceRecords(ids.filter(id => visible.has(id)))
  const pictures = ids.flatMap(id => {
    const r = records.get(id)
    return r && !r.is_r18 ? [{ 名称: r.name.slice(0, 48), 标签: r.tags.slice(0, 6).map(t => t.slice(0, 24)) }] : []
  })
  if (!pictures.length || (dto.references?.length && pictures.length !== ids.length)) return null
  const past = await pg.query<{ text: string }>(`select left(content->>'text',100) as text from ai_message
    where conversation_id=$1 and role='USER' and delete_state=0 and id<$2
    and not coalesce((content->>'includeR18')::boolean,false) order by id desc limit 3`, [dto.conversationId, dto.replyId])
  const preferences = (await relevantMemories(row.question ?? '')).filter(m => m.kind === 'preference').slice(0, 2)
  const selected = dto.selectionCount ?? ids.length
  const count = dto.references?.length && Number.isSafeInteger(selected) ? Math.max(ids.length, selected) : (row.ids?.length ?? 0)
  const input = { 近期原话: past.rows.reverse().map(r => r.text), 上轮回应: row.reply, 来源: dto.references?.length ? '当前选图' : '刚返回的图片',
    数量: count, 图片样本: pictures, 用户偏好: preferences.map(m => m.content.slice(0, 80)) }
  // 会话和图片权限已核对。相同范围及模型输入可以复用，即使重新开了一次对话。
  const key = searchCacheKey('prediction-v3', [BAILIAN_CONFIG.chatModel, rules, dto.scope, input])
  const hint = await cachedSearchValue(key, isHint, async () => {
    if (!readCloudCredentials().dashscopeApiKey) return undefined
    const result = await chatCall({ kind: 'predict', model: BAILIAN_CONFIG.chatModel, maxTokens: 40, timeoutMs: 5000,
      messages: [{ role: 'system', content: rules }, { role: 'user', content: JSON.stringify(input) }] })
    const text = result.message.content?.trim() ?? ''
    if (result.finishReason !== 'stop') return undefined
    if (text === '-') return ''
    return text && isHint(text) && !input.近期原话.includes(text) ? text : undefined
  })
  return hint || null
}
