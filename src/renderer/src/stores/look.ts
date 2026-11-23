import { defineStore } from 'pinia'
import type { LookStateVO } from '@shared/api'
import { LOOK_KEY_HINT } from '@shared/api'
import { TOKEN_PLAN_LOCAL_HINT } from '@shared/settings'
import { cancelAllLooks, fetchLookState, lookNow, onLookState, retryLook } from '@/api/look'
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
    rows: [] as LookStateVO['rows'],
    canCancel: false,
    needsApiKey: false,
    localOnly: false,
    open: false
  }),
  getters: {
    keyHint: (s): string => s.localOnly ? TOKEN_PLAN_LOCAL_HINT : LOOK_KEY_HINT,
    busy: (s): boolean => !s.needsApiKey && s.rows.some((r) => r.state !== 'FAILED'),
    waitingForKey: (s): boolean => s.needsApiKey && s.rows.some((r) => r.state !== 'FAILED')
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
      this.rows = state.rows
      this.canCancel = state.canCancel
      this.needsApiKey = state.needsApiKey
      this.localOnly = state.localOnly === true
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
        useToastStore().show(this.needsApiKey ? this.keyHint : '已加入看图队列')
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
    }
  }
})
