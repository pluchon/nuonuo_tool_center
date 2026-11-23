import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue'
import type { TagVO } from '@shared/api'
import ConfirmDialog from '@/components/dialogs/ConfirmDialog.vue'
import KindDialog from '@/components/tags/KindDialog.vue'
import TagPanel from '@/components/tags/TagPanel.vue'
import RightPanel from '@/components/layout/RightPanel.vue'
import { useSettingsStore } from '@/stores/settings'
import { useTagsStore } from '@/stores/tags'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import { tagColor } from '@/theme/tagPalette'

// 调色板里给分类换色时可选的 8 个经典色（粉、紫、绿、橙、蓝、青、珊瑚、灰蓝）在 12 色里的序号
const SWATCHES = [0, 1, 2, 3, 4, 5, 7, 9]

// 标签管理页（照原型 isTags）：左边搜索栏 + 按分类分组的标签卡片，右边标签操作面板
export default defineComponent({
  name: 'TagsView',
  components: { TagPanel, KindDialog, ConfirmDialog, RightPanel },
  setup() {
    const tagsStore = useTagsStore()
    const settings = useSettingsStore()
    const viewStore = useViewStore()
    const toast = useToastStore()

    const query = ref('')
    const selectedId = ref<number | null>(null)
    const creating = ref(false)
    const palFor = ref<number | null>(null)
    const kindOpen = ref(false)
    const deleting = ref<TagVO | null>(null)
    const deleteBusy = ref(false)

    const isDark = computed(() => settings.theme === 'dark')
    const byCount = (a: TagVO, b: TagVO): number => b.count - a.count || a.id - b.id

    // 选中的标签不在了（删掉、并入别的标签）或还没选过时，选图片数最多的那个
    watch(
      () => tagsStore.tags,
      (tags) => {
        if (selectedId.value === null || !tags.some((t) => t.id === selectedId.value)) {
          selectedId.value = [...tags].sort(byCount)[0]?.id ?? null
        }
      },
      { immediate: true }
    )
    const selected = computed(() => tagsStore.tags.find((t) => t.id === selectedId.value) ?? null)

    // 按名字或别名搜（不区分大小写）
    const matches = (t: TagVO, q: string): boolean => !q || t.name.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q))

    // 每个分类一张卡片：标签按图片数排；选中的标签深底白字
    const groups = computed(() => {
      const q = query.value.trim().toLowerCase()
      return tagsStore.categories.map((c) => {
        const color = tagColor(c.colorIndex)
        const list = tagsStore.tags.filter((t) => t.categoryId === c.id && matches(t, q)).sort(byCount)
        return {
          id: c.id,
          name: c.name,
          color,
          total: tagsStore.tags.filter((t) => t.categoryId === c.id).length,
          swatches: SWATCHES.map((n) => ({ n, dot: tagColor(n).dot, mine: c.colorIndex === n })),
          tags: list.map((t) => {
            const on = !creating.value && t.id === selectedId.value
            const strong = isDark.value ? color.dot : color.ink
            return {
              tag: t,
              on,
              style: {
                '--shape-bg': on ? strong : color.line,
                color: on ? '#FFFFFF' : color.ink
              },
              countBg: on ? 'rgba(255, 255, 255, 0.25)' : isDark.value ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.75)'
            }
          })
        }
      })
    })

    // 新建时默认放进的分类：第一个分类
    const defaultCategoryId = computed(() => tagsStore.categories[0]?.id ?? 0)

    const pick = (id: number): void => {
      viewStore.setPanelOpen(true)
      selectedId.value = id
      creating.value = false
    }
    const startCreate = (): void => {
      viewStore.setPanelOpen(true)
      creating.value = true
    }
    const onSaved = (id: number): void => {
      selectedId.value = id
      creating.value = false
    }

    const togglePal = (id: number): void => {
      palFor.value = palFor.value === id ? null : id
    }
    const pickColor = async (categoryId: number, n: number): Promise<void> => {
      palFor.value = null
      await tagsStore.setCategoryColor(categoryId, n)
    }

    const askDelete = (id: number): void => {
      deleting.value = tagsStore.tags.find((t) => t.id === id) ?? null
    }
    const confirmDelete = async (): Promise<void> => {
      const tag = deleting.value
      if (!tag || deleteBusy.value) {
        return
      }
      deleteBusy.value = true
      const ok = await tagsStore.deleteTag(tag.id)
      deleteBusy.value = false
      deleting.value = null
      if (ok) {
        toast.show(`已删除标签「${tag.name}」`)
      }
    }

    const viewImages = (id: number): void => {
      viewStore.showTagImages(id)
    }

    // 点到调色板外面时收起；Esc 收起
    const onDocDown = (e: MouseEvent): void => {
      if (palFor.value !== null && !(e.target as HTMLElement).closest('[data-pal]')) {
        palFor.value = null
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        palFor.value = null
      }
    }
    document.addEventListener('mousedown', onDocDown)
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('keydown', onKey)
    })

    return {
      viewStore,
      tagsStore,
      query,
      creating,
      selected,
      groups,
      defaultCategoryId,
      palFor,
      kindOpen,
      deleting,
      deleteBusy,
      pick,
      startCreate,
      onSaved,
      togglePal,
      pickColor,
      askDelete,
      confirmDelete,
      viewImages
    }
  }
})
