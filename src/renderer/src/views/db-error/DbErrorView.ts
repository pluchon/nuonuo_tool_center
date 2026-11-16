import { computed, defineComponent } from 'vue'
import NonoArt from '@/components/nono/NonoArt.vue'
import { useBootStore } from '@/stores/boot'

// 图库数据打不开：整窗只有诺诺占位、一行标题直说发生了什么、“重试”按钮
export default defineComponent({
  name: 'DbErrorView',
  components: { NonoArt },
  setup() {
    const boot = useBootStore()
    const title = computed(() =>
      boot.db === 'LOCKED' ? '图库数据被占用，暂时打不开' : '图库数据损坏，暂时打不开'
    )
    const onRetry = (): void => {
      void boot.retry()
    }
    return { boot, title, onRetry }
  }
})
