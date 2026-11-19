import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue'
import { FILTER_MAX, type DirCountVO, type DirKeyDTO, type MoreFilterDTO } from '@shared/api'
import type { SortKey } from '@shared/settings'
import { fetchUntaggedDirs } from '@/api/edit'
import { useFoldersStore } from '@/stores/folders'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { useTagsStore } from '@/stores/tags'
import { useViewStore } from '@/stores/view'
import { ICON } from '@/theme/icons'

// 排序选项（照原型 sortDefs）
const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'new', label: '最近导入' },
  { key: 'old', label: '最早导入' },
  { key: 'taken', label: '拍摄时间' },
  { key: 'size', label: '文件大小' },
  { key: 'name', label: '名称' }
]

type MoreKey = keyof MoreFilterDTO

// 更多筛选的分组和选项（照原型 MF）
const MORE_SECTIONS: Array<{ key: MoreKey; title: string; opts: Array<{ value: string; label: string }> }> = [
  { key: 'fmt', title: '格式', opts: ['JPG', 'PNG', 'GIF', 'WEBP', 'RAW', 'HEIC'].map((v) => ({ value: v, label: v })) },
  {
    key: 'ori',
    title: '方向',
    opts: [
      { value: 'h', label: '横图' },
      { value: 'v', label: '竖图' },
      { value: 'sq', label: '方图' }
    ]
  },
  {
    key: 'res',
    title: '尺寸',
    opts: [
      { value: '4k', label: '4K 及以上' },
      { value: 'fhd', label: '1080p 及以上' },
      { value: 'small', label: '1000px 以下' }
    ]
  },
  {
    key: 'size',
    title: '文件大小',
    opts: [
      { value: 's', label: '1 MB 以下' },
      { value: 'm', label: '1–10 MB' },
      { value: 'l', label: '10 MB 以上' }
    ]
  },
  {
    key: 'date',
    title: '拍摄时间',
    opts: [
      { value: '30d', label: '近 30 天' },
      { value: 'y', label: '今年' },
      { value: 'ly', label: '去年' },
      { value: 'none', label: '没有拍摄时间' }
    ]
  }
]

// 搜索输入停顿多久再查（毫秒）
const SEARCH_DELAY = 200

// 目录下拉里的一项
export interface DirOption {
  key: string
  dir: DirKeyDTO
  label: string
  count: string
  icon: string
  ink: string
}

// 一个已选条件的标签
export interface FilterChip {
  key: string
  kind: string
  label: string
  bg: string
  ink: string
  remove: () => void
}

// 目录的比较键
function dirKey(d: DirKeyDTO): string {
  return d.kind === 'source' ? `s:${d.id}` : `c:${d.name}`
}

// 筛选栏：搜索、标签、目录、更多、排序、只看 R-18、仅当前目录；下面一行是已选条件和图片数（照原型）
export default defineComponent({
  name: 'FilterBar',
  setup() {
    const gallery = useGalleryStore()
    const viewStore = useViewStore()
    const library = useLibraryStore()
    const folders = useFoldersStore()
    const tagsStore = useTagsStore()
    const draft = ref(gallery.q)
    const open = ref<'tag' | 'dir' | 'more' | 'sort' | null>(null)
    const untaggedDirs = ref<DirCountVO[]>([])
    let timer: ReturnType<typeof setTimeout> | null = null

    watch(
      () => gallery.q,
      (q) => {
        draft.value = q
      }
    )

    const isCategory = computed(() => viewStore.view === 'dir' && viewStore.dir?.kind === 'category')
    const placeholder = computed(() => (gallery.nameOnly ? '按图片名找' : '来找找你想要的标签与图片名'))
    const sortLabel = computed(() => SORT_OPTIONS.find((o) => o.key === gallery.sort)?.label ?? '')
    const showR18 = computed(() => !gallery.nameOnly && viewStore.view !== 'r18')
    const showTags = computed(() => !gallery.nameOnly)
    const showMore = computed(() => viewStore.view === 'all' || viewStore.view === 'r18' || isCategory.value)
    // 目录下拉：全部图片、R-18 图列顶层目录；“还没打标签”列含未打标签图的目录，少于两个不显示
    const showDirs = computed(() =>
      viewStore.view === 'untagged' ? untaggedDirs.value.length >= 2 : viewStore.view === 'all' || viewStore.view === 'r18'
    )
    const showHereOnly = computed(() => {
      const dir = viewStore.dir
      if (viewStore.view !== 'dir' || !dir) {
        return false
      }
      return folders.hasChildren(dir)
    })

    // “还没打标签”的目录项：进入这个视图、列表刷新后重新读
    const loadUntaggedDirs = async (): Promise<void> => {
      if (viewStore.view !== 'untagged') {
        untaggedDirs.value = []
        return
      }
      try {
        untaggedDirs.value = await fetchUntaggedDirs()
      } catch {
        untaggedDirs.value = []
      }
    }
    watch(() => [viewStore.view, gallery.items] as const, () => void loadUntaggedDirs(), { immediate: true })

    // 标签下拉：用在图上的标签，按图片数从多到少
    const tagOptions = computed(() => tagsStore.tags.filter((t) => t.count > 0).sort((a, b) => b.count - a.count))
    const colorOf = (id: number) => tagsStore.colorOf(id)
    const categoryName = (id: number): string => tagsStore.categoryById(id)?.name ?? ''

    const dirOptions = computed<DirOption[]>(() => {
      if (viewStore.view === 'untagged') {
        return untaggedDirs.value.map((d) => ({
          key: dirKey(d.dir),
          dir: d.dir,
          label: d.label,
          count: `${d.count} 张`,
          icon: d.dir.kind === 'source' ? ICON.folder : ICON.heartFolder,
          ink: d.dir.kind === 'source' ? 'var(--c-i-3F8F7B)' : 'var(--c-i-C25B85)'
        }))
      }
      const ov = library.overview
      if (!ov) {
        return []
      }
      return [
        ...ov.sources.map((s) => ({
          key: `s:${s.id}`,
          dir: { kind: 'source' as const, id: s.id },
          label: s.name,
          count: `源 · ${s.count}`,
          icon: s.hasChildren ? ICON.folders : ICON.folder,
          ink: 'var(--c-i-3F8F7B)'
        })),
        ...ov.categories.map((c) => ({
          key: `c:${c.name}`,
          dir: { kind: 'category' as const, name: c.name },
          label: c.name,
          count: `类 · ${c.count}`,
          icon: c.hasChildren ? ICON.heartFolders : ICON.heartFolder,
          ink: 'var(--c-i-C25B85)'
        }))
      ]
    })

    const reload = (): void => {
      void gallery.load()
    }
    const toggle = (key: 'tag' | 'dir' | 'more' | 'sort'): void => {
      open.value = open.value === key ? null : key
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
      open.value = null
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
    // 标签、目录最多各选 5 个；满了只能取消
    const toggleTag = (id: number): void => {
      if (gallery.tagIds.includes(id)) {
        gallery.tagIds = gallery.tagIds.filter((x) => x !== id)
      } else if (gallery.tagIds.length < FILTER_MAX) {
        gallery.tagIds = [...gallery.tagIds, id]
      } else {
        return
      }
      reload()
    }
    const dirOn = (key: string): boolean => gallery.dirs.some((d) => dirKey(d) === key)
    const toggleDir = (opt: DirOption): void => {
      if (dirOn(opt.key)) {
        gallery.dirs = gallery.dirs.filter((d) => dirKey(d) !== opt.key)
      } else if (gallery.dirs.length < FILTER_MAX) {
        gallery.dirs = [...gallery.dirs, opt.dir]
      } else {
        return
      }
      reload()
    }
    const moreOn = (key: MoreKey, value: string): boolean => ((gallery.more[key] as string[] | undefined) ?? []).includes(value)
    const toggleMore = (key: MoreKey, value: string): void => {
      const cur = (gallery.more[key] as string[] | undefined) ?? []
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
      gallery.more = { ...gallery.more, [key]: next }
      reload()
    }
    const clearMore = (): void => {
      gallery.more = {}
      reload()
    }
    const moreCount = computed(() => Object.values(gallery.more).reduce((n, v) => n + ((v as string[] | undefined)?.length ?? 0), 0))

    const chips = computed<FilterChip[]>(() => {
      const list: FilterChip[] = []
      for (const id of gallery.tagIds) {
        const t = tagsStore.tags.find((x) => x.id === id)
        const c = colorOf(t?.categoryId ?? 0)
        list.push({ key: `t${id}`, kind: categoryName(t?.categoryId ?? 0), label: t?.name ?? '', bg: c.line, ink: c.ink, remove: () => toggleTag(id) })
      }
      for (const d of gallery.dirs) {
        const opt = dirOptions.value.find((o) => o.key === dirKey(d))
        list.push({
          key: dirKey(d),
          kind: '目录',
          label: opt?.label ?? (d.kind === 'category' ? d.name : ''),
          bg: 'var(--a-line)',
          ink: 'var(--a-ink)',
          remove: () => {
            gallery.dirs = gallery.dirs.filter((x) => dirKey(x) !== dirKey(d))
            reload()
          }
        })
      }
      for (const sec of MORE_SECTIONS) {
        for (const v of (gallery.more[sec.key] as string[] | undefined) ?? []) {
          const label = sec.opts.find((o) => o.value === v)?.label ?? v
          list.push({ key: `m${sec.key}${v}`, kind: sec.title, label, bg: 'var(--c-b-BBD5EE)', ink: 'var(--c-i-1F5A8A)', remove: () => toggleMore(sec.key, v) })
        }
      }
      if (gallery.onlyR18) {
        list.push({ key: 'r18', kind: '只看', label: 'R-18', bg: 'var(--c-b-F2C6D4)', ink: 'var(--c-i-A23D62)', remove: toggleR18 })
      }
      if (gallery.sort !== 'new') {
        list.push({ key: 'sort', kind: '排序', label: sortLabel.value, bg: 'var(--c-b-BFE3D6)', ink: 'var(--c-i-1F6B57)', remove: () => pickSort('new') })
      }
      return list
    })

    // 点下拉框外面时收起
    const onDocDown = (e: MouseEvent): void => {
      if (open.value && !(e.target as HTMLElement).closest(`[data-dd="${open.value}"]`)) {
        open.value = null
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
      open,
      placeholder,
      sortLabel,
      sortOptions: SORT_OPTIONS,
      moreSections: MORE_SECTIONS,
      max: FILTER_MAX,
      showR18,
      showTags,
      showDirs,
      showMore,
      showHereOnly,
      tagOptions,
      dirOptions,
      moreCount,
      chips,
      colorOf,
      categoryName,
      toggle,
      onInput,
      clearSearch,
      pickSort,
      toggleR18,
      toggleHere,
      toggleTag,
      dirOn,
      toggleDir,
      moreOn,
      toggleMore,
      clearMore
    }
  }
})
