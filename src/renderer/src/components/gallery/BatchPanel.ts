import { computed, defineComponent, ref } from 'vue'
import { thumbUrl } from '@/api/gallery'
import { useGalleryStore } from '@/stores/gallery'
import { useSettingsStore } from '@/stores/settings'
import { useTagsStore } from '@/stores/tags'
import { useTransferStore } from '@/stores/transfer'
import { useSuggestStore } from '@/stores/suggest'
import { useViewStore } from '@/stores/view'

// 叠放的缩略图最多显示几张
const THUMBS_SHOWN = 4

// 多选时的批量面板：已选张数、叠放缩略图、共同标签（可一起移除）、一起加标签（满 5 个的跳过）、全部标 / 取消 R-18（照原型）
export default defineComponent({
  name: 'BatchPanel',
  setup() {
    const gallery = useGalleryStore()
    const suggest = useSuggestStore()
    const viewStore = useViewStore()
    const aiView = computed(() => viewStore.page === 'gallery' && viewStore.view === 'ai')
    const tagsStore = useTagsStore()
    const settings = useSettingsStore()
    const draft = ref('')
    const busy = ref(false)

    const thumbs = computed(() => {
      const byId = new Map(gallery.items.map((i) => [i.imageId, i]))
      return gallery.selected
        .slice(0, THUMBS_SHOWN)
        .map((id) => byId.get(id))
        .filter((i) => i !== undefined)
    })
    const more = computed(() => Math.max(0, gallery.selected.length - THUMBS_SHOWN))
    const blurR18 = computed(() => settings.values.r18Blur)

    const colorOf = (id: number) => tagsStore.colorOf(id)

    // 跑一个批量操作，期间按钮不可点
    const run = async (fn: () => Promise<unknown>): Promise<void> => {
      busy.value = true
      try {
        await fn()
      } finally {
        busy.value = false
      }
    }

    const onInput = (e: Event): void => {
      draft.value = (e.target as HTMLInputElement).value
    }
    // 回车给所有选中的图加标签；新标签放进默认分类（主题）
    const onEnter = (e: KeyboardEvent): void => {
      const text = draft.value.trim()
      if (e.isComposing || !text || busy.value) {
        return
      }
      void run(async () => {
        if (await gallery.addTag(text)) {
          draft.value = ''
        }
      })
    }
    const onRemove = (tagId: number): void => {
      void run(() => gallery.removeTag(tagId))
    }
    const onR18 = (value: boolean): void => {
      void run(() => gallery.setR18(value))
    }

    const transfer = useTransferStore()
    return { gallery, suggest, aiView, transfer, thumbs, more, blurR18, draft, busy, colorOf, thumbUrl, onInput, onEnter, onRemove, onR18 }
  }
})
