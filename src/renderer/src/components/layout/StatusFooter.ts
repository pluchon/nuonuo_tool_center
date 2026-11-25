import { computed, defineComponent, onBeforeUnmount, ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { useScanStore } from '@/stores/scan'
import { useToastStore } from '@/stores/toast'
import LookCapsule from './LookCapsule.vue'
import OrganizeButton from './OrganizeButton.vue'
import RatingProgress from './RatingProgress.vue'
import ReorganizeButton from './ReorganizeButton.vue'

// 相对时间每 30 秒刷新一次
const TICK_MS = 30_000

// 上次扫描完成时间写成“刚刚 / N 分钟前 / N 小时前 / N 天前”
export function scanAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) {
    return '刚刚扫描完成'
  }
  if (minutes < 60) {
    return `${minutes} 分钟前扫描完成`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} 小时前扫描完成`
  }
  return `${Math.floor(hours / 24)} 天前扫描完成`
}

// 底栏：左边“诺诺在看图”，右边图片总数、扫描状态、重新扫描（照原型 footer）
export default defineComponent({
  name: 'StatusFooter',
  components: { LookCapsule, ReorganizeButton, OrganizeButton, RatingProgress },
  setup() {
    const library = useLibraryStore()
    const scan = useScanStore()
    const toast = useToastStore()
    const now = ref(Date.now())
    const timer = setInterval(() => {
      now.value = Date.now()
    }, TICK_MS)
    onBeforeUnmount(() => clearInterval(timer))

    const countText = computed(() => `${(library.overview?.counts.total ?? 0).toLocaleString('zh-CN')} 张`)
    // 优先显示当前扫描状态，空闲时显示最近完成时间。
    const scanText = computed(() => {
      if (scan.running) {
        return '正在扫描…'
      }
      if (scan.last?.stopped) {
        return '扫描已停止'
      }
      const at = library.overview?.lastScanAt
      return at ? scanAgo(at, now.value) : '还没有扫描过'
    })

    const onRescan = (): void => {
      scan.start(null).catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
    }

    return { countText, scanText, scanning: computed(() => scan.running), onRescan }
  }
})
