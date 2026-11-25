import type { AiPredictionDTO } from '@shared/api'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { findPredictionContext, findRecentTurns } from '../../repositories/aiPredictionRepository'
import { currentReferenceRecords } from '../../repositories/aiReferenceRepository'
import { cachedSearchValue, searchCacheKey } from '../../repositories/aiSearchCacheRepository'
import { checkReferences, visibleReferenceResults } from './assistantReferences'
import { chatCall } from './bailianClient'
import { relevantMemories } from './memoryRetrieval'

const SAMPLE = 3
const WRAPPER_PAIRS: Array<[string, string]> = [
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』']
]
const GENERIC_FILLER = /(?:有哪些标签|有什么标签|介绍一下这|怎么帮我|还有什么可以)/u
const SMALLTALK_ONLY = /^(?:谢谢|好的|收到|明白|了解|嗯嗯|哈哈|你好|再见|辛苦了)[！!。.~～]*$/u

const normalizeCompare = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s，。！？、,.!?;；:："'“”‘’`「」『』（）()~～—-]+/gu, '')

function unwrapQuotes(raw: string): string {
  let text = raw.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const [open, close] of WRAPPER_PAIRS) {
      if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim()
        changed = true
      }
    }
  }
  return text
}

/**
 * 清洗并过滤下一句预测：剔除包装引号/反引号、拒绝空值/`-`/多行/超长/低价值通用水词及与近期用户提问重复的建议。
 */
export function sanitizePrediction(raw: string, recentUserTexts: string[]): string | null {
  if (typeof raw !== 'string') return null
  if (/[\r\n]/u.test(raw.trim())) return null
  const text = unwrapQuotes(raw)
  if (!text || text === '-' || /[\r\n]/u.test(text)) return null
  const len = Array.from(text).length
  if (len < 2 || len > 32) return null
  if (SMALLTALK_ONLY.test(text)) return null
  const userAskedSimilar = recentUserTexts.some((u) => GENERIC_FILLER.test(u))
  if (!userAskedSimilar && GENERIC_FILLER.test(text)) return null
  const nt = normalizeCompare(text)
  if (!nt) return null
  for (const userText of recentUserTexts) {
    const nu = normalizeCompare(userText)
    if (!nu) continue
    if (nt === nu) return null
    const minLen = Math.min(nt.length, nu.length)
    const maxLen = Math.max(nt.length, nu.length)
    if (minLen >= 4 && (nt.includes(nu) || nu.includes(nt)) && minLen / maxLen >= 0.75) {
      return null
    }
  }
  return text
}

const isHint = (value: unknown): value is string =>
  value === '' || (typeof value === 'string' && sanitizePrediction(value, []) !== null)

const rules = [
  '你是输入框幽灵联想器。根据近期对话轨迹、当前状态、图片样本和用户偏好，预测用户接下来最可能直接发送的一句话，把当前任务向前推进一步。',
  '硬性标准：',
  '1. 用用户自己的口吻直接写指令或追问（6~24字为佳，严禁超过32字，单行输出，不加引号或前缀）。',
  '2. 禁止客套废话和低价值水词（如“这些图有哪些标签”“帮我介绍一下这张图”“还有什么可以帮你的”“谢谢”“好的”“请问…”），禁止重复用户刚说过的话。',
  '3. 按「当前状态」分支决策：',
  '- 选中多张图片(>=2)：聚焦对比差异、找共同画风/元素、挑出最好的一张，或归入某个类目录。',
  '- 选中1张图片 / 返回1张图片：聚焦找同画风或同角色其他作品、问“还有其他的吗”、核对角色/作品出处，或归类。',
  '- 返回较多图片(>6)：给出一个具体的收窄维度（如只看竖图/横图、按发色/瞳色/服饰特征过滤、指定角色或归类）。',
  '- 返回多张图片(2~6)：围绕这几张的具体画面/标签细节继续筛选、对比或挑图。',
  '- 匹配图片已全展示过：建议放宽某个条件、换个视觉特征继续找，或对已看过的图做归类/对比。',
  '- 0张结果：建议放宽一个限制条件，或改用更直观的视觉/角色线索重试。',
  '- 纯文本讨论：顺着具体讨论话题自然推进（追问细节、举例、对比方案），不要强行拉回搜图。',
  '4. 如果当前任务已自然结束、答案已完备或没有明确有价值的下一步，只输出单个短横线 -（宁缺毋滥）。'
].join('\n')

function resolveStateLabel(refCount: number, count: number, picCount: number, allAlreadyShown: boolean, hasHow: boolean): string {
  if (refCount >= 2 || (refCount > 0 && count >= 2)) return `选中多张图片(${count}张)`
  if (refCount === 1) return '选中1张图片'
  if (count === 1 && picCount === 1) return '返回1张图片'
  if (count > 6) return `返回较多图片(${count}张)`
  if (count >= 2) return `返回多张图片(${count}张)`
  if (allAlreadyShown) return '匹配图片已全展示过'
  if (hasHow) return '0张结果'
  return '纯文本讨论'
}

export async function predictNext(dto: AiPredictionDTO): Promise<string | null> {
  if (!dto || !Number.isSafeInteger(dto.conversationId) || !Number.isSafeInteger(dto.replyId) ||
      dto.includeR18 !== false || (dto.scope !== null && dto.scope?.kind !== 'category') ||
      (dto.references !== undefined && (!Array.isArray(dto.references) || dto.references.length > SAMPLE))) return null
  const row = await findPredictionContext(dto.conversationId, dto.replyId, dto.scope?.name ?? null)
  if (!row) return null
  const refsInput = dto.references ?? []
  if (!refsInput.length && row.saved) {
    return sanitizePrediction(row.saved, row.question ? [row.question] : [])
  }
  const storedIds = Array.isArray(row.ids) ? row.ids : []
  const hasSubstantiveText = row.reply.trim().length >= 16 && !storedIds.length
  const hasZeroResultSearch = Boolean(row.how) && !storedIds.length
  if (!refsInput.length && !storedIds.length && !row.allAlreadyShown && !hasSubstantiveText && !hasZeroResultSearch) {
    return null
  }
  const ids = refsInput.length
    ? (await checkReferences(refsInput, dto.conversationId, (ids, origin) => visibleReferenceResults(ids, origin, dto))).map(r => r.imageId)
    : storedIds.slice(0, SAMPLE)
  let pictures: Array<{ 名称: string; 标签: string[] }> = []
  if (ids.length > 0) {
    const visible = await visibleReferenceResults(ids, dto, dto)
    const records = await currentReferenceRecords(ids.filter(id => visible.has(id)))
    pictures = ids.flatMap(id => {
      const r = records.get(id)
      return r && !r.is_r18 ? [{ 名称: r.name.slice(0, 48), 标签: r.tags.slice(0, 6).map(t => t.slice(0, 24)) }] : []
    })
    if (!pictures.length || (refsInput.length && pictures.length !== ids.length)) return null
  }
  const turns = await findRecentTurns(dto.conversationId, dto.replyId, 4)
  const recentUserTexts = [...new Set([
    ...turns.filter(t => t.role === 'user' && t.text.trim()).map(t => t.text.trim()),
    ...(row.question.trim() ? [row.question.trim()] : [])
  ])]
  const preferences = (await relevantMemories(row.question ?? '')).filter(m => m.kind === 'preference').slice(0, 2)
  const selected = dto.selectionCount ?? ids.length
  const count = refsInput.length && Number.isSafeInteger(selected) ? Math.max(ids.length, selected) : storedIds.length
  const input = {
    当前状态: resolveStateLabel(refsInput.length, count, pictures.length, row.allAlreadyShown, Boolean(row.how)),
    来源: refsInput.length
      ? '当前选图'
      : pictures.length
        ? '刚返回的图片'
        : row.allAlreadyShown
          ? '已展示过全部匹配图片'
          : row.how
            ? '图库检索结果'
            : '纯文本对话',
    数量: count,
    近期对话: turns.map(t =>
      t.role === 'user'
        ? { 角色: '用户', 原话: t.text || '（引用了图片）' }
        : { 角色: '诺诺', ...(t.how ? { 检索: t.how } : {}), ...(t.count !== undefined ? { 图数: t.count } : {}), 回复: t.text }
    ),
    ...(row.how ? { 本轮检索: row.how } : {}),
    ...(pictures.length ? { 图片样本: pictures } : {}),
    用户偏好: preferences.map(m => m.content.slice(0, 80))
  }
  // 会话和图片权限已核对。相同范围及模型输入可以复用，即使重新开了一次对话。
  const key = searchCacheKey('prediction-v4', [BAILIAN_CONFIG.chatModel, rules, dto.scope, input])
  const hint = await cachedSearchValue(key, isHint, async () => {
    if (!readCloudCredentials().dashscopeApiKey) return undefined
    const result = await chatCall({ kind: 'predict', model: BAILIAN_CONFIG.chatModel, maxTokens: 40, timeoutMs: 5000,
      messages: [{ role: 'system', content: rules }, { role: 'user', content: JSON.stringify(input) }] })
    const raw = result.message.content?.trim() ?? ''
    if (result.finishReason !== 'stop') return undefined
    if (raw === '-') return ''
    return sanitizePrediction(raw, recentUserTexts) ?? undefined
  })
  return hint || null
}
