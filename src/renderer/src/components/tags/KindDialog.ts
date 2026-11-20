import { computed, defineComponent, nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { CATEGORY_NAME_MAX } from '@shared/api'
import { useTagsStore } from '@/stores/tags'
import { useToastStore } from '@/stores/toast'
import { tagColor } from '@/theme/tagPalette'

// 字数（一个中文、一个表情都算一个字）
const charCount = (s: string): number => Array.from(s).length

// “标签分类”对话框（照原型 kindDlg）：分类名直接改（回车或离开输入框保存）、新增、删除没有标签在用的分类
export default defineComponent({
  name: 'KindDialog',
  props: {
    open: { type: Boolean, required: true }
  },
  emits: ['close'],
  setup(props, { emit }) {
    const tagsStore = useTagsStore()
    const toast = useToastStore()
    // 正在改的分类名（按分类 id）；没改过的不在里面
    const drafts = reactive<Record<number, string>>({})
    const busy = ref(false)
    const listRef = ref<HTMLElement | null>(null)

    const rows = computed(() =>
      tagsStore.categories.map((c) => {
        const used = tagsStore.tags.filter((t) => t.categoryId === c.id).length
        const draft = drafts[c.id] ?? c.name
        return {
          id: c.id,
          draft,
          used,
          over: charCount(draft.trim()) > CATEGORY_NAME_MAX,
          canDel: used === 0 && tagsStore.categories.length > 1,
          color: tagColor(c.colorIndex)
        }
      })
    )

    const onInput = (id: number, e: Event): void => {
      drafts[id] = (e.target as HTMLInputElement).value
    }
    // 回车：离开输入框，由 blur 保存
    const onEnter = (e: KeyboardEvent): void => {
      if (!e.isComposing) {
        ;(e.target as HTMLInputElement).blur()
      }
    }
    // Esc：放弃这一行的修改
    const onEsc = (id: number, e: KeyboardEvent): void => {
      delete drafts[id]
      ;(e.target as HTMLInputElement).blur()
    }

    // 保存改名：没变就不动；空的、超长的提示后恢复原名
    const commit = async (id: number): Promise<void> => {
      const draft = drafts[id]
      const current = tagsStore.categoryById(id)?.name
      if (draft === undefined || current === undefined) {
        return
      }
      const name = draft.trim().replace(/\s+/g, ' ')
      if (name === current) {
        delete drafts[id]
        return
      }
      if (!name) {
        toast.show('分类名不能是空的', 'error')
        delete drafts[id]
        return
      }
      if (charCount(name) > CATEGORY_NAME_MAX) {
        toast.show(`分类名最多 ${CATEGORY_NAME_MAX} 个字`, 'error')
        delete drafts[id]
        return
      }
      await tagsStore.renameCategory(id, name)
      delete drafts[id]
    }

    // 删不了时用提示说明原因（不用悬停小字）
    const remove = async (id: number, canDel: boolean): Promise<void> => {
      if (busy.value) {
        return
      }
      if (!canDel) {
        toast.show(tagsStore.categories.length > 1 ? '还有标签在用这个分类，先把它们改到别的分类' : '至少要留一个分类')
        return
      }
      busy.value = true
      await tagsStore.removeCategory(id)
      busy.value = false
    }

    // 新增分类：建好后聚焦它的名字，方便直接改
    const add = async (): Promise<void> => {
      if (busy.value) {
        return
      }
      busy.value = true
      const created = await tagsStore.createCategory()
      busy.value = false
      if (created) {
        await nextTick()
        const input = listRef.value?.querySelector<HTMLInputElement>(`input[data-id="${created.id}"]`)
        input?.focus()
        input?.select()
      }
    }

    const onKey = (e: KeyboardEvent): void => {
      if (props.open && e.key === 'Escape') {
        emit('close')
      }
    }
    window.addEventListener('keydown', onKey)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    return { rows, busy, listRef, onInput, onEnter, onEsc, commit, remove, add }
  }
})
