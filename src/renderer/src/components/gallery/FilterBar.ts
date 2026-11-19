import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue'
import type { SortKey } from '@shared/settings'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { useViewStore } from '@/stores/view'

// 排序选项（照原型 sortDefs）
const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'new', label: '最近导入' },
  { key: 'old', label: '最早导入' },
  { key: 'taken', label: '拍摄时间' },
  { key: 'size', label: '文件大小' },
  { key: 'name', label: '名称' }
]

// 搜索输入停顿多久再查（毫秒）
const SEARCH_DELAY = 200

// 一个已选条件的标签
export interface FilterChip {
  key: string
  kind: string
  label: string
  tone: 'pink' | 'green'
  remove: () => void
}

// 筛选栏：搜索、排序、只看 R-18、仅当前目录；下面一行是已选条件和图片数（照原型）
export default defineComponent({
  name: 'FilterBar',
  setup() {
    const gallery = useGalleryStore()
    const viewStore = useViewStore()
    const library = useLibraryStore()
    const draft = ref(gallery.q)
    const sortOpen = ref(false)
    const sortRef = ref<HTMLElement | null>(null)
    let timer: ReturnType<typeof setTimeout> | null = null

    // 切换视图时搜索框跟着清空
    watch(
      () => gallery.q,
      (q) => {
        draft.value = q
      }
    )

    const placeholder = computed(() => (gallery.nameOnly ? '按图片名找' : '来找找你想要的标签与图片名'))
    const sortLabel = computed(() => SORT_OPTIONS.find((o) => o.key === gallery.sort)?.label ?? '')
    const showR18 = computed(() => !gallery.nameOnly && viewStore.view !== 'r18')
    // 当前目录有子文件夹时才有“仅当前目录”
    const showHereOnly = computed(() => {
      const dir = viewStore.dir
      if (viewStore.view !== 'dir' || !dir) {
        return false
      }
      const ov = library.overview
      return dir.kind === 'source'
        ? (ov?.sources.find((s) => s.id === dir.id)?.hasChildren ?? false)
        : (ov?.categories.find((c) => c.name === dir.name)?.hasChildren ?? false)
    })

    const reload = (): void => {
      void gallery.load()
    }

    const onInput = (e: Event): void => {
      draft.value = (e.target as HTMLInputElement).value
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        gallery.q = draft.value
        reload()
      }, SEARCH_DELAY)
    }
    const clearSearch = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      draft.value = ''
      if (gallery.q) {
        gallery.q = ''
        reload()
      }
    }
    const pickSort = (key: SortKey): void => {
      sortOpen.value = false
      if (gallery.sort !== key) {
        gallery.sort = key
        reload()
      }
    }
    const toggleR18 = (): void => {
      gallery.onlyR18 = !gallery.onlyR18
      reload()
    }
    const toggleHere = (): void => {
      gallery.onlyHere = !gallery.onlyHere
      reload()
    }

    const chips = computed<FilterChip[]>(() => {
      const list: FilterChip[] = []
      if (gallery.onlyR18) {
        list.push({ key: 'r18', kind: '只看', label: 'R-18', tone: 'pink', remove: toggleR18 })
      }
      if (gallery.sort !== 'new') {
        list.push({ key: 'sort', kind: '排序', label: sortLabel.value, tone: 'green', remove: () => pickSort('new') })
      }
      return list
    })

    // 点下拉框外面时收起
    const onDocDown = (e: MouseEvent): void => {
      if (sortOpen.value && sortRef.value && !sortRef.value.contains(e.target as Node)) {
        sortOpen.value = false
      }
    }
    document.addEventListener('mousedown', onDocDown)
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocDown)
      if (timer) {
        clearTimeout(timer)
      }
    })

    return {
      gallery,
      draft,
      placeholder,
      sortOpen,
      sortRef,
      sortLabel,
      sortOptions: SORT_OPTIONS,
      showR18,
      showHereOnly,
      chips,
      onInput,
      clearSearch,
      pickSort,
      toggleR18,
      toggleHere
    }
  }
})
