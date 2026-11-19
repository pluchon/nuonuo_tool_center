import { computed, defineComponent, onBeforeUnmount } from 'vue'
import { useFoldersStore } from '@/stores/folders'

// 菜单里的一项
export interface MenuItem {
  label: string
  icon: string
  danger: boolean
  run: () => void
}

const ICON_ADD = 'M12 5v14M5 12h14'
const ICON_RENAME = 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z'
const ICON_FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
const ICON_SCAN = 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'
const ICON_TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
const ICON_REMOVE = 'M5 12h14'

// 侧栏目录的右键菜单（照原型 ctx）：贴在所点目录下方，带指向它的尖角，半透明磨砂底
// 类目录：新建子目录 / 重命名 / 打开所在文件夹 / 删除；源目录顶层：新建子文件夹 / 重新扫描 / 打开所属源目录 / 从图库移除；源目录子文件夹：新建和打开
export default defineComponent({
  name: 'FolderMenu',
  setup() {
    const folders = useFoldersStore()

    const groups = computed<{ list: MenuItem[]; danger: MenuItem[] }>(() => {
      const m = folders.menu
      if (!m) {
        return { list: [], danger: [] }
      }
      const ref = m.ref
      const item = (label: string, icon: string, run: () => void, danger = false): MenuItem => ({ label, icon, danger, run })
      if (ref.kind === 'category') {
        return {
          list: [
            item('新建子目录', ICON_ADD, () => void folders.startCreate(ref)),
            item('重命名', ICON_RENAME, () => folders.startRename(ref, m.label)),
            item('打开所在文件夹', ICON_FOLDER, () => void folders.reveal(ref))
          ],
          danger: [item('删除', ICON_TRASH, () => folders.askDanger(ref, m.label), true)]
        }
      }
      const list = [item('新建子文件夹', ICON_ADD, () => void folders.startCreate(ref))]
      if (m.top) {
        list.push(item('重新扫描', ICON_SCAN, () => void folders.rescan(ref.id)))
      }
      list.push(item('打开所属源目录', ICON_FOLDER, () => void folders.reveal(ref)))
      return { list, danger: m.top ? [item('从图库移除', ICON_REMOVE, () => folders.askDanger(ref, m.label), true)] : [] }
    })

    const onKey = (e: KeyboardEvent): void => {
      if (folders.menu && e.key === 'Escape') {
        folders.closeMenu()
      }
    }
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    return { folders, groups }
  }
})
