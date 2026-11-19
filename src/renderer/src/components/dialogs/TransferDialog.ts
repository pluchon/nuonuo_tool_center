import { computed, defineComponent, onBeforeUnmount } from 'vue'
import type { TransferFolderVO } from '@shared/api'
import { fetchFolders } from '@/api/library'
import { useLibraryStore } from '@/stores/library'
import { useToastStore } from '@/stores/toast'
import { useTransferStore } from '@/stores/transfer'
import { ChevronIcon } from './chevronIcon'

// 树上的一个文件夹：顶层源目录带 id（取数量），找不到的源目录不能选
export interface FolderData extends TransferFolderVO {
  sourceId?: number
  category?: boolean
  offline?: boolean
  top?: boolean
}

// el-tree 懒加载节点里用到的部分
export interface LazyNode {
  level: number
  data: FolderData
}

// 一组（源目录 / 类目录）
export interface Group {
  key: 'source' | 'category'
  title: string
  dot: string
  roots: FolderData[]
}

// 路径的所有上层（含自己），用来打开时自动展开到当前位置
function ancestors(path: string): string[] {
  const parts = path.split('\\')
  return parts.map((_, i) => parts.slice(0, i + 1).join('\\')).filter((p) => p.includes('\\'))
}

// 移动到… / 复制到…（照原型 dlg）：源目录、类目录两组可展开的文件夹树；移动单选，复制多选
export default defineComponent({
  name: 'TransferDialog',
  setup() {
    const transfer = useTransferStore()
    const library = useLibraryStore()
    const toast = useToastStore()

    const isCopy = computed(() => transfer.mode === 'copy')
    const title = computed(() => (isCopy.value ? '复制到…' : '移动到…'))
    const ready = computed(() => transfer.picked.length > 0)
    const confirmLabel = computed(() => {
      if (isCopy.value) {
        return ready.value ? `复制到 ${transfer.picked.length} 个目录` : '先选要复制到的目录'
      }
      return ready.value ? `移动到「${transfer.picked[0].split('\\').pop()}」` : '先选一个目录'
    })

    const groups = computed<Group[]>(() => {
      const r = transfer.roots
      if (!r) {
        return []
      }
      return [
        {
          key: 'source',
          title: '源目录',
          dot: 'var(--c-b-3F8F7B)',
          roots: r.sources.map((s) => ({ path: s.path, label: s.label, hasChildren: s.hasChildren, sourceId: s.id, offline: s.offline, top: true }))
        },
        {
          key: 'category',
          title: '类目录',
          dot: 'var(--c-b-C25B85)',
          roots: r.categories.map((c) => ({ ...c, category: true, top: true }))
        }
      ]
    })
    const expandedKeys = computed(() => [...new Set(transfer.expandTo.flatMap(ancestors))])

    const treeProps = {
      label: 'label',
      isLeaf: (data: FolderData) => !data.hasChildren
    }

    // 懒加载：第一层是这一组的顶层目录，往下按磁盘列子文件夹
    const loaderOf =
      (group: Group) =>
      (node: LazyNode, resolve: (children: FolderData[]) => void): void => {
        if (node.level === 0) {
          resolve(group.roots)
          return
        }
        fetchFolders(node.data.path)
          .then((list) => resolve(list.map((f) => ({ path: f.path, label: f.label, hasChildren: f.hasChildren, category: node.data.category }))))
          .catch((err: unknown) => {
            toast.show(err instanceof Error ? err.message : String(err), 'error')
            resolve([])
          })
      }

    // 行尾：不能选的原因，或顶层目录的图片数
    const noteOf = (data: FolderData): string => {
      if (data.offline) {
        return '找不到'
      }
      const lock = transfer.lockOf(data.path)
      if (lock) {
        return lock
      }
      if (!data.top) {
        return ''
      }
      const ov = library.overview
      const n = data.sourceId !== undefined ? ov?.sources.find((s) => s.id === data.sourceId)?.count : ov?.categories.find((c) => c.name === data.label)?.count
      return `${n ?? 0} 张`
    }
    const lockedOf = (data: FolderData): boolean => !!data.offline || !!transfer.lockOf(data.path)
    const onNodeClick = (data: FolderData): void => {
      if (!lockedOf(data)) {
        transfer.toggle(data.path)
      }
    }

    // Esc 关闭
    const onKey = (e: KeyboardEvent): void => {
      if (transfer.mode && e.key === 'Escape') {
        transfer.close()
      }
    }
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    return { ChevronIcon, transfer, isCopy, title, ready, confirmLabel, groups, expandedKeys, treeProps, loaderOf, noteOf, lockedOf, onNodeClick }
  }
})
