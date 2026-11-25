import { defineStore } from 'pinia'
import { LOOK_KEY_HINT } from '@shared/api'
import type {
  OrganizeEstimateVO,
  OrganizeFolderVO,
  OrganizeLookedVO,
  OrganizePhase,
  OrganizeStateVO,
  RatingProgressVO,
  ReorganizeEstimateVO
} from '@shared/api'
import {
  approveOrganize,
  cancelOrganize,
  dismissReorganizeEstimate,
  fetchOrganizeEstimate,
  fetchOrganizeState,
  fetchReorganizeEstimate,
  onOrganizeState,
  resetOrganizedToSource,
  startOrganize,
  startReorganizeRelook
} from '@/api/organize'
import { fetchRatingProgress, onRatingProgress } from '@/api/rating'
import { useGalleryStore } from './gallery'
import { useLookStore } from './look'
import { useScanStore } from './scan'
import { useToastStore } from './toast'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let unsubscribe: Array<() => void> = []

// 底栏的“一键整理”和“本地分级中…”：状态由主进程推过来；开始前的确认框、方案弹窗
export const useOrganizeStore = defineStore('organize', {
  state: () => ({
    phase: 'IDLE' as OrganizePhase,
    plan: null as OrganizeFolderVO[] | null,
    error: null as string | null,
    // 看图阶段看完了几张
    looked: null as OrganizeLookedVO | null,
    // 弹窗：开始前确认（带估算）、方案（可编辑的草稿）、停止确认
    dialog: null as 'confirm' | 'plan' | 'stop' | null,
    estimate: null as OrganizeEstimateVO | null,
    estimateRequest: 0,
    draft: [] as OrganizeFolderVO[],
    busy: false,
    rating: { running: false, done: 0, total: 0 } as RatingProgressVO,
    // 重新整理弹窗、估算与执行中状态
    reorganizeDialog: false,
    reorganizeEstimate: null as ReorganizeEstimateVO | null,
    reorganizeEstimateRequest: 0,
    reorganizeBusy: false
  }),
  actions: {
    // 读一次状态并订阅之后的变化
    async init(): Promise<void> {
      unsubscribe.forEach((fn) => fn())
      unsubscribe = [
        onOrganizeState((s) => this.apply(s)),
        onRatingProgress((p) => {
          this.rating = p
        })
      ]
      try {
        const s = await fetchOrganizeState()
        this.apply(s)
        this.rating = await fetchRatingProgress()
      } catch {
        // 读不到就先当空闲，主进程推过来再更新
      }
    },
    apply(s: OrganizeStateVO): void {
      const { phase, plan, error } = s
      const wasReady = this.phase === 'PLAN_READY'
      this.phase = phase
      this.plan = plan
      this.error = error
      this.looked = s.looked ?? null
      if (phase !== 'IDLE' && this.dialog === 'confirm') this.close()
      // 方案刚出来：弹出来给你批
      if (phase === 'PLAN_READY' && !wasReady) {
        this.openPlan()
      }
      if (phase !== 'PLAN_READY' && this.dialog === 'plan') {
        this.dialog = null
      }
      if ((phase === 'IDLE' || phase === 'ASSIGNING') && this.dialog === 'stop') {
        this.dialog = null
      }
    },
    // 打开确认框后异步读取估算，关闭或重新打开时丢弃旧请求的结果。
    async click(): Promise<void> {
      if (this.busy || this.dialog || this.phase === 'ASSIGNING') {
        return
      }
      if (this.phase === 'PLAN_READY') {
        this.openPlan()
        return
      }
      if (this.phase !== 'IDLE') {
        this.dialog = 'stop'
        return
      }
      if (this.reorganizeBusy || useLookStore().reorganizing) {
        useToastStore().show('正在重新整理，请先等待完成或停止当前队列')
        return
      }
      // 本地分级还在跑：只提示，不弹确认框
      if (this.rating.running) {
        useToastStore().show('本地分级判完才能整理')
        return
      }
      if (useLookStore().needsApiKey) {
        useToastStore().show(LOOK_KEY_HINT)
        return
      }
      this.estimate = null
      this.dialog = 'confirm'
      const request = ++this.estimateRequest
      try {
        const est = await fetchOrganizeEstimate()
        if (request !== this.estimateRequest) return
        if (est.ratingLeft > 0) {
          this.close()
          useToastStore().show(`本地分级还剩 ${est.ratingLeft.toLocaleString('zh-CN')} 张，判完才能整理`)
          return
        }
        this.estimate = est
      } catch (err) {
        if (request !== this.estimateRequest) return
        this.close()
        useToastStore().show(errText(err), 'error')
      }
    },
    openPlan(): void {
      this.draft = (this.plan ?? []).map((f) => ({ ...f, characters: [...f.characters], works: [...f.works], tags: [...f.tags] }))
      this.dialog = 'plan'
    },
    close(): void {
      if (this.dialog === 'confirm' && !this.estimate) void window.api.organize.dismissEstimate()
      this.estimateRequest++
      this.estimate = null
      this.dialog = null
    },
    // 开始，或方案出错后重试
    async start(): Promise<void> {
      if (this.busy || (this.dialog === 'confirm' && !this.estimate)) return
      this.busy = true
      try {
        const s = await startOrganize()
        this.apply(s)
        if (this.dialog === 'confirm') {
          this.dialog = null
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    },
    // 按草稿方案分图
    async approve(): Promise<void> {
      // 发给主进程的要是普通对象（响应式代理过不了进程间传递）
      const plan = this.draft
        .filter((f) => f.characters.length + f.works.length + f.tags.length > 0)
        .map((f) => ({ name: f.name, isNew: f.isNew, characters: [...f.characters], works: [...f.works], tags: [...f.tags] }))
      if (plan.length === 0) {
        useToastStore().show('方案里没有目录了', 'error')
        return
      }
      this.busy = true
      try {
        const n = await approveOrganize(plan)
        this.dialog = null
        useToastStore().show(n > 0 ? `整理好了 ${n} 张，在“AI 建议”里慢慢审` : '这次没有能分进这些目录的图')
        await useGalleryStore().afterEdit()
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    },
    // 停下一键整理（已经排进看图队列的照常看完）
    async cancel(): Promise<void> {
      const stoppedLooking = this.phase === 'LOOKING' || this.phase === 'FOLLOWING'
      this.busy = true
      try {
        const s = await cancelOrganize()
        this.apply(s)
        this.dialog = null
        if (stoppedLooking) {
          useToastStore().show('已停止整理，剩余看图任务会继续处理')
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    },
    // 草稿：去掉一个目录、去掉目录里的一个词
    removeFolder(i: number): void {
      this.draft.splice(i, 1)
    },
    removeTerm(i: number, kind: 'characters' | 'works' | 'tags', word: string): void {
      const f = this.draft[i]
      f[kind] = f[kind].filter((w) => w !== word)
    },
    async openReorganize(): Promise<void> {
      if (this.busy || this.reorganizeBusy || this.dialog || this.reorganizeDialog) {
        return
      }
      if (useLookStore().reorganizing) {
        useToastStore().show('正在重新整理，请先等待完成或停止当前队列')
        return
      }
      if (this.phase !== 'IDLE') {
        useToastStore().show('一键整理进行中，请先完成或停止')
        return
      }
      if (this.rating.running) {
        useToastStore().show('本地分级判完才能重新整理')
        return
      }
      if (useScanStore().running) {
        useToastStore().show('正在扫描，等扫完再重新整理')
        return
      }
      this.reorganizeEstimate = null
      this.reorganizeDialog = true
      const request = ++this.reorganizeEstimateRequest
      try {
        const est = await fetchReorganizeEstimate()
        if (request !== this.reorganizeEstimateRequest) return
        this.reorganizeEstimate = est
      } catch (err) {
        if (request !== this.reorganizeEstimateRequest) return
        this.closeReorganize()
        useToastStore().show(errText(err), 'error')
      }
    },
    closeReorganize(): void {
      if (this.reorganizeBusy) return
      if (this.reorganizeDialog && !this.reorganizeEstimate) {
        void dismissReorganizeEstimate().catch(() => undefined)
      }
      this.reorganizeEstimateRequest++
      this.reorganizeEstimate = null
      this.reorganizeDialog = false
    },
    async resetToSource(): Promise<void> {
      if (this.reorganizeBusy || !this.reorganizeEstimate) return
      this.reorganizeBusy = true
      try {
        const res = await resetOrganizedToSource()
        this.reorganizeBusy = false
        this.closeReorganize()
        const parts: string[] = []
        if (res.resetImages > 0) parts.push(`已归回 ${res.resetImages.toLocaleString('zh-CN')} 张图`)
        if (res.movedToSource > 0) parts.push(`移回源目录 ${res.movedToSource.toLocaleString('zh-CN')} 张`)
        if (res.removedCopies > 0) parts.push(`清理类目录副本 ${res.removedCopies.toLocaleString('zh-CN')} 份`)
        if (res.skippedOnlyInCategory > 0) parts.push(`跳过 ${res.skippedOnlyInCategory.toLocaleString('zh-CN')} 张（缺少在线源目录）`)
        const message = parts.length ? parts.join('，') : '没有需要归回源目录的图片'
        useToastStore().show(message, res.skippedOnlyInCategory > 0 && res.resetImages === 0 ? 'error' : 'ok')
        await Promise.all([useGalleryStore().afterEdit(), useLookStore().init()])
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.reorganizeBusy = false
      }
    },
    async relookOrganized(): Promise<void> {
      if (this.reorganizeBusy || !this.reorganizeEstimate) return
      if (useLookStore().needsApiKey) {
        useToastStore().show(LOOK_KEY_HINT)
        return
      }
      if (this.reorganizeEstimate.ratingLeft > 0) {
        useToastStore().show(`本地分级还剩 ${this.reorganizeEstimate.ratingLeft.toLocaleString('zh-CN')} 张，判完才能重新整理`)
        return
      }
      this.reorganizeBusy = true
      try {
        const res = await startReorganizeRelook()
        this.reorganizeBusy = false
        this.closeReorganize()
        useToastStore().show(
          res.enqueued > 0
            ? `已排入 ${res.enqueued.toLocaleString('zh-CN')} 张图重新看图，结果将进入“AI 建议”`
            : '没有可重新看图的已整理图片'
        )
        await Promise.all([useGalleryStore().afterEdit(), useLookStore().init()])
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.reorganizeBusy = false
      }
    }
  }
})
