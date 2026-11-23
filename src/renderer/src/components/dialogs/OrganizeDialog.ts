import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import NonoArt from '@/components/nono/NonoArt.vue'
import { useLibraryStore } from '@/stores/library'
import { useOrganizeStore } from '@/stores/organize'
import { ICON } from '@/theme/icons'

// 方案里每个目录收的三类词
const KINDS = [
  { key: 'characters', label: '角色' },
  { key: 'works', label: '作品' },
  { key: 'tags', label: '标签' }
] as const

// 开始前的三行说明（每行一句）
const LINES = [
  { icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', text: '先看图，再出类目录方案给你批' },
  { icon: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z', text: '结果进“AI 建议”，采用才复制，原图不动' },
  { icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', text: 'R-18 图不看、不分' }
]

// 一排数字前的小图标：图片、芯片、硬币
const STAT_ICON = {
  look: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
  token: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  money: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 8l3 4 3-4M8.5 13h7M12 12v5'
}

// 每种弹窗的标题、右上角 × 的含义（不放说明文字）
const HEADS = {
  confirm: { title: '一键整理', close: '暂时不整理' },
  plan: { title: '类目录方案', close: '稍后再看' },
  stop: { title: '停止一键整理？', close: '继续整理' }
} as const

// 一键整理的弹窗（设计 6.10）：开始前确认、批方案、进行中要不要停；右上角 × 是“先不”，打开时聚焦在它上面，Esc 也是
export default defineComponent({
  name: 'OrganizeDialog',
  components: { NonoArt },
  setup() {
    const org = useOrganizeStore()
    const library = useLibraryStore()
    const closeRef = ref<HTMLButtonElement | null>(null)

    watch(
      () => org.dialog,
      async (d) => {
        if (d) {
          await nextTick()
          closeRef.value?.focus()
        }
      }
    )
    const onKey = (e: KeyboardEvent): void => {
      if (org.dialog && e.key === 'Escape') {
        e.stopPropagation()
        org.close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

    // 改过名字后按现在的名字判断是不是新建
    const existing = computed(() => new Set([
      ...(library.overview?.categories ?? []).map((c) => c.name.toLowerCase()),
      ...(org.plan ?? []).filter((f) => !f.isNew).map((f) => f.name.toLowerCase())
    ]))
    const isNew = (name: string): boolean => !existing.value.has(name.toLowerCase())
    const est = computed(() => org.estimate)
    const tokenText = computed(() => {
      const t = est.value?.tokens ?? 0
      return t >= 10_000 ? `${(t / 10_000).toFixed(t >= 1_000_000 ? 0 : 1)} 万` : t.toLocaleString('zh-CN')
    })
    const head = computed(() => HEADS[org.dialog ?? 'confirm'])
    // 估算返回前保留三个数值的位置，避免弹窗跳动。
    const stats = computed(() => {
      const e = est.value
      return [
        { key: 'look', label: '待看', value: e ? (e.toLook + e.ratingLeft).toLocaleString('zh-CN') : null, icon: STAT_ICON.look },
        { key: 'token', label: 'token', value: e ? tokenText.value : null, icon: STAT_ICON.token },
        { key: 'money', label: '花费', value: e ? `¥${e.yuan.toFixed(2)}` : null, icon: STAT_ICON.money }
      ]
    })

    return {
      org,
      closeRef,
      est,
      tokenText,
      head,
      stats,
      isNew,
      kinds: KINDS,
      lines: LINES,
      starPath: ICON.spark,
      folderPath: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
    }
  }
})
