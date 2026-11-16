import { computed, defineComponent } from 'vue'
import { ElMessage } from 'element-plus'
import { useLibraryStore } from '@/stores/library'
import { useViewStore, type GalleryView } from '@/stores/view'
import { ICON } from '@/theme/icons'

// 侧栏的一行：普通导航行，或目录树的顶层行（带展开箭头位）
export interface NavRow {
  key: string
  label: string
  count: string
  icon: string
  // 图标颜色（CSS 值）；选中时统一换成主题深字色
  ink: string
  active: boolean
  // 目录树行：箭头位占位，有子文件夹时显示箭头
  tree: boolean
  hasChildren: boolean
  // 还没接入的入口（标签管理页等）先不可点
  disabled: boolean
  go: () => void
}

// 侧栏的一张卡片：标题、圆点颜色、可选的“+”、若干行或一行虚线提示
export interface NavSection {
  title: string
  dot: string
  add: { label: string; run: () => void; disabled: boolean } | null
  rows: NavRow[]
  hint: string
}

// 侧栏：图库、源目录、类目录、整理四张玻璃卡片（照原型 navSections）
export default defineComponent({
  name: 'SideNav',
  setup() {
    const library = useLibraryStore()
    const viewStore = useViewStore()

    const num = (n: number | undefined): string => String(n ?? 0)
    const viewRow = (key: Exclude<GalleryView, 'dir'>, label: string, count: number | undefined, icon: string, ink: string): NavRow => ({
      key,
      label,
      count: num(count),
      icon,
      ink,
      active: viewStore.view === key,
      tree: false,
      hasChildren: false,
      disabled: false,
      go: () => viewStore.show(key)
    })

    const onImport = async (): Promise<void> => {
      try {
        await library.importSource()
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err))
      }
    }

    const sections = computed<NavSection[]>(() => {
      const ov = library.overview
      const c = ov?.counts
      const sources: NavRow[] = (ov?.sources ?? []).map((s) => ({
        key: `source:${s.id}`,
        label: s.name,
        count: num(s.count),
        icon: s.hasChildren ? ICON.folders : ICON.folder,
        ink: 'var(--c-i-3F8F7B)',
        active: viewStore.view === 'dir' && viewStore.dir?.kind === 'source' && viewStore.dir.id === s.id,
        tree: true,
        hasChildren: s.hasChildren,
        disabled: false,
        go: () => viewStore.showDir({ kind: 'source', id: s.id })
      }))
      const categories: NavRow[] = (ov?.categories ?? []).map((d) => ({
        key: `category:${d.name}`,
        label: d.name,
        count: num(d.count),
        icon: d.hasChildren ? ICON.heartFolders : ICON.heartFolder,
        ink: 'var(--c-i-C25B85)',
        active: viewStore.view === 'dir' && viewStore.dir?.kind === 'category' && viewStore.dir.name === d.name,
        tree: true,
        hasChildren: d.hasChildren,
        disabled: false,
        go: () => viewStore.showDir({ kind: 'category', name: d.name })
      }))
      return [
        {
          title: '图库',
          dot: 'var(--a)',
          add: null,
          rows: [
            viewRow('all', '全部图片', c?.tagged, ICON.img, 'var(--a)'),
            viewRow('untagged', '还没打标签', c?.untagged, ICON.tag, 'var(--c-b-E8964A)'),
            viewRow('recent', '最近导入', c?.recent, ICON.clock, 'var(--a)')
          ],
          hint: ''
        },
        {
          title: '源目录',
          dot: 'var(--c-b-3F8F7B)',
          add: { label: '导入源目录', run: () => void onImport(), disabled: library.importing },
          rows: sources,
          hint: '还没有源目录'
        },
        {
          title: '类目录',
          dot: 'var(--c-b-D86F95)',
          // 新建类目录在文件操作阶段接入
          add: { label: '新建类目录', run: () => undefined, disabled: true },
          rows: categories,
          hint: '还没有类目录'
        },
        {
          title: '整理',
          dot: 'var(--c-b-B8732E)',
          add: null,
          rows: [
            // 标签管理页在编辑阶段接入
            { ...viewRow('all', '标签管理', c?.tags, ICON.tag, 'var(--c-b-B8732E)'), key: 'tags', active: false, disabled: true, go: () => undefined },
            viewRow('r18', 'R-18 图', c?.r18, ICON.lock, 'var(--c-b-C2335A)')
          ],
          hint: ''
        }
      ]
    })

    return { sections }
  }
})
