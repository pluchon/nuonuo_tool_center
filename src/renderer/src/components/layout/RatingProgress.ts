import { computed, defineComponent } from 'vue'
import { useOrganizeStore } from '@/stores/organize'

// 底栏“本地分级中…”和进度条（状态由一键整理的 store 一起订阅）
export default defineComponent({
  name: 'RatingProgress',
  setup() {
    const org = useOrganizeStore()
    const percent = computed(() => (org.rating.total > 0 ? Math.min(100, Math.round((org.rating.done / org.rating.total) * 100)) : 0))
    return { org, percent }
  }
})
