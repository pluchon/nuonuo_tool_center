import { computed, defineComponent } from 'vue'
import NonoArt from '@/components/nono/NonoArt.vue'
import StatusBanner from '@/components/gallery/StatusBanner.vue'
import { useLibraryStore } from '@/stores/library'
import { usePickerStore } from '@/stores/picker'
import { useViewStore } from '@/stores/view'

// 主区：第一次打开、读取失败、状态横幅和空状态（图片网格在浏览阶段接入）
export default defineComponent({
  name: 'GalleryView',
  components: { NonoArt, StatusBanner },
  setup() {
    const library = useLibraryStore()
    const picker = usePickerStore()
    const viewStore = useViewStore()

    // 当前视图里有多少张图：决定显示空状态还是图片
    const viewCount = computed(() => {
      const ov = library.overview
      if (!ov) {
        return 0
      }
      const dir = viewStore.dir
      switch (viewStore.view) {
        case 'all':
          return ov.counts.tagged
        case 'untagged':
          return ov.counts.untagged
        case 'recent':
          return ov.counts.recent
        case 'r18':
          return ov.counts.r18
        default:
          if (dir?.kind === 'source') {
            return library.sourceById(dir.id)?.count ?? 0
          }
          return ov.categories.find((c) => dir?.kind === 'category' && c.name === dir.name)?.count ?? 0
      }
    })

    return { library, picker, viewCount }
  }
})
