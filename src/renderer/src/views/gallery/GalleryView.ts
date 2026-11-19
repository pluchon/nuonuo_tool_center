import { computed, defineComponent, onMounted, watch } from 'vue'
import ConfirmDialog from '@/components/dialogs/ConfirmDialog.vue'
import NonoArt from '@/components/nono/NonoArt.vue'
import DetailPanel from '@/components/gallery/DetailPanel.vue'
import FilterBar from '@/components/gallery/FilterBar.vue'
import ImageGrid from '@/components/gallery/ImageGrid.vue'
import StatusBanner from '@/components/gallery/StatusBanner.vue'
import { useGalleryStore } from '@/stores/gallery'
import { useLibraryStore } from '@/stores/library'
import { usePickerStore } from '@/stores/picker'
import { useViewStore } from '@/stores/view'

// 主区：第一次打开、读取失败，以及筛选栏 + 状态横幅 + 图片网格 + 详情面板
export default defineComponent({
  name: 'GalleryView',
  components: { NonoArt, DetailPanel, FilterBar, ImageGrid, StatusBanner, ConfirmDialog },
  setup() {
    const library = useLibraryStore()
    const picker = usePickerStore()
    const viewStore = useViewStore()
    const gallery = useGalleryStore()

    // 空状态的一行字：搜索没结果 / 筛选后没有 / 本来就没有
    const emptyText = computed(() => {
      const q = gallery.q.trim()
      if (q) {
        return `没有找到「${q}」`
      }
      const moreOn = Object.values(gallery.more).some((v) => (v as unknown[] | undefined)?.length)
      if (gallery.onlyR18 || gallery.onlyHere || gallery.tagIds.length > 0 || gallery.dirs.length > 0 || moreOn) {
        return '没有符合条件的图片'
      }
      return '这里还没有图片'
    })

    // 删除确认框的标题（照原型）
    const deleteTitle = computed(() => {
      const n = gallery.deleteAsk?.length ?? 0
      return n > 1 ? `删除这 ${n} 张图？` : '删除这张图？'
    })

    // 切换视图：清掉搜索和开关，重新查
    watch(
      () => [viewStore.view, viewStore.dir] as const,
      () => {
        gallery.resetFilters()
        void gallery.load()
      }
    )

    onMounted(() => {
      gallery.resetFilters()
      void gallery.load()
    })

    return { library, picker, gallery, emptyText, deleteTitle }
  }
})
