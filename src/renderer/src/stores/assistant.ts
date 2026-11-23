import { defineStore } from 'pinia'
import type { AiAttachment, AiConversationVO, AiMessageVO, AiSearchScope } from '@shared/api'
import {
  askNono,
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
    // 在哪里找：空表示全部图库
    scope: null as AiSearchScope | null,
    includeR18: false,
    // 正在等回复
    waiting: false,
    // 最后一句没回复成功：横幅显示的原因（如“网络异常”），点“重试”再取一次回复
    failure: null as string | null,
    loadingMessages: false
  }),
  getters: {
    current(s): AiConversationVO | null {
      return s.conversations.find((c) => c.id === s.currentId) ?? null
    },
    canSend(s): boolean {
      return (s.draft.trim() !== '' || s.attachments.length > 0) && !s.waiting && !s.loadingMessages
    }
  },
  actions: {
    // 进入诺诺助手页：查一次能不能用，读对话记录；没有当前对话时换一批示例问题
    async enter(): Promise<void> {
      try {
        const status = await fetchAiStatus()
        this.ready = status.ready || status.localOnly === true
      } catch (err) {
        this.ready = false
        useToastStore().show(`诺诺状态读不出来：${errText(err)}`, 'error')
        return
      }
      if (!this.ready) {
        return
      }
      await this.loadConversations()
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
      if (this.waiting) return
      this.currentId = null
      this.messages = []
      this.failure = null
      this.draft = ''
      this.attachments = []
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
      if (this.waiting) {
        return
      }
      const version = ++messagesVersion
      if (this.currentId !== id) {
        this.messages = []
      } else {
        for (const message of this.messages) message.images = []
      }
      this.currentId = id
      this.failure = null
      this.loadingMessages = true
      try {
        const msgs = await fetchMessages(id)
        if (this.currentId === id && version === messagesVersion) {
          this.messages = msgs
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
    // 发送：先存下这句话（新对话会出现在对话记录里），再等诺诺的回复
    async send(text?: string): Promise<void> {
      const q = (text ?? this.draft).trim()
      const attachments = text === undefined ? this.attachments : []
      if ((!q && !attachments.length) || this.waiting || this.loadingMessages) {
        return
      }
      this.waiting = true
      this.failure = null
      try {
        const res = await askNono({
          conversationId: this.currentId, text: q, scope: this.scope ? { ...this.scope } : null,
          includeR18: this.includeR18, attachments: attachments.map((file) => ({ ...file }))
        })
        if (text === undefined && this.draft.trim() === q) this.draft = ''
        this.attachments = this.attachments.filter((file) => !attachments.includes(file))
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
    // 取回复；失败时显示横幅，点“重试”再取一次
    async fetchReply(): Promise<void> {
      const id = this.currentId
      if (id === null) {
        return
      }
      this.waiting = true
      this.failure = null
      try {
        const reply = await fetchAnswer(id)
        if (this.currentId === id) {
          this.messages = [...this.messages, reply]
        }
        this.touch(id, reply.createdAt)
      } catch (err) {
        if (this.currentId === id) {
          this.failure = errText(err)
        }
      } finally {
        this.waiting = false
      }
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
