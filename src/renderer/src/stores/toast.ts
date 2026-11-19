import { defineStore } from 'pinia'

// 顶部提示条：成功提示 5 秒后自动消失；失败提示不消失，点“知道了”关闭
export type ToastKind = 'ok' | 'error'

// 自动消失的时间（毫秒）
const AUTO_HIDE_MS = 5000

let hideTimer: ReturnType<typeof setTimeout> | null = null

export const useToastStore = defineStore('toast', {
  state: () => ({
    text: '',
    kind: 'ok' as ToastKind,
    // 每次弹出加一，界面用它重新播放弹入动画
    seq: 0
  }),
  getters: {
    visible: (s): boolean => s.text !== ''
  },
  actions: {
    // 弹一条提示，替换掉正在显示的那条
    show(text: string, kind: ToastKind = 'ok'): void {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      this.text = text
      this.kind = kind
      this.seq += 1
      if (kind !== 'error') {
        hideTimer = setTimeout(() => this.close(), AUTO_HIDE_MS)
      }
    },
    // 关掉提示
    close(): void {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      this.text = ''
    }
  }
})
