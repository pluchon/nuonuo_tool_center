import { computed, defineComponent, nextTick, watch } from 'vue'
import type { DirNodeVO, FolderRefDTO, SourceRootVO } from '@shared/api'
import { DIR_NAME_MAX } from '@shared/api'
import { charCount, folderKey, toDirRef, useFoldersStore } from '@/stores/folders'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { usePickerStore } from '@/stores/picker'
import { useScanStore } from '@/stores/scan'
import { sameDir, useViewStore, type GalleryView } from '@/stores/view'
import { ICON } from '@/theme/icons'

// 目录树的连线：一段竖线或一个圆角拐角（照原型 guidesOf）
export interface Guide {
  left: string
  top: string
  height: string
  width: string
  bottom: boolean
  radius: string
}

// 侧栏的一行：导航行，或目录树里的目录（可以展开、右键、接收拖放）
export interface NavRow {
  type: 'item'
  key: string
  label: string
  count: string
  icon: string
  // 图标颜色（CSS 值）；选中时统一换成主题深字色
  ink: string
  // 状态文字（扫描中 / 找不到）的颜色，以及找不到时变灰的名字颜色；没有状态时为空
  countInk: string
  labelInk: string
  active: boolean
  // 目录树行：箭头位占位，有子文件夹时显示箭头
  tree: boolean
  hasChildren: boolean
  expanded: boolean
  depth: number
  guides: Guide[]
  // 目录树行对应的目录（右键菜单、拖放、展开用）
  ref: FolderRefDTO | null
  top: boolean
  disabled: boolean
  go: () => void
}

// 目录树里正在输入名字的一行（新建或改名）
export interface EditRow {
  type: 'edit'
  key: string
  depth: number
  guides: Guide[]
  placeholder: string
  icon: string
  ink: string
}

// 侧栏的一张卡片：标题、圆点颜色、可选的“+”、若干行或一行虚线提示
export interface NavSection {
  title: string
  dot: string
  add: { label: string; run: () => void; disabled: boolean } | null
  rows: Array<NavRow | EditRow>
  hint: string
}

// 连线的颜色和粗细
const LINE_LEFT = 11
const LINE_STEP = 14

// 一行的连线：前面每一层还没结束的竖线，加上自己这一层的拐角（不是最后一个时拐角下面接着竖线）
function guidesOf(depth: number, cont: boolean[], isLast: boolean): Guide[] {
  const g: Guide[] = []
  for (let level = 0; level < depth - 1; level++) {
    if (cont[level]) {
      g.push({ left: `${LINE_LEFT + LINE_STEP * level}px`, top: '-2px', height: '36px', width: '0px', bottom: false, radius: '0' })
    }
  }
  if (depth > 0) {
    const x = `${LINE_LEFT + LINE_STEP * (depth - 1)}px`
    g.push({ left: x, top: '-2px', height: '18px', width: '5px', bottom: true, radius: '0 0 0 5px' })
    if (!isLast) {
      g.push({ left: x, top: '14px', height: '20px', width: '0px', bottom: false, radius: '0' })
    }
  }
  return g
}

// 侧栏：图库、源目录、类目录、整理四张玻璃卡片（照原型 navSections）；源目录和类目录是可展开的树
export default defineComponent({
  name: 'SideNav',
  setup() {
    const library = useLibraryStore()
    const viewStore = useViewStore()
    const picker = usePickerStore()
    const scan = useScanStore()
    const folders = useFoldersStore()
    const gallery = useGalleryStore()

    const num = (n: number | undefined): string => String(n ?? 0)
    // 图库页上的视图行才会高亮（在标签管理页时只高亮“标签管理”）
    const onGallery = (): boolean => viewStore.page === 'gallery'
    const viewRow = (key: Exclude<GalleryView, 'dir'>, label: string, count: number | undefined, icon: string, ink: string): NavRow => ({
      type: 'item',
      key,
      label,
      count: num(count),
      icon,
      ink,
      countInk: '',
      labelInk: '',
      active: onGallery() && viewStore.view === key,
      tree: false,
      hasChildren: false,
      expanded: false,
      depth: 0,
      guides: [],
      ref: null,
      top: false,
      disabled: false,
      go: () => viewStore.show(key)
    })

    // 源目录顶层行的状态：正在扫描（绿字“扫描中”）优先，其次找不到（橙字“找不到”、名字变灰）
    const sourceState = (s: SourceRootVO): Pick<NavRow, 'count' | 'ink' | 'countInk' | 'labelInk'> => {
      if (scan.isScanning(s.id)) {
        return { count: '扫描中', ink: 'var(--c-i-3F8F7B)', countInk: 'var(--c-i-3F8F7B)', labelInk: '' }
      }
      if (s.offline) {
        return { count: '找不到', ink: 'var(--c-i-B8732E)', countInk: 'var(--c-i-B8732E)', labelInk: 'var(--c-i-8A7F99)' }
      }
      return { count: num(s.count), ink: 'var(--c-i-3F8F7B)', countInk: '', labelInk: '' }
    }

    // 输入行（新建时在父目录下面，改名时替换那一行）
    const editRow = (key: string, depth: number, guides: Guide[], kind: 'source' | 'category'): EditRow => ({
      type: 'edit',
      key,
      depth,
      guides,
      placeholder: kind === 'source' ? '新建文件夹' : depth ? '未命名的子目录' : '未命名的类目录',
      icon: kind === 'source' ? ICON.folder : ICON.heartFolder,
      ink: kind === 'source' ? 'var(--c-b-3F8F7B)' : 'var(--c-b-D86F95)'
    })

    // 把一棵树铺成行：每个目录一行，展开的接着铺它的子目录；新建 / 改名时插入输入行
    const treeRows = (
      tops: Array<{ ref: FolderRefDTO; label: string; hasChildren: boolean; state: Pick<NavRow, 'count' | 'ink' | 'countInk' | 'labelInk'> }>,
      kind: 'source' | 'category'
    ): Array<NavRow | EditRow> => {
      const out: Array<NavRow | EditRow> = []
      const icons = kind === 'source' ? [ICON.folder, ICON.folders] : [ICON.heartFolder, ICON.heartFolders]
      const walk = (
        ref: FolderRefDTO,
        label: string,
        hasChildren: boolean,
        state: Pick<NavRow, 'count' | 'ink' | 'countInk' | 'labelInk'>,
        depth: number,
        cont: boolean[],
        isLast: boolean
      ): void => {
        const key = folderKey(ref)
        const expanded = folders.isOpen(ref)
        const guides = guidesOf(depth, cont, isLast)
        const edit = folders.edit
        if (edit?.mode === 'rename' && folderKey(edit.ref) === key) {
          out.push(editRow(`edit:${key}`, depth, guides, kind))
        } else {
          out.push({
            type: 'item',
            key,
            label,
            ...state,
            icon: hasChildren ? icons[1] : icons[0],
            active: onGallery() && viewStore.view === 'dir' && sameDir(viewStore.dir, toDirRef(ref)),
            tree: true,
            hasChildren,
            expanded,
            depth,
            guides,
            ref,
            top: depth === 0,
            disabled: false,
            go: () => viewStore.showDir(toDirRef(ref))
          })
        }
        const kids: DirNodeVO[] = expanded ? folders.childrenOf(ref) : []
        const childCont = depth >= 1 ? [...cont, !isLast] : []
        const creatingHere = edit?.mode === 'create' && folderKey(edit.parent) === key
        if (creatingHere) {
          out.push(editRow(`new:${key}`, depth + 1, guidesOf(depth + 1, childCont, kids.length === 0), kind))
        }
        kids.forEach((d, i) => {
          const child: FolderRefDTO = ref.kind === 'source' ? { kind: 'source', id: ref.id, sub: d.rel } : { kind: 'category', path: d.rel }
          walk(child, d.name, d.hasChildren, { count: num(d.count), ink: state.ink, countInk: '', labelInk: '' }, depth + 1, childCont, i === kids.length - 1)
        })
      }
      // 类目录卡片标题的“+”：顶层第一行出输入框
      if (kind === 'category' && folders.edit?.mode === 'create' && folders.edit.parent.kind === 'category' && !folders.edit.parent.path) {
        out.push(editRow('new:top', 0, [], 'category'))
      }
      tops.forEach((t) => walk(t.ref, t.label, t.hasChildren, t.state, 0, [], true))
      return out
    }

    const sections = computed<NavSection[]>(() => {
      const ov = library.overview
      const c = ov?.counts
      const sources = treeRows(
        (ov?.sources ?? []).map((s) => ({
          ref: { kind: 'source', id: s.id, sub: '' } as FolderRefDTO,
          label: s.name,
          hasChildren: s.hasChildren && !s.offline,
          state: sourceState(s)
        })),
        'source'
      )
      const categories = treeRows(
        (ov?.categories ?? []).map((d) => ({
          ref: { kind: 'category', path: d.name } as FolderRefDTO,
          label: d.name,
          hasChildren: d.hasChildren,
          state: { count: num(d.count), ink: 'var(--c-i-C25B85)', countInk: '', labelInk: '' }
        })),
        'category'
      )
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
          add: { label: '导入源目录', run: () => void picker.openImport(), disabled: false },
          rows: sources,
          hint: '还没有源目录'
        },
        {
          title: '类目录',
          dot: 'var(--c-b-D86F95)',
          add: { label: '新建类目录', run: () => void folders.startCreate({ kind: 'category', path: '' }), disabled: false },
          rows: categories,
          hint: '还没有类目录'
        },
        {
          title: '整理',
          dot: 'var(--c-b-B8732E)',
          add: null,
          rows: [
            {
              ...viewRow('all', '标签管理', c?.tags, ICON.tag, 'var(--c-b-B8732E)'),
              key: 'tags',
              active: viewStore.page === 'tags',
              go: () => viewStore.showTags()
            },
            viewRow('r18', 'R-18 图', c?.r18, ICON.lock, 'var(--c-b-C2335A)')
          ],
          hint: ''
        },
        {
          title: 'AI',
          dot: '#5B8DEF',
          add: null,
          rows: [
            {
              ...viewRow('all', '诺诺助手', 0, ICON.spark, '#5B8DEF'),
              key: 'assistant',
              count: '',
              active: viewStore.page === 'assistant',
              go: () => viewStore.showAssistant()
            }
          ],
          hint: ''
        }
      ]
    })

    // 展开箭头：只展开收起，不切换视图
    const onToggle = (row: NavRow, e: MouseEvent): void => {
      e.stopPropagation()
      if (row.ref && row.hasChildren) {
        void folders.toggle(row.ref)
      }
    }

    // 右键：菜单贴在这一行下方（尖角指向这一行）
    const onContextMenu = (row: NavRow, e: MouseEvent): void => {
      if (!row.ref) {
        return
      }
      e.preventDefault()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      folders.openMenu({
        ref: row.ref,
        top: row.top,
        label: row.label,
        x: Math.min(window.innerWidth - 200, rect.left + row.depth * LINE_STEP + 6),
        y: Math.min(window.innerHeight - 220, rect.bottom + 8)
      })
    }

    // 输入行：字数、回车保存、Esc 放弃、失焦保存
    const draftLen = computed(() => charCount(folders.draft.trim()))
    const onDraft = (e: Event): void => {
      folders.draft = (e.target as HTMLInputElement).value
    }
    const onDraftKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !e.isComposing) {
        void folders.commitEdit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        folders.cancelEdit()
      }
    }
    const onDraftBlur = (): void => {
      if (folders.edit && !folders.busy) {
        void folders.commitEdit()
      }
    }
    // 出现输入行时自动聚焦并全选（改名时方便直接改）
    watch(
      () => folders.edit,
      async (edit) => {
        if (edit) {
          await nextTick()
          const input = document.querySelector<HTMLInputElement>('.side-nav__edit-input')
          input?.focus()
          input?.select()
        }
      }
    )
    // 扫描完、目录变化后刷新展开着的子目录
    watch(
      () => library.overview,
      () => void folders.refresh()
    )

    // 拖放：只有源目录（含子文件夹）接收；直接拖是复制，按住 Ctrl 是移动
    const dropOk = (row: NavRow): boolean => row.ref?.kind === 'source' && gallery.dragging.length > 0
    const onDragOver = (row: NavRow, e: DragEvent): void => {
      if (!dropOk(row)) {
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = e.ctrlKey ? 'move' : 'copy'
      }
      gallery.dropKey = row.key
    }
    const onDragLeave = (row: NavRow): void => {
      if (gallery.dropKey === row.key) {
        gallery.dropKey = null
      }
    }
    const onDrop = (row: NavRow, e: DragEvent): void => {
      if (!dropOk(row) || !row.ref) {
        return
      }
      e.preventDefault()
      gallery.askDrop(row.ref, row.label, e.ctrlKey)
    }

    return {
      sections,
      folders,
      gallery,
      maxName: DIR_NAME_MAX,
      draftLen,
      onToggle,
      onContextMenu,
      onDraft,
      onDraftKey,
      onDraftBlur,
      onDragOver,
      onDragLeave,
      onDrop
    }
  }
})
