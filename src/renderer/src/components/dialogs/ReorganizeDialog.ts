import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useOrganizeStore } from '@/stores/organize'
import { ICON } from '@/theme/icons'

// 精简一行一条说明（严格单行不换行）
const LINES = [
  { icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', text: '归回源目录：清空已整理标签并退回源目录，不调大模型' },
  { icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', text: '重新 AI 整理：参考已有信息重看一遍，结果进“AI 建议”' },
  { icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', text: 'R-18 图不看、不动，本地原图文件安全保留' }
]

const STAT_ICON = {
  organized: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
  token: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  money: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 8l3 4 3-4M8.5 13h7M12 12v5'
}

// 重新整理双模式弹窗：左侧归回源目录（零模型调用），右侧参考已有信息重新 AI 整理
export default defineComponent({
  name: 'ReorganizeDialog',
  setup() {
    const org = useOrganizeStore()
    const closeRef = ref<HTMLButtonElement | null>(null)

    watch(
      () => org.reorganizeDialog,
      async (open) => {
        if (open) {
          await nextTick()
          closeRef.value?.focus()
        }
      }
    )

    const onKey = (e: KeyboardEvent): void => {
      if (org.reorganizeDialog && e.key === 'Escape') {
        e.stopPropagation()
        org.closeReorganize()
      }
    }
    window.addEventListener('keydown', onKey, true)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

    const est = computed(() => org.reorganizeEstimate)
    const tokenText = computed(() => {
      const t = est.value?.tokens ?? 0
      return t >= 10_000 ? `${(t / 10_000).toFixed(t >= 1_000_000 ? 0 : 1)} 万` : t.toLocaleString('zh-CN')
    })

    const stats = computed(() => {
      const e = est.value
      return [
        { key: 'organized', label: '已整理', value: e ? e.organizedCount.toLocaleString('zh-CN') : null, icon: STAT_ICON.organized },
        { key: 'token', label: 'token', value: e ? tokenText.value : null, icon: STAT_ICON.token },
        { key: 'money', label: '花费', value: e ? `¥${e.yuan.toFixed(2)}` : null, icon: STAT_ICON.money }
      ]
    })

    const diagnosticHint = computed(() => {
      const e = est.value
      if (!e || (e.organizedCount > 0 && e.toLook > 0)) return ''
      const parts: string[] = []
      if (e.pendingSuggestionCount) parts.push(`${e.pendingSuggestionCount.toLocaleString('zh-CN')} 张尚有未处理“AI 建议”`)
      if (e.blockedByRatingCount) parts.push(`${e.blockedByRatingCount.toLocaleString('zh-CN')} 张因边界分级限制暂不送云重看`)
      if (e.inQueueCount) parts.push(`${e.inQueueCount.toLocaleString('zh-CN')} 张已在看图队列中`)
      if (e.ratingLeft) parts.push(`${e.ratingLeft.toLocaleString('zh-CN')} 张等待本地分级`)
      return parts.join('；')
    })

    return {
      org,
      closeRef,
      est,
      stats,
      diagnosticHint,
      lines: LINES,
      starPath: ICON.spark
    }
  }
})
