import { defineComponent, onBeforeUnmount, onMounted } from 'vue'
import { onFileOpDone } from '@/api/files'
import { useGalleryStore } from '@/stores/gallery'
import FolderPickDialog from '@/components/dialogs/FolderPickDialog.vue'
import AppToast from '@/components/feedback/AppToast.vue'
import GalleryView from '@/views/gallery/GalleryView.vue'
import TagsView from '@/views/tags/TagsView.vue'
import { useLibraryStore } from '@/stores/library'
import { useScanStore } from '@/stores/scan'
import { useTagsStore } from '@/stores/tags'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import SideNav from './SideNav.vue'
import StatusFooter from './StatusFooter.vue'

// 主界面外壳：左侧导航卡片、主区（图库或标签管理）、底栏，以及选文件夹对话框和顶部提示条（照原型主画板）
export default defineComponent({
  name: 'AppShell',
  components: { SideNav, GalleryView, TagsView, StatusFooter, FolderPickDialog, AppToast },
  setup() {
    const library = useLibraryStore()
    const scan = useScanStore()
    const toast = useToastStore()
    const tags = useTagsStore()
    const viewStore = useViewStore()
    const gallery = useGalleryStore()
    // 删除真正执行后有删不掉的（被占用、没权限）：提示原因，刷新列表让它们回来
    const offDone = onFileOpDone((result) => {
      if (result.failed > 0) {
        toast.show(`有 ${result.failed} 张没删成功：${result.error ?? '原因不明'}`, 'error')
        void gallery.afterEdit()
      }
    })
    onBeforeUnmount(offDone)

    onMounted(() => {
      void library.load()
      tags.load().catch((err: unknown) => toast.show(`标签读不出来：${err instanceof Error ? err.message : String(err)}`, 'error'))
      scan.init().catch((err: unknown) => toast.show(`读不到扫描状态：${err instanceof Error ? err.message : String(err)}`, 'error'))
    })
    return { viewStore }
  }
})
