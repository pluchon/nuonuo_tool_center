import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import { MERGE_MAX, TAG_NAME_MAX, type TagVO } from '@shared/api'
import { useTagsStore } from '@/stores/tags'
import { useToastStore } from '@/stores/toast'

// 字数（一个中文、一个表情都算一个字）
const charCount = (s: string): number => Array.from(s).length
// 规整：去首尾空格，多个空格合成一个
const tidy = (s: string): string => s.trim().replace(/\s+/g, ' ')

// 合并方向：并入其他标签 / 合并进来
type MergeMode = 'out' | 'in'
const MODES: Array<{ key: MergeMode; label: string }> = [
  { key: 'out', label: '并入其他标签' },
  { key: 'in', label: '合并进来' }
]

// 标签管理右侧面板（照原型 tagPanel + merge）：标签名、分类、别名、合并，底部一个保存按钮
// 所有修改先放在面板里，点“保存修改 / 保存并合并 / 创建标签”时一次提交
export default defineComponent({
  name: 'TagPanel',
  props: {
    // 正在编辑的标签；新建时为空
    tag: { type: Object as PropType<TagVO | null>, default: null },
    creating: { type: Boolean, required: true },
    // 新建时默认放进的分类
    defaultCategoryId: { type: Number, default: 0 }
  },
  emits: ['saved', 'cancel', 'delete', 'view-images'],
  setup(props, { emit }) {
    const tagsStore = useTagsStore()
    const toast = useToastStore()

    const name = ref('')
    const categoryId = ref(0)
    const aliases = ref<string[]>([])
    const aliasDraft = ref('')
    const kindOpen = ref(false)
    const mergeMode = ref<MergeMode>('out')
    const mergeOut = ref<number | null>(null)
    const mergeIn = ref<number[]>([])
    const mergeOpen = ref(false)
    const busy = ref(false)
    const kindRef = ref<HTMLElement | null>(null)
    const mergeRef = ref<HTMLElement | null>(null)

    // 换了标签、进入或退出新建、或标签本身被改过（保存后）时，面板回到它的当前值
    const reset = (): void => {
      name.value = props.creating ? '' : (props.tag?.name ?? '')
      categoryId.value = props.creating ? props.defaultCategoryId : (props.tag?.categoryId ?? 0)
      aliases.value = props.creating ? [] : [...(props.tag?.aliases ?? [])]
      aliasDraft.value = ''
      kindOpen.value = false
      mergeOut.value = null
      mergeIn.value = []
      mergeOpen.value = false
    }
    watch(
      () => [props.creating, props.tag?.id, props.tag?.name, props.tag?.categoryId, props.tag?.aliases.join('\n')],
      reset,
      { immediate: true }
    )

    const color = computed(() => tagsStore.colorOf(categoryId.value))
    const categoryName = computed(() => tagsStore.categoryById(categoryId.value)?.name ?? '')
    const nameLen = computed(() => charCount(name.value))
    const nameOver = computed(() => charCount(name.value.trim()) > TAG_NAME_MAX)

    // 合并的候选：除自己以外的标签，按图片数
    const others = computed(() =>
      tagsStore.tags.filter((t) => t.id !== props.tag?.id).sort((a, b) => b.count - a.count)
    )
    const tagById = (id: number): TagVO | undefined => tagsStore.tags.find((t) => t.id === id)
    const chosen = computed(() =>
      (mergeMode.value === 'out' ? (mergeOut.value === null ? [] : [mergeOut.value]) : mergeIn.value)
        .map(tagById)
        .filter((t): t is TagVO => !!t)
    )
    const mergeOptions = computed(() =>
      others.value.map((t) => {
        const on = mergeMode.value === 'out' ? mergeOut.value === t.id : mergeIn.value.includes(t.id)
        return { tag: t, on, color: tagsStore.colorOf(t.categoryId), blocked: mergeMode.value === 'in' && !on && mergeIn.value.length >= MERGE_MAX }
      })
    )
    const mergePreview = computed(() => {
      if (chosen.value.length === 0 || !props.tag) {
        return null
      }
      if (mergeMode.value === 'out') {
        return { text: `${props.tag.name} → ${chosen.value[0].name}`, count: props.tag.count }
      }
      return {
        text: `${chosen.value.map((t) => t.name).join('、')} → ${tidy(name.value) || props.tag.name}`,
        count: chosen.value.reduce((n, t) => n + t.count, 0)
      }
    })

    // 有没有改动：名字、分类、别名，或选了要合并的标签
    const dirty = computed(() => {
      const t = props.tag
      if (!t) {
        return false
      }
      return (
        tidy(name.value) !== t.name ||
        categoryId.value !== t.categoryId ||
        aliases.value.join('\n') !== t.aliases.join('\n') ||
        chosen.value.length > 0
      )
    })
    // 新建时名字不能和已有标签重名（别名冲突交给保存时提示）
    const nameTaken = computed(() => {
      const lower = tidy(name.value).toLowerCase()
      return !!lower && tagsStore.tags.some((t) => t.id !== props.tag?.id && t.name.toLowerCase() === lower)
    })
    const canSave = computed(() => {
      if (busy.value || nameOver.value || !tidy(name.value)) {
        return false
      }
      return props.creating ? !nameTaken.value : dirty.value
    })
    const saveLabel = computed(() => (props.creating ? '创建标签' : chosen.value.length > 0 ? '保存并合并' : '保存修改'))

    const onNameInput = (e: Event): void => {
      name.value = (e.target as HTMLInputElement).value
    }
    const toggleKind = (): void => {
      kindOpen.value = !kindOpen.value
      mergeOpen.value = false
    }
    const pickKind = (id: number): void => {
      categoryId.value = id
      kindOpen.value = false
    }

    // 别名：回车添加，去掉和标签名或已有别名重复的（不区分大小写）
    const onAliasInput = (e: Event): void => {
      aliasDraft.value = (e.target as HTMLInputElement).value
    }
    const onAliasKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.isComposing) {
        return
      }
      const word = tidy(aliasDraft.value)
      if (!word) {
        return
      }
      if (charCount(word) > TAG_NAME_MAX) {
        toast.show(`别名最多 ${TAG_NAME_MAX} 个字`, 'error')
        return
      }
      const lower = word.toLowerCase()
      if (lower !== tidy(name.value).toLowerCase() && !aliases.value.some((a) => a.toLowerCase() === lower)) {
        aliases.value = [...aliases.value, word]
      }
      aliasDraft.value = ''
    }
    const removeAlias = (a: string): void => {
      aliases.value = aliases.value.filter((x) => x !== a)
    }

    const pickMode = (mode: MergeMode): void => {
      mergeMode.value = mode
      mergeOpen.value = false
    }
    const toggleMerge = (): void => {
      mergeOpen.value = !mergeOpen.value
      kindOpen.value = false
    }
    const pickMerge = (id: number): void => {
      if (mergeMode.value === 'out') {
        mergeOut.value = mergeOut.value === id ? null : id
        mergeOpen.value = false
      } else if (mergeIn.value.includes(id)) {
        mergeIn.value = mergeIn.value.filter((x) => x !== id)
      } else if (mergeIn.value.length < MERGE_MAX) {
        mergeIn.value = [...mergeIn.value, id]
      }
    }

    const save = async (): Promise<void> => {
      if (!canSave.value) {
        return
      }
      busy.value = true
      let id: number | null
      if (props.creating) {
        id = await tagsStore.createTag({ name: tidy(name.value), categoryId: categoryId.value, aliases: aliases.value })
      } else {
        const out = mergeMode.value === 'out'
        id = await tagsStore.saveTag({
          id: props.tag!.id,
          name: tidy(name.value),
          categoryId: categoryId.value,
          aliases: aliases.value,
          mergeInto: out ? mergeOut.value : null,
          mergeFrom: out ? [] : mergeIn.value
        })
      }
      busy.value = false
      if (id !== null) {
        emit('saved', id)
        reset()
      }
    }

    // 点到下拉外面时收起
    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (kindOpen.value && !kindRef.value?.contains(target)) {
        kindOpen.value = false
      }
      if (mergeOpen.value && !mergeRef.value?.contains(target)) {
        mergeOpen.value = false
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        kindOpen.value = false
        mergeOpen.value = false
      }
    }
    document.addEventListener('mousedown', onDocDown)
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('keydown', onKey)
    })

    return {
      tagsStore,
      max: TAG_NAME_MAX,
      mergeMax: MERGE_MAX,
      modes: MODES,
      name,
      categoryId,
      aliases,
      aliasDraft,
      kindOpen,
      mergeMode,
      mergeOpen,
      kindRef,
      mergeRef,
      color,
      categoryName,
      nameLen,
      nameOver,
      chosen,
      mergeOptions,
      mergePreview,
      canSave,
      saveLabel,
      busy,
      onNameInput,
      toggleKind,
      pickKind,
      onAliasInput,
      onAliasKey,
      removeAlias,
      pickMode,
      toggleMerge,
      pickMerge,
      save
    }
  }
})
