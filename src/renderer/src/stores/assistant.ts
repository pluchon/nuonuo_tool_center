import { toRaw } from 'vue'
import { defineStore } from 'pinia'
import type {
  AiAttachment,
  AiConversationVO,
  AiImageReference,
  AiMemoryNotice,
  AiMessageVO,
  AiRecalledDraft,
  AiSearchScope,
  AiStreamEvent,
  AiTimelineBlock
} from '@shared/api'
import {
  abortAnswer,
  askNono,
  compactConversation,
  editMessage,
  recallMessage,
  fetchRecalledDraft,
  fetchAiStatus,
  fetchAnswer,
  fetchConversations,
  fetchIdeas,
  fetchMessages,
  pinConversation,
  removeConversation,
  renameConversation,
  undoRemoveConversation,
  voteMessage
} from '@/api/ai'
import { useToastStore } from './toast'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let messagesVersion = 0
let queueSeq = 0

type ComposerDraft = Omit<AiRecalledDraft, 'messageId'> & { messageId: number | null }

export interface QueuedPrompt {
  id: string
  text: string
  attachments: AiAttachment[]
  references: AiImageReference[]
  scope: AiSearchScope | null
  includeR18: boolean
}

export interface SendPayload {
  text: string
  attachments: AiAttachment[]
  references: AiImageReference[]
  scope: AiSearchScope | null
  includeR18: boolean
  recalledMessageId?: number | null
  clearComposerOnSuccess?: boolean
}

interface StoreFlightState {
  fetchPromise: Promise<void> | null
  suppressAutoDequeue: boolean
}

const flightByStore = new WeakMap<object, StoreFlightState>()

function flightOf(store: { queuesByChat: Map<number | null, QueuedPrompt[]> }): StoreFlightState {
  const key = toRaw(store.queuesByChat)
  let entry = flightByStore.get(key)
  if (!entry) {
    entry = { fetchPromise: null, suppressAutoDequeue: false }
    flightByStore.set(key, entry)
  }
  return entry
}

// 诺诺助手：对话记录、当前对话的消息、输入框里的范围和 R-18 开关、等待回复和出错的状态
export const useAssistantStore = defineStore('assistant', {
  state: () => ({
    // null：还没查过；false：没配云端凭证，整页显示“诺诺还没连上云端”
    ready: null as boolean | null,
    conversations: [] as AiConversationVO[],
    currentId: null as number | null,
    messages: [] as AiMessageVO[],
    // 新对话的示例问题
    ideas: [] as string[],
    draft: '',
    attachments: [] as AiAttachment[],
    references: [] as AiImageReference[],
    usingGalleryReferences: false,
    recalledMessageId: null as number | null,
    draftsByChat: new Map<number | null, ComposerDraft>(),
    changingTurn: false,
    // 在哪里找：空表示全部图库
    scope: null as AiSearchScope | null,
    includeR18: false,
    // 正在等回复
    waiting: false,
    aborting: false,
    compacting: false,
    streamingText: '',
    streamingStatus: null as string | null,
    streamingBlocks: [] as AiTimelineBlock[],
    streamingMemoryNotice: null as AiMemoryNotice | null,
    queuesByChat: new Map<number | null, QueuedPrompt[]>(),
    // 最后一句没回复成功：横幅显示的原因（如“网络异常”），点“重试”再取一次回复
    failure: null as string | null,
    loadingMessages: false
  }),
  getters: {
    current(s): AiConversationVO | null {
      return s.conversations.find((c) => c.id === s.currentId) ?? null
    },
    canSend(s): boolean {
      return (s.draft.trim() !== '' || s.attachments.length > 0 || s.references.length > 0) && !s.loadingMessages && !s.changingTurn
    },
    queue(s): QueuedPrompt[] {
      return s.queuesByChat.get(s.currentId) ?? []
    }
  },
  actions: {
    // 进入诺诺助手页：查一次能不能用，读对话记录；没有当前对话时换一批示例问题
    async enter(): Promise<void> {
      try {
        const status = await fetchAiStatus()
        this.ready = status.ready
      } catch (err) {
        this.ready = false
        useToastStore().show(`诺诺状态读不出来：${errText(err)}`, 'error')
        return
      }
      if (!this.ready && !this.usingGalleryReferences) {
        return
      }
      await this.loadConversations()
      if (this.currentId !== null && !this.conversations.some((c) => c.id === this.currentId)) {
        this.currentId = null
        this.messages = []
        await this.refreshIdeas()
        return
      }
      if (this.currentId === null) {
        await this.refreshIdeas()
      }
    },
    // 对话记录
    async loadConversations(): Promise<void> {
      try {
        this.conversations = await fetchConversations()
      } catch (err) {
        useToastStore().show(`对话记录读不出来：${errText(err)}`, 'error')
      }
    },
    // 换一批示例问题（失败就不显示示例）
    async refreshIdeas(): Promise<void> {
      try {
        this.ideas = await fetchIdeas()
      } catch {
        this.ideas = []
      }
    },
    // 新对话：清空当前对话，换一批示例问题
    async newChat(): Promise<void> {
      if (this.waiting || this.changingTurn) return
      if (this.currentId === null && this.messages.length === 0) {
        useToastStore().show('已经是新对话了')
        return
      }
      const unsent = this.currentId !== null ? this.draftsByChat.get(null) : undefined
      if (this.currentId !== null && !this.loadingMessages) this.keepDraft()
      ++messagesVersion
      this.loadingMessages = false
      this.currentId = null
      this.messages = []
      this.failure = null
      this.streamingText = ''
      this.streamingStatus = null
      this.streamingBlocks = []
      this.streamingMemoryNotice = null
      this.draft = ''
      this.attachments = []
      this.recalledMessageId = null
      this.references = []
      this.usingGalleryReferences = false
      if (unsent) this.restoreDraft(unsent)
      this.draftsByChat.delete(null)
      await this.refreshIdeas()
    },
    // 返回助手时重新读取已有结果的分级与标签状态。
    async refreshResults(): Promise<void> {
      const id = this.currentId
      const searches = this.messages.filter((message) => message.hasStoredResults)
      if (id === null || searches.length === 0 || this.loadingMessages) return
      const version = ++messagesVersion
      // 查询期间先收起旧卡片，避免图库里刚改过分级的图片短暂显示原缩略图。
      for (const message of searches) message.images = []
      try {
        const fresh = new Map((await fetchMessages(id)).map((message) => [message.id, message]))
        if (this.currentId !== id || version !== messagesVersion) return
        for (const message of searches) {
          const result = fresh.get(message.id)
          if (result) {
            message.images = result.images
            message.text = result.text
            message.how = result.how
          }
        }
      } catch (err) {
        if (this.currentId === id && version === messagesVersion) useToastStore().show(`图片读不出来：${errText(err)}`, 'error')
      }
    },
    // 打开一段对话
    async open(id: number): Promise<void> {
      if (this.waiting || this.changingTurn) {
        return
      }
      const version = ++messagesVersion
      const switched = this.currentId !== id
      if (switched) {
        if (!this.loadingMessages) this.keepDraft()
        this.messages = []
        this.draft = ''
        this.attachments = []
        this.recalledMessageId = null
        this.references = []
      } else {
        for (const message of this.messages) message.images = []
      }
      this.currentId = id
      this.failure = null
      this.streamingText = ''
      this.streamingStatus = null
      this.streamingBlocks = []
      this.streamingMemoryNotice = null
      this.loadingMessages = true
      try {
        const [msgs, recalled] = await Promise.all([fetchMessages(id), switched ? fetchRecalledDraft(id) : null])
        if (this.currentId === id && version === messagesVersion) {
          this.messages = msgs
          if (switched) this.usingGalleryReferences = msgs.some((m) => !!m.references?.length)
          const cached = this.draftsByChat.get(id)
          if (cached && cached.messageId === (recalled?.messageId ?? null)) this.restoreDraft(cached)
          else if (recalled) this.restoreDraft(recalled)
          this.draftsByChat.delete(id)
          // 最后一句是你说的、还没有回复（上次出错或应用关了）：显示重试横幅
          const last = msgs[msgs.length - 1]
          this.failure = last && last.role === 'user' ? '上次没回复成功' : null
        }
      } catch (err) {
        if (this.currentId === id && version === messagesVersion) {
          useToastStore().show(`对话读不出来：${errText(err)}`, 'error')
        }
      } finally {
        if (version === messagesVersion) this.loadingMessages = false
      }
    },
    async compact(): Promise<void> {
      if (this.waiting || this.changingTurn || this.loadingMessages) return
      if (this.currentId === null) {
        useToastStore().show('当前没有可精简的对话')
        return
      }
      this.changingTurn = true
      this.compacting = true
      try {
        const reply = await compactConversation(this.currentId)
        const checkpoint = reply.checkpoint
        if (checkpoint) {
          const message = this.messages.find(m => m.id === checkpoint.messageId)
          if (message) message.contextUsage = checkpoint.usage
        }
        if (this.draft.trim() === '/compact') this.draft = ''
        useToastStore().show(reply.changed ? '已精简对话上下文' : '没有新的对话需要精简')
      } catch (error) {
        useToastStore().show(errText(error), 'error')
      } finally {
        this.compacting = false
        this.changingTurn = false
      }
    },
    // 发送：先存下这句话（新对话会出现在对话记录里），再等诺诺的回复
    async sendItem(item: SendPayload): Promise<void> {
      const q = item.text.trim()
      if (q === '/compact') return this.compact()
      if ((!q && !item.attachments.length && !item.references.length) || this.waiting || this.loadingMessages || this.changingTurn) {
        return
      }
      const prevId = this.currentId
      this.waiting = true
      this.failure = null
      try {
        const res = await askNono({
          conversationId: this.currentId,
          text: q,
          scope: item.scope ? { ...item.scope } : null,
          ...(item.recalledMessageId !== null && item.recalledMessageId !== undefined ? { recalledMessageId: item.recalledMessageId } : {}),
          includeR18: item.includeR18,
          attachments: item.attachments.map((file) => ({ ...file })),
          references: item.references.map((r) => ({ ...r }))
        })
        if (item.clearComposerOnSuccess) {
          if (this.draft.trim() === q) this.draft = ''
          this.attachments = this.attachments.filter((file) => !item.attachments.includes(file))
          const sent = new Set(item.references.map((r) => r.imageId))
          this.references = this.references.filter((r) => !sent.has(r.imageId))
          this.recalledMessageId = null
        }
        if (prevId === null && res.conversation.id !== null) {
          const pendingQueue = this.queuesByChat.get(null)
          if (pendingQueue?.length) {
            const targetQueue = this.queuesByChat.get(res.conversation.id) ?? []
            this.queuesByChat.set(res.conversation.id, [...targetQueue, ...pendingQueue])
            this.queuesByChat.delete(null)
          }
        }
        this.currentId = res.conversation.id
        if (!this.conversations.some((c) => c.id === res.conversation.id)) {
          this.conversations = [res.conversation, ...this.conversations]
          this.messages = []
        }
        this.messages = [...this.messages, res.message]
        this.touch(res.conversation.id, res.message.createdAt)
      } catch (err) {
        this.waiting = false
        useToastStore().show(errText(err), 'error')
        return
      }
      await this.fetchReply()
    },
    async send(text?: string): Promise<void> {
      const q = (text ?? this.draft).trim()
      if (q === '/compact') return this.compact()
      const attachments = text === undefined ? this.attachments : []
      const references = [...this.references]
      if ((!q && !attachments.length && !references.length) || this.waiting || this.loadingMessages || this.changingTurn) {
        return
      }
      await this.sendItem({
        text: q,
        attachments,
        references,
        scope: this.scope ? { ...this.scope } : null,
        includeR18: this.includeR18,
        recalledMessageId: this.recalledMessageId,
        clearComposerOnSuccess: text === undefined
      })
    },
    enqueueCurrent(): QueuedPrompt | null {
      const text = this.draft.trim()
      if ((!text && !this.attachments.length && !this.references.length) || this.loadingMessages || this.changingTurn) {
        return null
      }
      const item: QueuedPrompt = {
        id: `q-${Date.now()}-${++queueSeq}`,
        text,
        attachments: this.attachments.map((file) => ({ ...file })),
        references: this.references.map((r) => ({ ...r })),
        scope: this.scope ? { ...this.scope } : null,
        includeR18: this.includeR18
      }
      const currentQueue = this.queuesByChat.get(this.currentId) ?? []
      this.queuesByChat.set(this.currentId, [...currentQueue, item])
      this.draft = ''
      this.attachments = []
      this.references = []
      this.recalledMessageId = null
      return item
    },
    removeQueued(queueId: string): boolean {
      const currentQueue = this.queuesByChat.get(this.currentId)
      if (!currentQueue?.length) return false
      const next = currentQueue.filter((q) => q.id !== queueId)
      if (next.length === currentQueue.length) return false
      if (next.length) this.queuesByChat.set(this.currentId, next)
      else this.queuesByChat.delete(this.currentId)
      return true
    },
    editQueued(queueId: string): boolean {
      const currentQueue = this.queuesByChat.get(this.currentId)
      const item = currentQueue?.find((q) => q.id === queueId)
      if (!item) return false
      this.removeQueued(queueId)
      this.draft = item.text
      this.attachments = item.attachments.map((file) => ({ ...file }))
      this.references = item.references.map((r) => ({ ...r }))
      if (this.references.length) this.usingGalleryReferences = true
      this.scope = item.scope ? { ...item.scope } : null
      this.includeR18 = item.includeR18
      this.recalledMessageId = null
      return true
    },
    async abortCurrent(): Promise<boolean> {
      if (!this.waiting || this.aborting || this.currentId === null) {
        return false
      }
      const targetId = this.currentId
      const flight = flightOf(this)
      this.aborting = true
      flight.suppressAutoDequeue = true
      let aborted = false
      try {
        aborted = await abortAnswer(targetId)
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
      try {
        if (flight.fetchPromise) {
          await flight.fetchPromise
        }
      } finally {
        flight.suppressAutoDequeue = false
        this.aborting = false
      }
      return aborted
    },
    async interruptAndSend(): Promise<void> {
      const q = this.draft.trim()
      if ((!q && !this.attachments.length && !this.references.length) || this.aborting || this.loadingMessages || this.changingTurn) {
        return
      }
      const captured: SendPayload = {
        text: q,
        attachments: this.attachments.map((file) => ({ ...file })),
        references: this.references.map((r) => ({ ...r })),
        scope: this.scope ? { ...this.scope } : null,
        includeR18: this.includeR18,
        recalledMessageId: this.recalledMessageId
      }
      this.draft = ''
      this.attachments = []
      this.references = []
      this.recalledMessageId = null
      await this.abortCurrent()
      await this.sendItem(captured)
    },
    async sendQueuedNow(queueId: string): Promise<void> {
      if (this.aborting || this.loadingMessages || this.changingTurn) return
      const currentQueue = this.queuesByChat.get(this.currentId)
      const item = currentQueue?.find((q) => q.id === queueId)
      if (!item) return
      this.removeQueued(queueId)
      await this.abortCurrent()
      await this.sendItem(item)
    },
    keepDraft(): void {
      if (this.draft || this.attachments.length || this.references.length || this.recalledMessageId !== null) {
        this.draftsByChat.set(this.currentId, { text: this.draft, attachments: this.attachments, references: this.references,
          scope: this.scope, includeR18: this.includeR18, messageId: this.recalledMessageId })
      } else {
        this.draftsByChat.delete(this.currentId)
      }
    },
    restoreDraft(draft: ComposerDraft): void {
      this.draft = draft.text
      this.attachments = draft.attachments
      this.references = draft.references ?? []
      if (this.references.length) this.usingGalleryReferences = true
      this.scope = draft.scope
      this.includeR18 = draft.includeR18
      this.recalledMessageId = draft.messageId
    },
    addReferences(items: AiImageReference[]): void {
      if (items.length) this.usingGalleryReferences = true
      const seen = new Set(this.references.map((r) => r.imageId))
      for (const item of items) {
        if (seen.has(item.imageId)) continue
        seen.add(item.imageId)
        this.references.push(item)
      }
    },
    removeReference(imageId: number): void {
      this.references = this.references.filter((r) => r.imageId !== imageId)
    },
    async revise(messageId: number, replacement?: string): Promise<boolean> {
      const id = this.currentId
      if (id === null || this.waiting || this.changingTurn || this.loadingMessages) return false
      this.changingTurn = true
      this.streamingText = ''
      this.streamingStatus = null
      this.streamingBlocks = []
      this.streamingMemoryNotice = null
      try {
        if (replacement === undefined) {
          const draft = await recallMessage(id, messageId)
          this.messages = this.messages.filter((m) => m.id < messageId)
          this.restoreDraft(draft)
        } else {
          const revised = await editMessage(id, messageId, replacement)
          this.messages = [...this.messages.filter((m) => m.id < messageId), revised]
          this.touch(id, revised.createdAt)
        }
        this.failure = null
      } catch (err) {
        useToastStore().show(errText(err), 'error')
        return false
      } finally {
        this.changingTurn = false
      }
      if (replacement !== undefined) await this.fetchReply()
      return true
    },
    handleStreamEvent(ev: AiStreamEvent): void {
      if (ev.conversationId !== this.currentId || !this.waiting) return
      if (ev.kind === 'delta') {
        if (ev.text) {
          this.streamingText += ev.text
          this.streamingStatus = null
        }
      } else if (ev.kind === 'status') {
        this.streamingStatus = ev.text ?? null
      } else if (ev.kind === 'narration_commit') {
        this.streamingBlocks = [...this.streamingBlocks, { type: 'narration', text: ev.text ?? '' }]
        this.streamingText = ''
      } else if (ev.kind === 'action_start') {
        this.streamingBlocks = [
          ...this.streamingBlocks,
          { type: 'action', id: ev.actionId ?? '', tool: ev.tool ?? '', summary: ev.summary ?? ev.text ?? '', status: 'running' }
        ]
        this.streamingStatus = ev.summary ?? ev.text ?? null
      } else if (ev.kind === 'action_end') {
        const targetId = ev.actionId ?? ''
        this.streamingBlocks = this.streamingBlocks.map((b) =>
          b.type === 'action' && b.id === targetId
            ? { ...b, status: ev.status ?? 'done', summary: ev.summary ?? b.summary }
            : b
        )
        if (!this.streamingBlocks.some((b) => b.type === 'action' && b.status === 'running')) {
          this.streamingStatus = null
        }
      } else if (ev.kind === 'memory_notice') {
        this.streamingMemoryNotice = ev.memoryNotice ?? null
      } else if (ev.kind === 'reset') {
        this.streamingText = ''
        this.streamingStatus = null
        this.streamingBlocks = []
        this.streamingMemoryNotice = null
      } else if (ev.kind === 'aborted' || ev.kind === 'done' || ev.kind === 'error') {
        this.streamingStatus = null
      }
    },
    // 取回复；失败时显示横幅，点“重试”再取一次
    async fetchReply(): Promise<void> {
      const id = this.currentId
      if (id === null) {
        return
      }
      const flight = flightOf(this)
      let run!: Promise<void>
      run = (async () => {
        this.waiting = true
        this.failure = null
        this.streamingText = ''
        this.streamingStatus = null
        this.streamingBlocks = []
        this.streamingMemoryNotice = null
        let reply: AiMessageVO | null = null
        let failed = false
        try {
          const answerReply = await fetchAnswer(id)
          reply = answerReply
          if (this.currentId === id) {
            this.messages = [...this.messages, answerReply]
          }
          this.touch(id, answerReply.createdAt)
        } catch (err) {
          failed = true
          if (this.currentId === id) {
            this.failure = errText(err)
          }
        } finally {
          const suppressed = flight.suppressAutoDequeue
          flight.suppressAutoDequeue = false
          if (flight.fetchPromise === run) {
            flight.fetchPromise = null
          }
          this.waiting = false
          this.compacting = false
          this.streamingText = ''
          this.streamingStatus = null
          this.streamingBlocks = []
          this.streamingMemoryNotice = null
          if (!suppressed && !failed && !reply?.interrupted && this.currentId === id) {
            const list = this.queuesByChat.get(id)
            if (list?.length) {
              const [head, ...rest] = list
              if (rest.length) this.queuesByChat.set(id, rest)
              else this.queuesByChat.delete(id)
              void this.sendItem(head)
            }
          }
        }
      })()
      flight.fetchPromise = run
      return run
    },
    // 对话有了新消息：更新时间并排到置顶的后面第一个
    touch(id: number, at: string): void {
      const list = this.conversations.map((c) => (c.id === id ? { ...c, updatedAt: at } : c))
      this.conversations = list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
    },
    // 重命名
    async rename(id: number, title: string): Promise<void> {
      const name = title.trim()
      const old = this.conversations.find((c) => c.id === id)
      if (!name || !old || name === old.title) {
        return
      }
      try {
        const saved = await renameConversation(id, name)
        this.conversations = this.conversations.map((c) => (c.id === id ? { ...c, title: saved.title } : c))
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 置顶 / 取消置顶
    async togglePin(id: number): Promise<void> {
      const c = this.conversations.find((x) => x.id === id)
      if (!c) {
        return
      }
      try {
        await pinConversation(id, !c.pinned)
        await this.loadConversations()
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 删除（提示条上可以撤销）；删的是当前对话就回到新对话
    async remove(id: number): Promise<void> {
      const c = this.conversations.find((x) => x.id === id)
      if (!c) {
        return
      }
      try {
        await removeConversation(id)
      } catch (err) {
        useToastStore().show(errText(err), 'error')
        return
      }
      this.conversations = this.conversations.filter((x) => x.id !== id)
      if (this.currentId === id) {
        await this.newChat()
      }
      this.draftsByChat.delete(id)
      this.queuesByChat.delete(id)
      useToastStore().show(`已删除对话「${c.title}」`, 'ok', async () => {
        try {
          await undoRemoveConversation(id)
          await this.loadConversations()
        } catch (err) {
          useToastStore().show(errText(err), 'error')
        }
      })
    },
    // 赞、踩；再点一次取消
    async vote(messageId: number, kind: 'UP' | 'DOWN'): Promise<void> {
      const m = this.messages.find((x) => x.id === messageId)
      if (!m) {
        return
      }
      const next = m.vote === kind ? null : kind
      const prev = m.vote
      m.vote = next
      try {
        await voteMessage(messageId, next)
      } catch (err) {
        m.vote = prev
        useToastStore().show(errText(err), 'error')
      }
    }
  }
})
