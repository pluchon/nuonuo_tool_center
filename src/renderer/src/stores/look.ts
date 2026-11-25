import { defineStore } from 'pinia'
import { LOOK_KEY_HINT, type LookStateVO, type SuggestionRefreshStatusVO } from '@shared/api'
import {
  cancelAllLooks,
  fetchLookState,
  fetchSuggestionRefreshStatus,
  lookNow,
  onLookState,
  refreshSuggestion,
  retryLook
} from '@/api/look'
import { useToastStore } from './toast'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let unsubscribe: (() => void) | null = null

// 底栏“诺诺在看图”：队列状态（主进程推过来）和卡片开关
export const useLookStore = defineStore('look', {
  state: () => ({
    count: 0,
    activity: 'idle' as LookStateVO['activity'],
    rows: [] as LookStateVO['rows'],
    canCancel: false,
    needsApiKey: false,
    reorganizing: false,
    activeImageIds: [] as number[],
    open: false
  }),
  getters: {
    busy: (s): boolean => !s.needsApiKey && s.activity === 'working',
    waitingForKey: (s): boolean => s.needsApiKey && s.activity !== 'idle',
    isActive: (s): ((imageId: number) => boolean) => {
      const activeSet = new Set(s.activeImageIds)
      return (imageId: number): boolean => activeSet.has(imageId)
    }
  },
  actions: {
    // 读一次状态并订阅之后的变化
    async init(): Promise<void> {
      unsubscribe?.()
      unsubscribe = onLookState((state) => this.apply(state))
      try {
        this.apply(await fetchLookState())
      } catch {
        // 读不到就先显示 0，主进程推过来再更新
      }
    },
    apply(state: LookStateVO): void {
      this.count = state.count
      this.activity = state.activity
      this.rows = state.rows
      this.canCancel = state.canCancel
      this.needsApiKey = state.needsApiKey
      this.reorganizing = state.reorganizing
      this.activeImageIds = state.activeImageIds
    },
    toggle(): void {
      this.open = !this.open
    },
    close(): void {
      this.open = false
    },
    async retry(jobId: number): Promise<void> {
      try {
        await retryLook(jobId)
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 让一张图现在就看
    async now(imageId: number): Promise<void> {
      try {
        await lookNow(imageId)
        useToastStore().show(this.needsApiKey ? LOOK_KEY_HINT : '已加入看图队列')
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    async cancelAll(): Promise<void> {
      try {
        const n = await cancelAllLooks()
        if (n > 0) {
          useToastStore().show(`已取消 ${n} 张图片的看图任务`)
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    async refreshSuggestion(imageId: number): Promise<SuggestionRefreshStatusVO | null> {
      try {
        const status = await refreshSuggestion(imageId)
        if (!this.activeImageIds.includes(imageId)) {
          this.activeImageIds = [...this.activeImageIds, imageId]
        }
        return status
      } catch (err) {
        useToastStore().show(errText(err), 'error')
        return null
      }
    },
    async fetchRefreshStatus(imageId: number): Promise<SuggestionRefreshStatusVO | null> {
      try {
        return await fetchSuggestionRefreshStatus(imageId)
      } catch {
        return null
      }
    }
  }
})
