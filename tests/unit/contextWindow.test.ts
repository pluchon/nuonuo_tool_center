import { describe, expect, it } from 'vitest'
import { AI_CONTEXT_WINDOW } from '../../src/shared/api'
import { contextUsage, fitContext } from '../../src/main/services/ai/contextWindow'
import type { PromptMessage } from '../../src/main/services/ai/promptPrefix'

describe('诺诺对话上下文', () => {
  const prefix: PromptMessage[] = [{ role: 'system', content: '固定规则' }]
  const tail: PromptMessage[] = [{ role: 'user', content: '本轮问题' }]

  it('裁剪时保留完整的最近轮次、工具调用和本轮消息，同时限制输出余量', () => {
    const recent: PromptMessage[] = [
      { role: 'user', content: '已保存的文件' },
      { role: 'assistant', content: 'x'.repeat(360_000) }
    ]
    const tools = [{ name: 'search_images', description: 'a'.repeat(8192) }]
    const toolTail: PromptMessage[] = [
      ...tail, { role: 'assistant', content: '', tool_calls: [{ id: 's' }] },
      { role: 'tool', tool_call_id: 's', content: '结果' }
    ]
    const request = fitContext(prefix, [
      { role: 'user', content: '旧'.repeat(40_000) }, { role: 'assistant', content: '不能保留单独一条回复' }, ...recent
    ], toolTail, tools)
    expect(request.messages).toEqual([...prefix, ...recent, ...toolTail])
    expect(request.inputBound + request.maxTokens!).toBe(AI_CONTEXT_WINDOW)
    expect(request.maxTokens).toBeGreaterThanOrEqual(8192)
  })

  it('当前附件过长时不发送，图片使用视觉输入预算，短对话沿用模型默认输出上限', () => {
    expect(() => fitContext(prefix, [], [{ role: 'user', content: '文'.repeat(160_000) }])).toThrow('475K')
    const image: PromptMessage = { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'a'.repeat(480_000) } }
    ] }
    const request = fitContext(prefix, [], [image])
    expect(request.messages.at(-1)).toBe(image)
    expect(request.inputBound).toBeLessThan(3000)
    expect(request.maxTokens).toBeUndefined()
  })

  it('一次请求只计入实际输入和输出，缓存命中的 token 不重复累加', () => {
    const usage = { inputTokens: 500, outputTokens: 12, cachedTokens: 420, cacheWriteTokens: 6, imageTokens: 22, searchCount: 0 }
    expect(contextUsage(usage, 2000, {})).toEqual({ usedTokens: 512, estimated: false })
    expect(contextUsage(undefined, 100, 'abc')).toEqual({ usedTokens: 105, estimated: true })
  })
})
