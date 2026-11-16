import { defineComponent, onMounted } from 'vue'
import GalleryView from '@/views/gallery/GalleryView.vue'
import { useLibraryStore } from '@/stores/library'
import SideNav from './SideNav.vue'
import StatusFooter from './StatusFooter.vue'

// 主界面外壳：左侧导航卡片、主区、底栏（照原型主画板）
export default defineComponent({
  name: 'AppShell',
  components: { SideNav, GalleryView, StatusFooter },
  setup() {
    const library = useLibraryStore()
    onMounted(() => {
      void library.load()
    })
    return {}
  }
})
