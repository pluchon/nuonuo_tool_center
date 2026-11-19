import { computed, defineComponent, onBeforeUnmount, onMounted } from 'vue'
import { onFileOpDone, pathOfDropped } from '@/api/files'
import ConfirmDialog from '@/components/dialogs/ConfirmDialog.vue'
import FolderPickDialog from '@/components/dialogs/FolderPickDialog.vue'
import TransferDialog from '@/components/dialogs/TransferDialog.vue'
import AppToast from '@/components/feedback/AppToast.vue'
import ImageViewer from '@/components/gallery/ImageViewer.vue'
import GalleryView from '@/views/gallery/GalleryView.vue'
import TagsView from '@/views/tags/TagsView.vue'
import { useFoldersStore } from '@/stores/folders'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { useScanStore } from '@/stores/scan'
import { useTagsStore } from '@/stores/tags'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import FolderMenu from './FolderMenu.vue'
import SideNav from './SideNav.vue'
import StatusFooter from './StatusFooter.vue'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 主界面外壳：左侧导航卡片、主区（图库或标签管理）、底栏，以及各种对话框、目录右键菜单和顶部提示条（照原型主画板）
export default defineComponent({
  name: 'AppShell',
  components: { SideNav, GalleryView, TagsView, StatusFooter, FolderPickDialog, TransferDialog, FolderMenu, ConfirmDialog, ImageViewer, AppToast },
  setup() {
    const library = useLibraryStore()
    const scan = useScanStore()
    const toast = useToastStore()
    const tags = useTagsStore()
    const viewStore = useViewStore()
    const gallery = useGalleryStore()
    const folders = useFoldersStore()

    // 删除真正执行后有删不掉的（被占用、没权限）：提示原因，刷新列表让它们回来
    const offDone = onFileOpDone((result) => {
      if (result.failed > 0) {
        toast.show(`有 ${result.failed} 张没删成功：${result.error ?? '原因不明'}`, 'error')
        void gallery.afterEdit()
      }
    })
    onBeforeUnmount(offDone)

    // 删除类目录 / 从图库移除源目录的确认标题（照原型）
    const dangerTitle = computed(() => {
      const d = folders.danger
      if (!d) {
        return ''
      }
      return d.ref.kind === 'source' ? `从图库移除「${d.label}」？` : `删除类目录「${d.label}」？`
    })
    // 拖到源目录上松手后的确认标题
    const dropTitle = computed(() => {
      const d = gallery.dropAsk
      return d ? `${d.move ? '移动' : '复制'} ${d.ids.length} 张到「${d.label}」？` : ''
    })

    // 把文件夹拖进窗口：当作导入源目录（拖的是网格里的图时不管）
    const isFolderDrag = (e: DragEvent): boolean =>
      gallery.dragging.length === 0 && !!e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')
    const onWindowDragOver = (e: DragEvent): void => {
      if (isFolderDrag(e)) {
        e.preventDefault()
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy'
        }
      }
    }
    const onWindowDrop = async (e: DragEvent): Promise<void> => {
      if (!isFolderDrag(e) || !e.dataTransfer) {
        return
      }
      e.preventDefault()
      const item = [...e.dataTransfer.items].find((i) => i.kind === 'file' && i.webkitGetAsEntry()?.isDirectory)
      const file = item?.getAsFile()
      if (!file) {
        toast.show('拖进来的不是文件夹', 'error')
        return
      }
      try {
        const created = await library.importSource(pathOfDropped(file))
        viewStore.showDir({ kind: 'source', id: created.id })
      } catch (err) {
        toast.show(errText(err), 'error')
      }
    }

    onMounted(() => {
      void library.load()
      tags.load().catch((err: unknown) => toast.show(`标签读不出来：${errText(err)}`, 'error'))
      scan.init().catch((err: unknown) => toast.show(`读不到扫描状态：${errText(err)}`, 'error'))
    })
    return { viewStore, folders, gallery, dangerTitle, dropTitle, onWindowDragOver, onWindowDrop }
  }
})
