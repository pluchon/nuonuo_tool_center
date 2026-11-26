import { forgetMemoryByMessage, upsertMemoryByMessage } from '../../../../repositories/aiConversationRepository'
import { findActiveMemoryMatches, listActiveMemories, type AiMemoryEntity } from '../../../../repositories/aiMemoryRepository'
import { sanitizePrediction } from '../../nextPrediction'
import { defineTool, isToolError, parseToolJson, truncateLabel } from '../toolRegistry'

const NOTICE_MAX_CHARS = 36
const CONTENT_MAX_CHARS = 200
const FORGET_MATCH_MIN_SCORE = 0.25
const UPDATE_MATCH_MIN_SCORE = 0.25
const SAVE_DEDUP_MIN_SCORE = 0.75

type MemoryAction = 'save' | 'update' | 'forget'

function clampChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars - 1).join('') + '…'
}

function normalizeNotice(
  raw: unknown,
  action: MemoryAction,
  content: string,
  forgottenContent?: string
): string {
  const cleaned = typeof raw === 'string' ? raw.replace(/[\r\n\s]+/g, ' ').trim() : ''
  if (cleaned) {
    return clampChars(cleaned, NOTICE_MAX_CHARS)
  }
  if (action === 'forget') {
    const target = forgottenContent || content
    const fallback = target ? `诺诺已经忘掉啦：${target}` : '诺诺已经忘掉这件事啦'
    return clampChars(fallback, NOTICE_MAX_CHARS)
  }
  if (action === 'update') {
    return clampChars(`诺诺改好记住啦：${content}`, NOTICE_MAX_CHARS)
  }
  return clampChars(`诺诺记住啦：${content}`, NOTICE_MAX_CHARS)
}

function positiveInt(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0 ? val : undefined
}

async function resolveMatchId(
  queries: string[],
  minScore: number,
  allowedKinds?: ReadonlySet<string>
): Promise<AiMemoryEntity & { score: number } | undefined> {
  const seen = new Set<string>()
  let best: (AiMemoryEntity & { score: number }) | undefined
  for (const raw of queries) {
    const query = raw.trim()
    if (!query || seen.has(query)) continue
    seen.add(query)
    const matches = await findActiveMemoryMatches(query, 10)
    for (const m of matches) {
      if (allowedKinds && !allowedKinds.has(m.kind)) continue
      if (m.score < minScore) continue
      if (!best || m.score > best.score || (m.score === best.score && m.confidence > best.confidence)) {
        best = m
      }
    }
  }
  return best
}

function formatRememberStart(args: Record<string, unknown>): string {
  if (args.action === 'forget') return '忘掉一条偏好'
  if (args.action === 'update') return '更新一条偏好'
  return '记住一条偏好'
}

function formatRecallMemoriesStart(args: Record<string, unknown>): string {
  const query = truncateLabel(args.query, 14)
  return query ? `回忆偏好：${query}` : '回忆偏好'
}

export const replyWithFollowupTool = defineTool({
  name: 'reply_with_followup',
  description:
    '开放式讨论已有明确下一步时，用这个工具一次提交本轮完整回答和一条用户可能想发送的后续指令。闲聊、已有结论或尚需查询图库时直接回答或调用相应工具。',
  sideEffect: 'read',
  silent: true,
  parameters: {
    type: 'object',
    required: ['answer', 'suggestion'],
    properties: {
      answer: { type: 'string', description: '本轮给用户的回答。' },
      suggestion: {
        type: 'string',
        description: '用户口吻的下一条具体指令（6~24字，单行，最多32字），直接推进当前讨论下一步；禁止空洞客套或泛泛提问（如“介绍一下”“有哪些标签”“还有什么可以帮你的”“谢谢”）。'
      }
    }
  },
  execute(args, env) {
    if (typeof args.answer !== 'string' || !args.answer.trim()) {
      return { content: JSON.stringify({ error: '缺少本轮回答。' }), outcome: { type: 'none' } }
    }
    const suggestion = typeof args.suggestion === 'string'
      ? sanitizePrediction(args.suggestion, env?.userText ? [env.userText] : []) ?? undefined
      : undefined
    return {
      content: '{}',
      outcome: { type: 'discussion', text: args.answer.trim(), suggestion }
    }
  }
})

export const rememberTool = defineTool({
  name: 'remember',
  description: '记住、更新或忘掉用户在对话里表达的偏好或习惯。支持纠正已有偏好（update）与忘掉不再想要的偏好（forget）。',
  sideEffect: 'memory',
  formatStart: formatRememberStart,
  formatDone(args, result) {
    const start = formatRememberStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 未执行`
    if (parsed?.ok === false) return `${start} · 未命中`
    if (result.outcome?.type === 'memory') {
      if (result.outcome.action === 'forget') return '忘掉一条偏好 · 已移除'
      if (result.outcome.action === 'update') return '更新一条偏好 · 已更新'
      return '记住一条偏好 · 已保存'
    }
    return start
  },
  parameters: {
    type: 'object',
    required: ['notice'],
    runtimeRequired: [],
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'update', 'forget'],
        description: '默认 save；纠正或替换已有记忆用 update；主人说别记了/忘掉用 forget'
      },
      content: {
        type: 'string',
        description: '用户的持久偏好或习惯，一句简短陈述（forget 时可省略）'
      },
      replaceId: {
        type: 'integer',
        minimum: 1,
        description: '被替换或遗忘的旧记忆编号，可先从上下文或 recall_memories 查得'
      },
      notice: {
        type: 'string',
        description: '给主人看的一句超短人味提示（最多36字，诺诺第一人称口吻，如“诺诺知道主人喜欢吃南瓜而不是冬瓜 ฅ^•ﻌ•^ฅ”，禁止“已更新偏好”等机器腔）'
      },
      evidence: {
        type: 'string',
        description: '可选，触发本次记忆的用户原话依据'
      }
    }
  },
  async execute(args, env) {
    const action: MemoryAction =
      args.action === 'update' || args.action === 'forget' ? args.action : 'save'
    const rawContent = typeof args.content === 'string' ? args.content.trim() : ''
    const content = rawContent ? Array.from(rawContent).slice(0, CONTENT_MAX_CHARS).join('') : ''
    const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : ''
    const explicitId = positiveInt(args.replaceId)

    if (action === 'forget') {
      let targetId = explicitId
      if (!targetId) {
        const matched = await resolveMatchId([content, evidence, env.userText], FORGET_MATCH_MIN_SCORE)
        targetId = matched?.id
      }
      if (!targetId) {
        return {
          content: JSON.stringify({ ok: false, reason: '没有找到需要忘掉的有效记忆，可先调用 recall_memories 确认编号' }),
          outcome: { type: 'none' }
        }
      }
      const res = await forgetMemoryByMessage({ id: targetId, messageId: env.userMessageId })
      if (!res.deleted) {
        return {
          content: JSON.stringify({ ok: false, reason: '没有找到编号对应的有效记忆，可先调用 recall_memories 确认编号' }),
          outcome: { type: 'none' }
        }
      }
      const notice = normalizeNotice(args.notice, 'forget', content, res.content)
      return {
        content: JSON.stringify({ ok: true, forgotten: res.content }),
        outcome: { type: 'memory', action: 'forget', notice }
      }
    }

    if (!content) {
      return { content: JSON.stringify({ error: '内容是空的' }), outcome: { type: 'none' } }
    }

    const prefOrRuleKinds = new Set(['preference', 'rule'])
    let replaceId = explicitId
    if (!replaceId) {
      if (action === 'update') {
        const matched = await resolveMatchId(
          [content, evidence, env.userText],
          UPDATE_MATCH_MIN_SCORE,
          prefOrRuleKinds
        )
        replaceId = matched?.id
      } else {
        const matched = await resolveMatchId([content], SAVE_DEDUP_MIN_SCORE, new Set(['preference']))
        if (matched && matched.content.trim() !== content) {
          replaceId = matched.id
        }
      }
    }

    const saved = await upsertMemoryByMessage({
      content,
      kind: 'preference',
      confidence: 0.9,
      sourceMessageId: env.userMessageId,
      replaceId
    })
    const notice = normalizeNotice(args.notice, action, content)
    const toolPayload =
      saved.action === 'updated' && saved.previousContent && saved.previousContent !== content
        ? { ok: true, replaced: saved.previousContent }
        : { ok: true }
    return {
      content: JSON.stringify(toolPayload),
      outcome: { type: 'memory', action, notice }
    }
  }
})

export const recallMemoriesTool = defineTool({
  name: 'recall_memories',
  description: '查看当前还有效的用户记忆列表（含编号 id、类型 kind、内容 content 和可信度 confidence）。当用户问“你记得我什么”或需要核对记忆编号以便更新/遗忘时调用。',
  sideEffect: 'read',
  formatStart: formatRecallMemoriesStart,
  formatDone(args, result) {
    const start = formatRecallMemoriesStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    return Array.isArray(parsed?.memories) ? `${start} · ${parsed.memories.length} 条` : start
  },
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '可选，按关键词筛选相关记忆；省略时列出全部当前有效记忆' }
    }
  },
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const rows = query ? await findActiveMemoryMatches(query, 20) : []
    const list = rows.length > 0 ? rows : await listActiveMemories(50)
    return {
      content: JSON.stringify({
        memories: list.map((m) => ({
          id: m.id,
          kind: m.kind,
          content: m.content,
          confidence: Number(m.confidence.toFixed(2))
        }))
      }),
      outcome: { type: 'none' }
    }
  }
})
