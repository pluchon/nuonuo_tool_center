import { defineComponent, onBeforeUnmount, ref, watch } from 'vue'
import { fetchAssistPrompt, importAssist } from '@/api/look'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { useToastStore } from '@/stores/toast'
import { ICON } from '@/theme/icons'

// 外部回复只在用户提交后整理，使用本次提交的图片编号。
export default defineComponent({
  name: 'AssistBox',
  props: {
    imageId: { type: Number, required: true }
  },
  setup(props) {
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
      const input = text.value.trim()
      const imageId = props.imageId
      if (!input || busy.value) {
        return
      }
      busy.value = true
      try {
        const n = await importAssist(imageId, input)
        if (props.imageId === imageId && text.value.trim() === input) text.value = ''
        toast.show(n ? `诺诺整理好了 ${n} 条，放进了「AI 建议」` : '已保存图片描述')
        await Promise.all([library.load(), gallery.load()])
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        busy.value = false
      }
    }

    return {
      text,
      copied,
      busy,
      copyPrompt,
      handOff,
      starPath: ICON.spark,
      copyPath: 'M8 8h11v13H8zM5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1',
      checkPath: 'M5 12.5l4.5 4.5L19 7.5'
    }
  }
})
