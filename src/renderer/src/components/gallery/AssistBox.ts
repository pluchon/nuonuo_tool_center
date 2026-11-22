import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue'
import { fetchAssistPrompt, importAssist } from '@/api/look'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { useLookStore } from '@/stores/look'
import { useToastStore } from '@/stores/toast'
import { ICON } from '@/theme/icons'
import { countAssistFields, parseAssistJson } from '@shared/assistJson'

// 详情面板 R-18 下面的“其他 AI 辅助整理”（照原型 assist）：整个过程不调云端，R-18 图也能用
export default defineComponent({
  name: 'AssistBox',
  props: {
    imageId: { type: Number, required: true },
    r18: { type: Boolean, default: false }
  },
  setup(props) {
    const look = useLookStore()
    const gallery = useGalleryStore()
    const library = useLibraryStore()
    const toast = useToastStore()
    const text = ref('')
    const copied = ref(false)
    const busy = ref(false)
    let copiedTimer: ReturnType<typeof setTimeout> | null = null

    // 换了一张图就清空
    watch(
      () => props.imageId,
      () => {
        text.value = ''
        copied.value = false
      }
    )

    const parsed = computed(() => parseAssistJson(text.value))
    const count = computed(() => (parsed.value ? countAssistFields(parsed.value) : 0))
    const bad = computed(() => text.value.trim() !== '' && count.value === 0)

    // 复制整理好的完整提示词
    const copyPrompt = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(await fetchAssistPrompt(props.imageId))
        copied.value = true
        toast.show('已复制提示词，连同这张图发给你的 AI')
        if (copiedTimer) {
          clearTimeout(copiedTimer)
        }
        copiedTimer = setTimeout(() => (copied.value = false), 2000)
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    onBeforeUnmount(() => {
      if (copiedTimer) {
        clearTimeout(copiedTimer)
      }
    })

    // 交给诺诺整理：本地对齐叫法、去重、归类，进“AI 建议”
    const handOff = async (): Promise<void> => {
      if (!parsed.value) {
        return
      }
      busy.value = true
      try {
        const n = await importAssist(props.imageId, parsed.value)
        text.value = ''
        toast.show(`诺诺整理好了 ${n} 条，放进了「AI 建议」`)
        await Promise.all([library.load(), gallery.load()])
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        busy.value = false
      }
    }

    return {
      look,
      text,
      copied,
      busy,
      count,
      bad,
      copyPrompt,
      handOff,
      starPath: ICON.spark,
      copyPath: 'M8 8h11v13H8zM5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1',
      checkPath: 'M5 12.5l4.5 4.5L19 7.5'
    }
  }
})
