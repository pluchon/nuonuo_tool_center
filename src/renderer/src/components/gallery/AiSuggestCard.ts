import { defineComponent, nextTick, ref, watch } from 'vue'
import type { AiSuggestionVO } from '@shared/api'
import { fetchSuggestions } from '@/api/look'
import { useGalleryStore } from '@/stores/gallery'
import { useSuggestStore } from '@/stores/suggest'
import { useToastStore } from '@/stores/toast'
import { ICON } from '@/theme/icons'

// 每种建议的图标和名字（照原型 SUGG_ICON / SUGG_KIND）
const ICONS: Record<AiSuggestionVO['kind'], string> = {
  name: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  tag: ICON.tag,
  who: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  work: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5',
  src: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  dir: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  r18Review: ICON.lock
}
const KINDS: Record<AiSuggestionVO['kind'], string> = { name: '名字', tag: '标签', who: '角色', work: '作品', src: '出处', dir: '放进', r18Review: '分级' }

// “AI 建议”视图里详情面板上的建议卡：采用的名字写进图片名字，标签、角色、作品当标签加上，出处记下来；
// 一张图的建议处理完就离开这个视图（列表刷新后自动选中下一张）
export default defineComponent({
  name: 'AiSuggestCard',
  props: {
    imageId: { type: Number, required: true },
    isR18: Boolean
  },
  setup(props) {
    const gallery = useGalleryStore()
    const suggest = useSuggestStore()
    const toast = useToastStore()
    const items = ref<AiSuggestionVO[]>([])
    const busy = ref(false)
    const drafts = ref<Record<string, string>>({})
    const editingKey = ref<string | null>(null)
    const editingText = ref('')
    const editInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null)

    const isEditable = (kind: AiSuggestionVO['kind']): boolean => kind !== 'r18Review'

    const load = async (): Promise<void> => {
      try {
        items.value = await fetchSuggestions(props.imageId)
      } catch (err) {
        items.value = []
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    watch(
      () => props.imageId,
      () => {
        drafts.value = {}
        editingKey.value = null
        editingText.value = ''
      }
    )
    watch(items, (list) => {
      const keys = new Set(list.map((item) => item.key))
      const next: Record<string, string> = {}
      let changed = false
      for (const [k, v] of Object.entries(drafts.value)) {
        if (keys.has(k)) {
          next[k] = v
        } else {
          changed = true
        }
      }
      if (changed) {
        drafts.value = next
      }
      if (editingKey.value && !keys.has(editingKey.value)) {
        editingKey.value = null
        editingText.value = ''
      }
    })
    watch([() => props.imageId, () => props.isR18], () => void load(), { immediate: true })

    const startEdit = async (g: AiSuggestionVO): Promise<void> => {
      if (busy.value || !isEditable(g.kind)) {
        return
      }
      editingKey.value = g.key
      editingText.value = drafts.value[g.key] ?? g.value
      await nextTick()
      const el = Array.isArray(editInput.value) ? editInput.value[0] : editInput.value
      el?.focus()
      el?.select()
    }

    const commitDraft = (g: AiSuggestionVO): void => {
      if (editingKey.value !== g.key) {
        return
      }
      const trimmed = editingText.value.trim()
      const next = { ...drafts.value }
      if (!trimmed || trimmed === g.value) {
        delete next[g.key]
      } else {
        next[g.key] = trimmed
      }
      drafts.value = next
      editingKey.value = null
      editingText.value = ''
    }

    const cancelEdit = (): void => {
      editingKey.value = null
      editingText.value = ''
    }

    // 处理完一项：剩下的显示出来；改了名字、标签要刷新详情和列表（处理完的图会离开列表）
    const after = async (left: AiSuggestionVO[]): Promise<void> => {
      items.value = left
      await gallery.afterEdit()
    }
    const run = async (fn: () => Promise<AiSuggestionVO[]>, onDone?: () => void): Promise<void> => {
      busy.value = true
      try {
        const left = await fn()
        onDone?.()
        await after(left)
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
        await load()
      } finally {
        busy.value = false
      }
    }

    const decide = (key: string, accept: boolean): Promise<void> => {
      if (editingKey.value === key) {
        const active = items.value.find((item) => item.key === key)
        if (active) commitDraft(active)
      }
      const override = accept ? drafts.value[key] : undefined
      return run(
        () => suggest.decideItem(props.imageId, key, accept, override),
        () => {
          if (key in drafts.value) {
            const next = { ...drafts.value }
            delete next[key]
            drafts.value = next
          }
        }
      )
    }

    const confirmEdit = (g: AiSuggestionVO): Promise<void> => {
      commitDraft(g)
      return decide(g.key, true)
    }

    const onEditEnter = (e: KeyboardEvent, g: AiSuggestionVO): void => {
      if (e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      void confirmEdit(g)
    }

    const onEditEscape = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      cancelEdit()
    }

    const acceptAll = (): Promise<void> => {
      if (editingKey.value !== null) {
        const active = items.value.find((item) => item.key === editingKey.value)
        if (active) commitDraft(active)
      }
      const overrides = Object.keys(drafts.value).length ? { ...drafts.value } : undefined
      return run(
        () => suggest.acceptAll(props.imageId, overrides),
        () => {
          drafts.value = {}
        }
      )
    }

    return {
      items,
      busy,
      drafts,
      editingKey,
      editingText,
      editInput,
      isEditable,
      startEdit,
      commitDraft,
      cancelEdit,
      confirmEdit,
      onEditEnter,
      onEditEscape,
      decide,
      acceptAll,
      icons: ICONS,
      kinds: KINDS,
      starPath: ICON.spark
    }
  }
})
