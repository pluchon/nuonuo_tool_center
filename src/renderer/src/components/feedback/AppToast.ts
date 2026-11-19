import { computed, defineComponent } from 'vue'
import { useToastStore } from '@/stores/toast'

// 顶部提示条：从窗口顶部弹入；可撤销的操作带“撤销”，失败时红色图标 + “知道了”
export default defineComponent({
  name: 'AppToast',
  setup() {
    const toast = useToastStore()
    const isError = computed(() => toast.kind === 'error')
    return { toast, isError }
  }
})
