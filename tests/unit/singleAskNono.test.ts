import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiConversationVO, AiImageReference, AiMessageVO } from '@shared/api'

const mockApi = vi.hoisted(() => ({
  fetchAiStatus: vi.fn(),
  fetchConversations: vi.fn(),
  fetchIdeas: vi.fn(),
  fetchMessages: vi.fn(),
  fetchRecalledDraft: vi.fn(),
  askNono: vi.fn(),
  compactConversation: vi.fn(),
  editMessage: vi.fn(),
  recallMessage: vi.fn(),
  fetchAnswer: vi.fn(),
  pinConversation: vi.fn(),
  removeConversation: vi.fn(),
  renameConversation: vi.fn(),
  undoRemoveConversation: vi.fn(),
  voteMessage: vi.fn(),
  toastShow: vi.fn()
}))

vi.mock('@/api/ai', () => ({
  askNono: mockApi.askNono,
  compactConversation: mockApi.compactConversation,
  editMessage: mockApi.editMessage,
  recallMessage: mockApi.recallMessage,
  fetchRecalledDraft: mockApi.fetchRecalledDraft,
  fetchAiStatus: mockApi.fetchAiStatus,
  fetchAnswer: mockApi.fetchAnswer,
  fetchConversations: mockApi.fetchConversations,
  fetchIdeas: mockApi.fetchIdeas,
  fetchMessages: mockApi.fetchMessages,
  pinConversation: mockApi.pinConversation,
  removeConversation: mockApi.removeConversation,
  renameConversation: mockApi.renameConversation,
  undoRemoveConversation: mockApi.undoRemoveConversation,
  voteMessage: mockApi.voteMessage
}))

vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ show: mockApi.toastShow, close: vi.fn() })
}))

vi.mock('../../src/renderer/src/stores/toast', () => ({
  useToastStore: () => ({ show: mockApi.toastShow, close: vi.fn() })
}))

const assistantModulePath = '../../src/renderer/src/stores/assistant.ts'

type AssistantStoreModule = {
  useAssistantStore: () => {
    ready: boolean | null
    conversations: AiConversationVO[]
    currentId: number | null
    messages: AiMessageVO[]
    ideas: string[]
    references: AiImageReference[]
    usingGalleryReferences: boolean
    enter: () => Promise<void>
    addReferences: (items: AiImageReference[]) => void
  }
}

const { useAssistantStore } = (await import(assistantModulePath)) as AssistantStoreModule

function makeConversation(id: number, title = `对话 ${id}`): AiConversationVO {
  return {
    id,
    title,
    pinned: false,
    updatedAt: '2026-11-25T10:00:00.000Z'
  }
}

function makeMessage(id: number, text = '你好'): AiMessageVO {
  return {
    id,
    role: 'user',
    text,
    how: null,
    images: [],
    hasStoredResults: false,
    vote: null,
    image: null,
    createdAt: '2026-11-25T10:00:00.000Z'
  }
}

function makeRef(imageId: number, name = `image_${imageId}.png`, position = 1): AiImageReference {
  return {
    imageId,
    name,
    groupId: 'gallery:test-group',
    position
  }
}

describe('single ask nono session continuity (useAssistantStore)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockApi.fetchAiStatus.mockResolvedValue({ ready: true })
    mockApi.fetchConversations.mockResolvedValue([])
    mockApi.fetchIdeas.mockResolvedValue(['示例问题 1'])
  })

  it('keeps active conversation open and preserves single image chip in references on enter()', async () => {
    const store = useAssistantStore()
    store.currentId = 42
    store.messages = [makeMessage(1, '上一条消息')]
    mockApi.fetchConversations.mockResolvedValue([makeConversation(42, '进行中的对话')])

    const ref = makeRef(101, '小猫.png')
    store.addReferences([ref])
    await store.enter()

    expect(store.currentId).toBe(42)
    expect(store.messages).toHaveLength(1)
    expect(store.references).toEqual([ref])
    expect(store.usingGalleryReferences).toBe(true)
    expect(mockApi.fetchIdeas).not.toHaveBeenCalled()
  })

  it('stays on new conversation (currentId = null) with references populated when no conversation is open', async () => {
    const store = useAssistantStore()
    expect(store.currentId).toBeNull()

    const ref = makeRef(202, '夕阳.jpg')
    store.addReferences([ref])
    await store.enter()

    expect(store.currentId).toBeNull()
    expect(store.references).toEqual([ref])
    expect(store.usingGalleryReferences).toBe(true)
    expect(mockApi.fetchIdeas).toHaveBeenCalledTimes(1)
    expect(store.ideas).toEqual(['示例问题 1'])
  })

  it('resets stale deleted currentId to null and refreshes ideas while preserving references', async () => {
    const store = useAssistantStore()
    store.currentId = 99
    store.messages = [makeMessage(10, '已删除对话的消息')]
    mockApi.fetchConversations.mockResolvedValue([makeConversation(42, '另一个对话')])

    const ref = makeRef(303, '风景.png')
    store.addReferences([ref])
    await store.enter()

    expect(store.currentId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.references).toEqual([ref])
    expect(store.usingGalleryReferences).toBe(true)
    expect(mockApi.fetchIdeas).toHaveBeenCalledTimes(1)
    expect(store.ideas).toEqual(['示例问题 1'])
  })

  it('deduplicates duplicate imageId via addReferences', () => {
    const store = useAssistantStore()
    const first = makeRef(404, 'first.png', 1)
    const duplicate = makeRef(404, 'duplicate.png', 2)
    const second = makeRef(405, 'second.png', 3)

    store.addReferences([first, duplicate])
    store.addReferences([duplicate, second])

    expect(store.references).toEqual([first, second])
    expect(store.usingGalleryReferences).toBe(true)
  })
})
