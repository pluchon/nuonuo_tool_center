import { defineComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'

// 危险操作的确认框（照原型 confirmDlg）：只有标题和两个等宽按钮，默认聚焦在安全的“先不删”上；Esc 取消
export default defineComponent({
  name: 'ConfirmDialog',
  props: {
    open: { type: Boolean, required: true },
    title: { type: String, required: true },
    okLabel: { type: String, default: '删除' },
    noLabel: { type: String, default: '先不删' },
    // 执行中：确认按钮不可再点
    busy: { type: Boolean, default: false }
  },
  emits: ['ok', 'cancel'],
  setup(props, { emit }) {
    const cancelRef = ref<HTMLButtonElement | null>(null)

    watch(
      () => props.open,
      async (open) => {
        if (open) {
          await nextTick()
          cancelRef.value?.focus()
        }
      }
    )

    const onKey = (e: KeyboardEvent): void => {
      if (props.open && e.key === 'Escape') {
        e.stopPropagation()
        emit('cancel')
      }
    }
    window.addEventListener('keydown', onKey, true)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

    return { cancelRef }
  }
})
