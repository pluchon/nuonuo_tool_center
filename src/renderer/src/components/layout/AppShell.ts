import { defineComponent, onMounted } from 'vue'
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
    onMounted(() => {
      void library.load()
      tags.load().catch((err: unknown) => toast.show(`标签读不出来：${err instanceof Error ? err.message : String(err)}`, 'error'))
      scan.init().catch((err: unknown) => toast.show(`读不到扫描状态：${err instanceof Error ? err.message : String(err)}`, 'error'))
    })
    return { viewStore }
  }
})
