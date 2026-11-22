import { defineComponent, ref, watch } from 'vue'
import type { AiSuggestionVO } from '@shared/api'
import { acceptAllSuggestions, decideSuggestion, fetchSuggestions } from '@/api/look'
import { useGalleryStore } from '@/stores/gallery'
import { useToastStore } from '@/stores/toast'
import { ICON } from '@/theme/icons'

// 每种建议的图标和名字（照原型 SUGG_ICON / SUGG_KIND）
const ICONS: Record<AiSuggestionVO['kind'], string> = {
  name: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  tag: ICON.tag,
  who: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  work: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5',
  src: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  dir: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
}
const KINDS: Record<AiSuggestionVO['kind'], string> = { name: '名字', tag: '标签', who: '角色', work: '作品', src: '出处', dir: '放进' }

// “AI 建议”视图里详情面板上的建议卡：采用的名字写进图片名字，标签、角色、作品当标签加上，出处记下来；
// 一张图的建议处理完就离开这个视图（列表刷新后自动选中下一张）
export default defineComponent({
  name: 'AiSuggestCard',
  props: {
    imageId: { type: Number, required: true }
  },
  setup(props) {
    const gallery = useGalleryStore()
    const toast = useToastStore()
    const items = ref<AiSuggestionVO[]>([])
    const busy = ref(false)

    const load = async (): Promise<void> => {
      try {
        items.value = await fetchSuggestions(props.imageId)
      } catch (err) {
        items.value = []
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    watch(() => props.imageId, () => void load(), { immediate: true })

    // 处理完一项：剩下的显示出来；改了名字、标签要刷新详情和列表（处理完的图会离开列表）
    const after = async (left: AiSuggestionVO[]): Promise<void> => {
      items.value = left
      await gallery.afterEdit()
    }
    const run = async (fn: () => Promise<AiSuggestionVO[]>): Promise<void> => {
      busy.value = true
      try {
        await after(await fn())
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
        await load()
      } finally {
        busy.value = false
      }
    }
    const decide = (key: string, accept: boolean): Promise<void> => run(() => decideSuggestion(props.imageId, key, accept))
    const acceptAll = (): Promise<void> => run(() => acceptAllSuggestions(props.imageId))

    return { items, busy, decide, acceptAll, icons: ICONS, kinds: KINDS, starPath: ICON.spark }
  }
})
