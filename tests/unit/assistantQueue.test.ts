import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  AiAttachment,
  AiAskDTO,
  AiAskResultVO,
  AiImageReference,
  AiMemoryNotice,
  AiMessageVO,
  AiSearchScope,
  AiStreamEvent,
  AiTimelineBlock
} from '@shared/api'

const mockApi = vi.hoisted(() => ({
  askNono: vi.fn(),
  fetchAnswer: vi.fn(),
  abortAnswer: vi.fn(),
  compactConversation: vi.fn(),
  editMessage: vi.fn(),
  recallMessage: vi.fn(),
  fetchRecalledDraft: vi.fn(),
  fetchAiStatus: vi.fn(),
  fetchConversations: vi.fn(),
  fetchIdeas: vi.fn(),
  fetchMessages: vi.fn(),
  pinConversation: vi.fn(),
  removeConversation: vi.fn(),
  renameConversation: vi.fn(),
  undoRemoveConversation: vi.fn(),
  voteMessage: vi.fn()
}))

const mockToast = vi.hoisted(() => ({
  show: vi.fn()
}))

vi.mock('@/api/ai', () => ({
  askNono: mockApi.askNono,
  fetchAnswer: mockApi.fetchAnswer,
  abortAnswer: mockApi.abortAnswer,
  compactConversation: mockApi.compactConversation,
  editMessage: mockApi.editMessage,
  recallMessage: mockApi.recallMessage,
  fetchRecalledDraft: mockApi.fetchRecalledDraft,
  fetchAiStatus: mockApi.fetchAiStatus,
  fetchConversations: mockApi.fetchConversations,
  fetchIdeas: mockApi.fetchIdeas,
  fetchMessages: mockApi.fetchMessages,
  pinConversation: mockApi.pinConversation,
  removeConversation: mockApi.removeConversation,
  renameConversation: mockApi.renameConversation,
  undoRemoveConversation: mockApi.undoRemoveConversation,
  voteMessage: mockApi.voteMessage
}))

vi.mock('../../src/renderer/src/stores/toast', () => ({
  useToastStore: () => mockToast
}))

interface QueuedPrompt {
  id: string
  text: string
  attachments: AiAttachment[]
  references: AiImageReference[]
  scope: AiSearchScope | null
  includeR18: boolean
}

type AssistantStoreModule = {
  useAssistantStore: () => {
    currentId: number | null
    draft: string
    attachments: AiAttachment[]
    references: AiImageReference[]
    usingGalleryReferences: boolean
    recalledMessageId: number | null
    scope: AiSearchScope | null
    includeR18: boolean
    waiting: boolean
    aborting: boolean
    streamingText: string
    streamingStatus: string | null
    streamingBlocks: AiTimelineBlock[]
    streamingMemoryNotice: AiMemoryNotice | null
    canSend: boolean
    queue: QueuedPrompt[]
    send: (text?: string) => Promise<void>
    enqueueCurrent: () => QueuedPrompt | null
    removeQueued: (queueId: string) => boolean
    editQueued: (queueId: string) => boolean
    abortCurrent: () => Promise<boolean>
    interruptAndSend: () => Promise<void>
    sendQueuedNow: (queueId: string) => Promise<void>
    handleStreamEvent: (ev: AiStreamEvent) => void
  }
}

const storePath = '../../src/renderer/src/stores/assistant.ts'
const { useAssistantStore } = (await import(storePath)) as AssistantStoreModule

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let msgSeq = 0

function makeAskResult(conversationId: number, text: string): AiAskResultVO {
  const id = ++msgSeq
  return {
    conversation: {
      id: conversationId,
      title: '测试对话',
      pinned: false,
      updatedAt: `2026-11-26T00:00:0${id}.000Z`
    },
    message: {
      id,
      role: 'user',
      text,
      how: null,
      images: [],
      vote: null,
      createdAt: `2026-11-26T00:00:0${id}.000Z`,
      image: null
    }
  }
}

function makeReply(text: string, overrides: Partial<AiMessageVO> = {}): AiMessageVO {
  const id = ++msgSeq
  return {
    id,
    role: 'assistant',
    text,
    how: null,
    images: [],
    vote: null,
    createdAt: `2026-11-26T00:01:0${id}.000Z`,
    image: null,
    ...overrides
  }
}

describe('assistant store queue, abort & stream events', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    msgSeq = 0
  })

  it('enqueueCurrent captures composer state, keeps canSend active while waiting, and isolates queues per chat', () => {
    const store = useAssistantStore()
    store.currentId = 10
    store.waiting = true
    store.draft = '  第一条排队消息  '
    store.attachments = [{ kind: 'image', name: 'cat.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]
    store.references = [{ imageId: 7, name: 'ref.jpg', groupId: 'result:1', position: 1 }]
    store.scope = { kind: 'category', name: '壁纸' }
    store.includeR18 = true
    store.recalledMessageId = 3

    expect(store.canSend).toBe(true)

    const queued = store.enqueueCurrent()
    expect(queued).not.toBeNull()
    expect(queued?.text).toBe('第一条排队消息')
    expect(queued?.attachments).toHaveLength(1)
    expect(queued?.references).toHaveLength(1)
    expect(queued?.scope).toEqual({ kind: 'category', name: '壁纸' })
    expect(queued?.includeR18).toBe(true)

    // Composer cleared
    expect(store.draft).toBe('')
    expect(store.attachments).toEqual([])
    expect(store.references).toEqual([])
    expect(store.recalledMessageId).toBeNull()
    expect(store.queue).toHaveLength(1)

    // Empty composer is ignored
    expect(store.enqueueCurrent()).toBeNull()
    expect(store.queue).toHaveLength(1)

    // Per-conversation isolation
    store.currentId = 20
    expect(store.queue).toEqual([])
    store.draft = '另一个会话的消息'
    store.enqueueCurrent()
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0].text).toBe('另一个会话的消息')

    store.currentId = 10
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0].text).toBe('第一条排队消息')
  })

  it('auto-dequeues head item after a natural reply finishes', async () => {
    const store = useAssistantStore()
    store.currentId = 1

    const reply1 = deferred<AiMessageVO>()
    const reply2 = deferred<AiMessageVO>()
    const reply3 = deferred<AiMessageVO>()

    mockApi.askNono.mockImplementation(async (dto: AiAskDTO) => makeAskResult(dto.conversationId ?? 1, dto.text))
    mockApi.fetchAnswer
      .mockImplementationOnce(() => reply1.promise)
      .mockImplementationOnce(() => reply2.promise)
      .mockImplementationOnce(() => reply3.promise)

    store.draft = '首条问题'
    const firstSend = store.send()
    await flushMicrotasks()

    expect(store.waiting).toBe(true)
    expect(mockApi.askNono).toHaveBeenCalledTimes(1)

    // Enqueue two items while waiting
    store.draft = '排队 1'
    store.enqueueCurrent()
    store.draft = '排队 2'
    store.enqueueCurrent()
    expect(store.queue.map((q) => q.text)).toEqual(['排队 1', '排队 2'])

    // Natural reply 1 completes -> head item ("排队 1") auto-dequeues
    reply1.resolve(makeReply('回答 1'))
    await firstSend
    await flushMicrotasks()

    expect(mockApi.askNono).toHaveBeenCalledTimes(2)
    expect(mockApi.askNono.mock.calls[1][0].text).toBe('排队 1')
    expect(store.queue.map((q) => q.text)).toEqual(['排队 2'])
    expect(store.waiting).toBe(true)

    // Natural reply 2 completes -> "排队 2" auto-dequeues
    reply2.resolve(makeReply('回答 2'))
    await flushMicrotasks()

    expect(mockApi.askNono).toHaveBeenCalledTimes(3)
    expect(mockApi.askNono.mock.calls[2][0].text).toBe('排队 2')
    expect(store.queue).toEqual([])

    // Final reply completes -> idle
    reply3.resolve(makeReply('回答 3'))
    await flushMicrotasks()
    expect(store.waiting).toBe(false)
  })

  it('manual abortCurrent awaits settlement and does NOT auto-dequeue queued items', async () => {
    const store = useAssistantStore()
    store.currentId = 5

    // Guard cases
    expect(await store.abortCurrent()).toBe(false)

    const answer1 = deferred<AiMessageVO>()
    const abortDeferred = deferred<boolean>()

    mockApi.askNono.mockResolvedValueOnce(makeAskResult(5, '正在问'))
    mockApi.fetchAnswer.mockImplementationOnce(() => answer1.promise)
    mockApi.abortAnswer.mockImplementationOnce(() => abortDeferred.promise)

    store.draft = '正在问'
    const sendPromise = store.send()
    await flushMicrotasks()

    store.draft = '队列里保留的消息'
    store.enqueueCurrent()
    expect(store.queue).toHaveLength(1)

    const abortPromise = store.abortCurrent()
    expect(store.aborting).toBe(true)
    // Duplicate abort while aborting returns false immediately
    expect(await store.abortCurrent()).toBe(false)

    // Backend aborts and resolves partial reply
    abortDeferred.resolve(true)
    answer1.resolve(makeReply('半截回复', { interrupted: true }))

    expect(await abortPromise).toBe(true)
    await sendPromise
    await flushMicrotasks()

    expect(store.aborting).toBe(false)
    expect(store.waiting).toBe(false)
    expect(mockApi.askNono).toHaveBeenCalledTimes(1)
    // Queue item remains untouched for user inspection/action
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0].text).toBe('队列里保留的消息')
  })

  it('interruptAndSend captures composer, clears it, aborts active turn, and immediately sends captured item', async () => {
    const store = useAssistantStore()
    store.currentId = 8

    const answer1 = deferred<AiMessageVO>()
    const answer2 = deferred<AiMessageVO>()
    const answer3 = deferred<AiMessageVO>()

    mockApi.askNono.mockImplementation(async (dto: AiAskDTO) => makeAskResult(dto.conversationId ?? 8, dto.text))
    mockApi.fetchAnswer
      .mockImplementationOnce(() => answer1.promise)
      .mockImplementationOnce(() => answer2.promise)
      .mockImplementationOnce(() => answer3.promise)
    mockApi.abortAnswer.mockImplementationOnce(async () => {
      answer1.resolve(makeReply('被打断', { interrupted: true }))
      return true
    })

    store.draft = '原始问题'
    const p1 = store.send()
    await flushMicrotasks()

    // Put an existing item in queue first
    store.draft = '之前排队的'
    store.enqueueCurrent()

    // User types urgent follow-up and hits Ctrl+Enter
    store.draft = '插嘴消息'
    store.includeR18 = true
    const interruptPromise = store.interruptAndSend()

    expect(store.draft).toBe('')
    expect(mockApi.abortAnswer).toHaveBeenCalledWith(8)

    await flushMicrotasks()
    expect(mockApi.askNono).toHaveBeenCalledTimes(2)
    expect(mockApi.askNono.mock.calls[1][0].text).toBe('插嘴消息')
    expect(mockApi.askNono.mock.calls[1][0].includeR18).toBe(true)
    // Existing queue item stays queued while interrupting message runs
    expect(store.queue.map((q) => q.text)).toEqual(['之前排队的'])

    // Once interrupting message finishes naturally, remaining queue item auto-dequeues
    answer2.resolve(makeReply('插嘴回答'))
    await interruptPromise
    await p1
    await flushMicrotasks()

    expect(mockApi.askNono).toHaveBeenCalledTimes(3)
    expect(mockApi.askNono.mock.calls[2][0].text).toBe('之前排队的')
    answer3.resolve(makeReply('排队回答'))
    await flushMicrotasks()
    expect(store.waiting).toBe(false)
  })

  it('sendQueuedNow removes target item, aborts active turn, and sends that item immediately', async () => {
    const store = useAssistantStore()
    store.currentId = 12

    const answer1 = deferred<AiMessageVO>()
    const answer2 = deferred<AiMessageVO>()

    mockApi.askNono.mockImplementation(async (dto: AiAskDTO) => makeAskResult(dto.conversationId ?? 12, dto.text))
    mockApi.fetchAnswer
      .mockImplementationOnce(() => answer1.promise)
      .mockImplementationOnce(() => answer2.promise)
    mockApi.abortAnswer.mockImplementationOnce(async () => {
      answer1.resolve(makeReply('中断', { interrupted: true }))
      return true
    })

    store.draft = '第一个问题'
    const p1 = store.send()
    await flushMicrotasks()

    store.draft = '排队 A'
    const qA = store.enqueueCurrent()!
    store.draft = '排队 B'
    const qB = store.enqueueCurrent()!

    const sendNowPromise = store.sendQueuedNow(qB.id)
    expect(store.queue.map((q) => q.id)).toEqual([qA.id])

    await flushMicrotasks()
    expect(mockApi.abortAnswer).toHaveBeenCalledWith(12)
    expect(mockApi.askNono).toHaveBeenCalledTimes(2)
    expect(mockApi.askNono.mock.calls[1][0].text).toBe('排队 B')

    answer2.resolve(makeReply('回答 B'))
    await sendNowPromise
    await p1
  })

  it('editQueued restores full draft state including references and removeQueued deletes item', () => {
    const store = useAssistantStore()
    store.currentId = 3

    store.draft = '待编辑消息'
    store.attachments = [{ kind: 'markdown', name: 'note.md', text: '# hi' }]
    store.references = [{ imageId: 99, name: 'miku.png', groupId: 'result:2', position: 1 }]
    store.scope = { kind: 'category', name: '插画' }
    store.includeR18 = true
    const item1 = store.enqueueCurrent()!

    store.draft = '待删除消息'
    store.attachments = []
    store.references = []
    store.scope = null
    store.includeR18 = false
    const item2 = store.enqueueCurrent()!

    expect(store.queue).toHaveLength(2)

    // Remove item2
    expect(store.removeQueued(item2.id)).toBe(true)
    expect(store.removeQueued('missing-id')).toBe(false)
    expect(store.queue.map((q) => q.id)).toEqual([item1.id])

    // Edit item1 back to composer
    store.usingGalleryReferences = false
    expect(store.editQueued(item1.id)).toBe(true)
    expect(store.queue).toEqual([])
    expect(store.draft).toBe('待编辑消息')
    expect(store.attachments).toEqual([{ kind: 'markdown', name: 'note.md', text: '# hi' }])
    expect(store.references).toEqual([{ imageId: 99, name: 'miku.png', groupId: 'result:2', position: 1 }])
    expect(store.usingGalleryReferences).toBe(true)
    expect(store.scope).toEqual({ kind: 'category', name: '插画' })
    expect(store.includeR18).toBe(true)
  })

  it('handleStreamEvent handles narration_commit, action_start, action_end, memory_notice, and aborted', () => {
    const store = useAssistantStore()
    store.currentId = 42
    store.waiting = true

    const emit = (ev: Omit<AiStreamEvent, 'conversationId'>, conversationId = 42) =>
      store.handleStreamEvent({ conversationId, ...ev })

    // Ignored for different conversation
    emit({ kind: 'delta', text: 'wrong chat' }, 99)
    expect(store.streamingText).toBe('')

    emit({ kind: 'status', text: '准备中' })
    expect(store.streamingStatus).toBe('准备中')

    emit({ kind: 'delta', text: '先去' })
    emit({ kind: 'delta', text: '翻翻图库' })
    expect(store.streamingText).toBe('先去翻翻图库')
    expect(store.streamingStatus).toBeNull()

    emit({ kind: 'narration_commit', text: '先去翻翻图库' })
    expect(store.streamingText).toBe('')
    expect(store.streamingBlocks).toEqual([{ type: 'narration', text: '先去翻翻图库' }])

    emit({ kind: 'action_start', actionId: 'a1', tool: 'search_images', summary: '搜索图库…' })
    expect(store.streamingStatus).toBe('搜索图库…')
    expect(store.streamingBlocks).toHaveLength(2)
    expect(store.streamingBlocks[1]).toEqual({
      type: 'action',
      id: 'a1',
      tool: 'search_images',
      summary: '搜索图库…',
      status: 'running'
    })

    // Second concurrent action keeps streamingStatus until all running actions end
    emit({ kind: 'action_start', actionId: 'a2', tool: 'remember', summary: '记下偏好…' })
    emit({ kind: 'action_end', actionId: 'a1', status: 'done', summary: '找到 6 张' })
    expect(store.streamingStatus).toBe('记下偏好…')

    emit({ kind: 'action_end', actionId: 'a2', status: 'done', summary: '已记住偏好' })
    expect(store.streamingStatus).toBeNull()
    expect(store.streamingBlocks[1]).toEqual({
      type: 'action',
      id: 'a1',
      tool: 'search_images',
      summary: '找到 6 张',
      status: 'done'
    })
    expect(store.streamingBlocks[2]).toEqual({
      type: 'action',
      id: 'a2',
      tool: 'remember',
      summary: '已记住偏好',
      status: 'done'
    })

    emit({ kind: 'memory_notice', memoryNotice: { action: 'save', notices: ['记住你喜欢蓝发角色'] } })
    expect(store.streamingMemoryNotice).toEqual({ action: 'save', notices: ['记住你喜欢蓝发角色'] })

    emit({ kind: 'status', text: '收尾中' })
    emit({ kind: 'aborted' })
    expect(store.streamingStatus).toBeNull()

    emit({ kind: 'delta', text: '找到啦，给你看看' })
    expect(store.streamingText).toBe('找到啦，给你看看')
    emit({ kind: 'action_start', actionId: 'a3', tool: 'search_images', summary: '检索图库…' })
    expect(store.streamingText).toBe('')
  })
})
