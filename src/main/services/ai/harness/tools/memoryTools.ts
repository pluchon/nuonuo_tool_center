import { insertMemory } from '../../../../repositories/aiConversationRepository'
import { sanitizePrediction } from '../../nextPrediction'
import { defineTool } from '../toolRegistry'

export const replyWithFollowupTool = defineTool({
  name: 'reply_with_followup',
  description:
    '开放式讨论已有明确下一步时，用这个工具一次提交本轮完整回答和一条用户可能想发送的后续指令。闲聊、已有结论或尚需查询图库时直接回答或调用相应工具。',
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
  description: '记下用户在对话里明说的偏好或习惯，以后整理和回答时参考。',
  parameters: {
    type: 'object',
    required: ['content', 'evidence'],
    properties: {
      content: { type: 'string', description: '用户本人的持久偏好，一句简短陈述' },
      evidence: { type: 'string', description: '本轮用户原话中明确表达该偏好的连续引文' },
      existingId: { type: 'integer', description: '已有偏好意思完全相同时填写其编号，主体或限定条件不同应分开' }
    }
  },
  async execute(args, env) {
    const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : ''
    if (!evidence || !env.userText.includes(evidence)) {
      return { content: JSON.stringify({ saved: false, reason: '缺少本轮用户原文依据' }), outcome: { type: 'none' } }
    }
    if (typeof args.existingId === 'number' && env.preferenceIds?.includes(args.existingId)) {
      return { content: JSON.stringify({ ok: true }), outcome: { type: 'none' } }
    }
    const content = typeof args.content === 'string' ? args.content.trim().slice(0, 200) : ''
    if (!content) {
      return { content: JSON.stringify({ error: '内容是空的' }), outcome: { type: 'none' } }
    }
    await insertMemory(content, 'preference', 0.9, env.userMessageId)
    return { content: JSON.stringify({ ok: true }), outcome: { type: 'none' } }
  }
})
