import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import { TAGS_PER_IMAGE, type ImageTagVO } from '@shared/api'
import { useGalleryStore } from '@/stores/gallery'
import { useTagsStore } from '@/stores/tags'

// 一张图的标签：列出已有的（可移除），下面一行加标签——选分类、输入、按名字和别名给出候选（照原型）
export default defineComponent({
  name: 'TagEditor',
  props: {
    tags: { type: Array as PropType<ImageTagVO[]>, required: true },
    // 换了一张图时清掉输入
    imageId: { type: Number, required: true }
  },
  setup(props) {
    const gallery = useGalleryStore()
    const tagsStore = useTagsStore()
    const draft = ref('')
    const kindOpen = ref(false)
    const pickedCategory = ref<number | undefined>(undefined)
    const busy = ref(false)
    const addRef = ref<HTMLElement | null>(null)

    watch(
      () => props.imageId,
      () => {
        draft.value = ''
        kindOpen.value = false
      }
    )

    const full = computed(() => props.tags.length >= TAGS_PER_IMAGE)
    // 输入的正好是已有标签（名字或别名）：沿用它的分类，不能在这里改
    const exact = computed(() => tagsStore.findExact(draft.value))
    const shownCategoryId = computed(() => exact.value?.categoryId ?? pickedCategory.value ?? tagsStore.defaultCategoryId ?? 0)
    const suggestions = computed(() =>
      full.value
        ? []
        : tagsStore.suggest(
            draft.value,
            props.tags.map((t) => t.id)
          )
    )

    const colorOf = (id: number) => tagsStore.colorOf(id)
    const categoryName = (id: number): string => tagsStore.categoryById(id)?.name ?? ''

    const onInput = (e: Event): void => {
      draft.value = (e.target as HTMLInputElement).value
    }
    const toggleKind = (): void => {
      if (!exact.value) {
        kindOpen.value = !kindOpen.value
      }
    }
    const pickKind = (id: number): void => {
      pickedCategory.value = id
      kindOpen.value = false
    }

    // 加一个标签：已有的按名字加；新标签放进选中的分类
    const add = async (name: string): Promise<void> => {
      const text = name.trim()
      if (!text || full.value || busy.value) {
        return
      }
      if (props.tags.some((t) => t.name.toLowerCase() === text.toLowerCase())) {
        draft.value = ''
        return
      }
      busy.value = true
      const ok = await gallery.addTag(text, tagsStore.findExact(text) ? undefined : shownCategoryId.value)
      busy.value = false
      if (ok) {
        draft.value = ''
      }
    }
    // 回车添加；中文输入法选字时的回车不算
    const onEnter = (e: KeyboardEvent): void => {
      if (!e.isComposing && e.keyCode !== 229) {
        void add(draft.value)
      }
    }
    const pick = (name: string): void => {
      void add(name)
    }
    const onRemove = async (tagId: number): Promise<void> => {
      busy.value = true
      await gallery.removeTag(tagId)
      busy.value = false
    }

    // 点外面收起分类下拉
    const onDocDown = (e: MouseEvent): void => {
      if (kindOpen.value && addRef.value && !addRef.value.contains(e.target as Node)) {
        kindOpen.value = false
      }
    }
    document.addEventListener('mousedown', onDocDown)
    onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown))

    return {
      tagsStore,
      draft,
      kindOpen,
      busy,
      addRef,
      full,
      exact,
      shownCategoryId,
      suggestions,
      max: TAGS_PER_IMAGE,
      colorOf,
      categoryName,
      onInput,
      toggleKind,
      pickKind,
      onEnter,
      pick,
      onRemove
    }
  }
})
