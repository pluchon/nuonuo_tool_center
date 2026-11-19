import { computed, defineComponent, h, markRaw, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { FolderNodeVO } from '@shared/api'
import { fetchFolders } from '@/api/library'
import { useLibraryStore } from '@/stores/library'
import { usePickerStore } from '@/stores/picker'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

// el-tree 懒加载节点里我们用到的部分
export interface TreeNode {
  level: number
  data: FolderNodeVO | FolderNodeVO[]
  expanded: boolean
  expand: () => void
  collapse: () => void
}

// 不能选的原因写在行尾
const LOCK_NOTE: Record<NonNullable<FolderNodeVO['lock']>, string> = {
  LIBRARY: '图库文件夹',
  IMPORTED: '已导入',
  HOLDS: '含已导入'
}

// 打开时默认展开的盘：有 D 盘就展开 D 盘，否则展开第一个盘
const PREFERRED_DRIVE = 'D:\\'

// 展开箭头：照原型的细线 “›”，展开时由 el-tree 转 90°
const ChevronIcon = markRaw(defineComponent({
  name: 'ChevronIcon',
  render: () =>
    h(
      'svg',
      {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true'
      },
      [h('path', { d: 'M9 6l6 6-6 6' })]
    )
}))

// 导入源目录 / 重新选择位置：按磁盘逐层展开选一个文件夹（el-tree 懒加载，照原型的导入对话框）
export default defineComponent({
  name: 'FolderPickDialog',
  setup() {
    const picker = usePickerStore()
    const library = useLibraryStore()
    const toast = useToastStore()
    const viewStore = useViewStore()
    const picked = ref<string | null>(null)
    const busy = ref(false)
    const treeRef = ref<{ getNode: (key: string) => TreeNode | null } | null>(null)

    const treeProps = {
      label: 'label',
      isLeaf: (data: FolderNodeVO) => !data.hasChildren
    }

    const title = computed(() => (picker.relocate ? `重新选择「${picker.relocate.name}」的位置` : '导入源目录'))
    const ready = computed(() => picked.value !== null)
    const pickedName = computed(() => (picked.value ? picked.value.replace(/\\$/, '').split('\\').pop() : ''))
    const confirmLabel = computed(() => (ready.value ? `导入「${pickedName.value}」` : '先选一个文件夹'))

    // 每次打开都从头选
    watch(
      () => picker.open,
      (open) => {
        if (open) {
          picked.value = null
          busy.value = false
        }
      }
    )

    // 懒加载一层：根节点列盘符，其余列子文件夹；读失败时这一层显示为空并提示
    const loadNode = (node: TreeNode, resolve: (children: FolderNodeVO[]) => void): void => {
      const parent = node.level === 0 ? null : (node.data as FolderNodeVO).path
      fetchFolders(parent)
        .then((list) => {
          resolve(list)
          if (parent === null) {
            const first = list.find((d) => d.path === PREFERRED_DRIVE) ?? list[0]
            if (first?.hasChildren) {
              void nextTick(() => treeRef.value?.getNode(first.path)?.expand())
            }
          }
        })
        .catch((err: unknown) => {
          toast.show(err instanceof Error ? err.message : String(err), 'error')
          resolve([])
        })
    }

    const noteOf = (data: FolderNodeVO): string => (data.lock ? LOCK_NOTE[data.lock] : '')

    // 点一行：盘符只负责展开收起；不能选的不响应；其余选中
    const onNodeClick = (data: FolderNodeVO, node: TreeNode): void => {
      if (data.isDrive) {
        if (node.expanded) {
          node.collapse()
        } else {
          node.expand()
        }
        return
      }
      if (data.lock === null) {
        picked.value = data.path
      }
    }

    const onClose = (): void => {
      if (!busy.value) {
        picker.close()
      }
    }

    // 确认：导入后切到这个源目录；重新选择位置后提示改到了哪里。失败时提示原因，对话框保持打开
    const onConfirm = async (): Promise<void> => {
      if (!picked.value || busy.value) {
        return
      }
      busy.value = true
      const path = picked.value
      try {
        if (picker.relocate) {
          const { name } = picker.relocate
          await library.relocateSource(picker.relocate.id, path)
          toast.show(`「${name}」已改到 ${path}`)
        } else {
          const created = await library.importSource(path)
          viewStore.showDir({ kind: 'source', id: created.id })
        }
        busy.value = false
        picker.close()
      } catch (err) {
        busy.value = false
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    }

    // Esc 关闭
    const onKey = (e: KeyboardEvent): void => {
      if (picker.open && e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    return { ChevronIcon, picker, picked, busy, ready, title, confirmLabel, treeProps, treeRef, loadNode, noteOf, onNodeClick, onClose, onConfirm }
  }
})
