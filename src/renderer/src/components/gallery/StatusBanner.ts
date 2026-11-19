import { computed, defineComponent, ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { usePickerStore } from '@/stores/picker'
import { useScanStore } from '@/stores/scan'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

// 横幅内容：正在扫描（进度 + 停止扫描），或当前源目录找不到（路径 + 重新选择）
export interface BannerVM {
  kind: 'scan' | 'offline'
  icon: string
  title: string
  done: string
  total: string
  pct: number
  button: string
  run: () => void
}

const ICON_SPIN = 'M21 12a9 9 0 1 1-6.2-8.6'
const ICON_OFFLINE = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 11l4 4M14 11l-4 4'

// 图片区上方的状态横幅（照原型 banner）
export default defineComponent({
  name: 'StatusBanner',
  setup() {
    const scan = useScanStore()
    const library = useLibraryStore()
    const viewStore = useViewStore()
    const picker = usePickerStore()
    const toast = useToastStore()
    const busy = ref(false)

    const onStop = async (): Promise<void> => {
      busy.value = true
      try {
        await scan.stop()
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        busy.value = false
      }
    }

    const banner = computed<BannerVM | null>(() => {
      const p = scan.progress
      if (p) {
        const fmt = (n: number): string => n.toLocaleString('zh-CN')
        return {
          kind: 'scan',
          icon: ICON_SPIN,
          title: p.rootName ? `正在扫描「${p.rootName}」` : '正在扫描所有源目录',
          done: fmt(p.done),
          total: fmt(p.total),
          pct: p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
          button: '停止扫描',
          run: () => void onStop()
        }
      }
      const dir = viewStore.dir
      const src = dir?.kind === 'source' ? library.sourceById(dir.id) : undefined
      if (viewStore.view === 'dir' && src?.offline) {
        return {
          kind: 'offline',
          icon: ICON_OFFLINE,
          title: `找不到 ${src.path}`,
          done: '',
          total: '',
          pct: 0,
          button: '重新选择',
          run: () => picker.openRelocate(src.id, src.name)
        }
      }
      return null
    })

    return { banner, busy }
  }
})
