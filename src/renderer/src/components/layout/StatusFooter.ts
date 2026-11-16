import { computed, defineComponent } from 'vue'
import { useLibraryStore } from '@/stores/library'

// 底栏：图片总数、扫描状态、重新扫描（照原型 footer）
export default defineComponent({
  name: 'StatusFooter',
  setup() {
    const library = useLibraryStore()
    const countText = computed(() => `${(library.overview?.counts.total ?? 0).toLocaleString('zh-CN')} 张`)
    // 还没有扫描记录：扫描功能接入后改为“N 分钟前扫描完成”
    const scanText = computed(() => '还没有扫描过')
    return { countText, scanText }
  }
})
