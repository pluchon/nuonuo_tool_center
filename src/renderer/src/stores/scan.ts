import { defineStore } from 'pinia'
import type { ScanProgressVO, ScanResultVO, ScanStateVO } from '@shared/api'
import { fetchScanState, startScan, stopScan, subscribeScanState } from '@/api/scan'
import { useLibraryStore } from './library'
import { useToastStore } from './toast'

// 扫描中刷新侧栏计数的最小间隔（毫秒）
const REFRESH_INTERVAL = 3000

let unsubscribe: (() => void) | null = null
let lastRefresh = 0

// 扫描完成后的提示文字
function resultText(r: ScanResultVO): { text: string; error: boolean } {
  if (r.stopped) {
    return { text: `已停止扫描，找到的 ${r.found.toLocaleString('zh-CN')} 张图都保留了`, error: false }
  }
  if (r.failed > 0) {
    return { text: `扫描完成，有 ${r.failed.toLocaleString('zh-CN')} 个文件读不了`, error: true }
  }
  const where = r.rootName ? `「${r.rootName}」` : ''
  return { text: `${where}扫描完成，共 ${r.total.toLocaleString('zh-CN')} 个文件`, error: false }
}

// 扫描状态：进度来自主进程推送；结束时刷新侧栏并弹提示
export const useScanStore = defineStore('scan', {
  state: () => ({
    progress: null as ScanProgressVO | null,
    last: null as ScanResultVO | null
  }),
  getters: {
    running: (s): boolean => s.progress !== null,
    // 某个源目录是不是正在被扫描
    isScanning:
      (s) =>
      (rootId: number): boolean =>
        s.progress !== null && s.progress.rootIds.includes(rootId)
  },
  actions: {
    // 开始监听主进程推送，并取一次当前状态（应用启动时可能已经在自动扫描）
    async init(): Promise<void> {
      if (!unsubscribe) {
        unsubscribe = subscribeScanState((state) => this.apply(state))
      }
      // 打开窗口前已经结束的扫描不再弹提示，只记下结果
      const state = await fetchScanState()
      this.progress = state.progress
      this.last = state.last
      // 订阅之前刚结束的扫描不会再推送，这里补读一次概况
      void useLibraryStore().load()
    },
    // 收到新状态：进度结束（有值变成空）时刷新图库概况并弹完成提示；扫描中按间隔刷新侧栏计数
    apply(state: ScanStateVO): void {
      // 有新的扫描结果就算结束了一次（订阅前就开始的扫描没收到过进度，也要能认出来）
      const finished = state.progress === null && state.last !== null && state.last.finishedAt !== this.last?.finishedAt
      this.progress = state.progress
      this.last = state.last
      const library = useLibraryStore()
      if (finished) {
        void library.load()
        if (state.last) {
          const { text, error } = resultText(state.last)
          // 启动时的自动扫描默默做完，只有读失败才提示
          if (!state.last.auto || error) {
            useToastStore().show(text, error ? 'error' : 'ok')
          }
        }
        return
      }
      if (state.progress && Date.now() - lastRefresh > REFRESH_INTERVAL) {
        lastRefresh = Date.now()
        void library.load()
      }
    },
    // 扫描全部目录或某一个源目录
    async start(rootId: number | null): Promise<void> {
      this.apply(await startScan(rootId))
    },
    // 停止扫描
    async stop(): Promise<void> {
      this.apply(await stopScan())
    }
  }
})
