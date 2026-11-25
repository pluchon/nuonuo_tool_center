import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAssistantStore } from '@/stores/assistant'
import { useSettingsStore } from '@/stores/settings'
import { hasInteractiveModal } from '@/components/dialogs/modal'
import { unwrap } from '@/api/request'

interface Entry { key: string; reply: number; digest: string; used: boolean; at: number }
interface History { entries: Entry[]; ignored: number; quietUntil: number }
const STORAGE = 'ltm.assistantPredictions.v2'
const DAY = 86_400_000

function history(): History {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as History | null
    if (saved && Array.isArray(saved.entries) && Number.isFinite(saved.quietUntil) && Number.isFinite(saved.ignored)) {
      saved.entries = saved.entries.filter((entry) => entry && entry.digest && entry.at > Date.now() - DAY).slice(-96)
      return saved
    }
  } catch { /* 存储不可用时，本次会话仍可使用预测。 */ }
  return { entries: [], ignored: 0, quietUntil: 0 }
}

function fingerprint(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''))
}

export function usePrediction(blocked: () => boolean, revision: () => number) {
  const store = useAssistantStore()
  const settings = useSettingsStore()
  const shown = ref<{ entry: Entry; text: string } | null>(null)
  const composing = ref(false)
  const visible = ref(false)
  const saved = history()
  const persist = (): void => {
    saved.entries = saved.entries.slice(-96)
    try { localStorage.setItem(STORAGE, JSON.stringify(saved)) } catch { /* 忽略不可写的浏览器存储。 */ }
  }
  const syncVisibility = (): void => { visible.value = !document.hidden }
  onMounted(() => {
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
  })
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', syncVisibility))

  const context = computed(() => {
    const reply = store.messages.at(-1)
    const question = store.messages.at(-2)
    if (!visible.value || settings.dialogOpen || blocked() || store.ready === null || store.waiting || store.failure || store.loadingMessages ||
        store.changingTurn || store.recalledMessageId !== null || store.draft || store.attachments.length ||
        !store.currentId || reply?.role !== 'assistant' || question?.role !== 'user') return null
    const scope = store.scope ? { ...store.scope } : null
    const sameScope = (scope?.name ?? null) === (question.scope?.kind === 'category' ? question.scope.name : null) &&
      store.includeR18 === (question.includeR18 === true)
    if (!sameScope || store.includeR18) return null
    const references = store.references.slice(0, 3).map(r => ({ ...r, name: '' }))
    const canSuggest = references.length > 0 || reply.images.length > 0 || Boolean(reply.canPredict) ||
      (!reply.hasStoredResults && (reply.text.trim().length >= 16 || Boolean(reply.how)))
    if (!canSuggest) return null
    const dto = { conversationId: store.currentId, replyId: reply.id, scope, includeR18: false, references, selectionCount: store.references.length }
    const key = JSON.stringify([dto, question.id, reply.createdAt, revision()])
    return { key, dto }
  })

  function respond(accept: boolean): void {
    const hint = shown.value
    if (!hint) return
    const entry = hint.entry
    shown.value = null
    entry.used = true
    saved.ignored = accept ? 0 : Math.min(4, saved.ignored + 1)
    const delay = [0, 0, 15 * 60_000, 3_600_000, DAY][saved.ignored] ?? 0
    saved.quietUntil = Date.now() + delay
    persist()
    if (accept) store.draft = hint.text
  }

  // 在草稿更新使上下文失效前记录忽略，切换会话、范围或打开弹窗都不影响采纳习惯。
  watch(() => store.draft, (text) => { if (text) respond(false) }, { flush: 'sync' })
  watch(() => context.value?.key, (_, __, onCleanup) => {
    shown.value = null
    const ctx = context.value
    if (!ctx || saved.quietUntil > Date.now()) return
    let stale = false
    const active = (): boolean => !stale && !document.hidden && !composing.value && !hasInteractiveModal() && context.value?.key === ctx.key
    const timer = setTimeout(async () => {
      try {
        if (!active()) return
        const key = await fingerprint(ctx.key)
        if (!active()) return
        let entry = saved.entries.find((e) => e.key === key && e.at > Date.now() - DAY)
        if (entry?.used) return
        const text = await unwrap(window.api.ai.predict(ctx.dto))
        if (!text || !active()) return
        const digest = await fingerprint(text)
        if (!active() || saved.entries.some(e => e.reply !== ctx.dto.replyId && e.digest === digest && e.at > Date.now() - DAY)) return
        if (!entry || entry.digest !== digest) {
          entry = { key, reply: ctx.dto.replyId, digest, used: false, at: Date.now() }
          saved.entries = saved.entries.filter(e => e.key !== key)
          saved.entries.push(entry)
          persist()
        }
        shown.value = { entry, text }
      } catch { /* 预测失败不影响用户编辑和发送。 */ }
    }, 650)
    onCleanup(() => { stale = true; clearTimeout(timer) })
  }, { immediate: true, flush: 'sync' })

  function onPredictionKey(event: KeyboardEvent): boolean {
    if (!shown.value || event.defaultPrevented || event.isComposing || composing.value || event.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || hasInteractiveModal() || !context.value) return false
    if (event.key !== 'Tab' && event.key !== 'Escape') return false
    event.preventDefault()
    respond(event.key === 'Tab')
    return true
  }
  return { prediction: computed(() => composing.value ? '' : shown.value?.text ?? ''), composing, onPredictionKey }
}
