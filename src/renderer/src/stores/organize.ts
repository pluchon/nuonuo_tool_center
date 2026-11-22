import { defineStore } from 'pinia'
import type { OrganizeEstimateVO, OrganizeFolderVO, OrganizeLookedVO, OrganizePhase, OrganizeStateVO, RatingProgressVO } from '@shared/api'
import { approveOrganize, cancelOrganize, fetchOrganizeEstimate, fetchOrganizeState, onOrganizeState, startOrganize } from '@/api/organize'
import { fetchRatingProgress, onRatingProgress } from '@/api/rating'
import { useGalleryStore } from './gallery'
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
    draft: [] as OrganizeFolderVO[],
    busy: false,
    rating: { running: false, done: 0, total: 0 } as RatingProgressVO
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
      // 方案刚出来：弹出来给你批
      if (phase === 'PLAN_READY' && !wasReady) {
        this.openPlan()
      }
      if (phase !== 'PLAN_READY' && this.dialog === 'plan') {
        this.dialog = null
      }
    },
    // 点底栏按钮：空闲时先估算再确认；方案好了打开方案；进行中问要不要停
    async click(): Promise<void> {
      if (this.phase === 'PLAN_READY') {
        this.openPlan()
        return
      }
      if (this.phase !== 'IDLE') {
        this.dialog = 'stop'
        return
      }
      // 本地分级还在跑：只提示，不弹确认框
      if (this.rating.running) {
        useToastStore().show('本地分级判完才能整理')
        return
      }
      try {
        const est = await fetchOrganizeEstimate()
        // 本地分级还没判完（比如扫描时暂停着）：先不弹确认框
        if (est.ratingLeft > 0) {
          useToastStore().show(`本地分级还剩 ${est.ratingLeft.toLocaleString('zh-CN')} 张，判完才能整理`)
          return
        }
        this.estimate = est
        this.dialog = 'confirm'
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    openPlan(): void {
      this.draft = (this.plan ?? []).map((f) => ({ ...f, characters: [...f.characters], works: [...f.works], tags: [...f.tags] }))
      this.dialog = 'plan'
    },
    close(): void {
      this.dialog = null
    },
    // 开始，或方案出错后重试
    async start(): Promise<void> {
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
      this.busy = true
      try {
        const s = await cancelOrganize()
        this.apply(s)
        this.dialog = null
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
    }
  }
})
