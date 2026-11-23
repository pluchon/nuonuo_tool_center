import { defineStore } from 'pinia'

// 顶部提示条：成功提示 5 秒后自动消失（可带“撤销”）；错误提示也自动消失，可提前关闭
export type ToastKind = 'ok' | 'error'

// 自动消失的时间（毫秒）
const AUTO_HIDE_MS = 5000

let hideTimer: ReturnType<typeof setTimeout> | null = null
// 当前提示条的撤销动作（换下一条提示或消失后就没了）
let undoAction: (() => Promise<void> | void) | null = null

export const useToastStore = defineStore('toast', {
  state: () => ({
    text: '',
    kind: 'ok' as ToastKind,
    undoable: false,
    // 每次弹出加一，界面用它重新播放弹入动画
    seq: 0
  }),
  getters: {
    visible: (s): boolean => s.text !== ''
  },
  actions: {
    // 弹一条提示，替换掉正在显示的那条；undo 给了就显示“撤销”
    show(text: string, kind: ToastKind = 'ok', undo?: () => Promise<void> | void): void {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      this.text = text
      this.kind = kind
      undoAction = kind === 'ok' ? (undo ?? null) : null
      this.undoable = undoAction !== null
      this.seq += 1
      hideTimer = setTimeout(() => this.close(), AUTO_HIDE_MS)
    },
    // 点“撤销”：先关提示条，再执行撤销
    async undo(): Promise<void> {
      const action = undoAction
      this.close()
      if (action) {
        await action()
      }
    },
    // 关掉提示
    close(): void {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      undoAction = null
      this.undoable = false
      this.text = ''
    }
  }
})
