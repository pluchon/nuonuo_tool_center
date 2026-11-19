import type { ScanStateVO } from '@shared/api'
import { unwrap } from './request'

// 开始扫描：rootId 为空扫全部目录
export function startScan(rootId: number | null): Promise<ScanStateVO> {
  return unwrap(window.api.scan.start(rootId))
}

// 停止扫描（已经找到的图都保留）
export function stopScan(): Promise<ScanStateVO> {
  return unwrap(window.api.scan.stop())
}

// 当前扫描状态
export function fetchScanState(): Promise<ScanStateVO> {
  return unwrap(window.api.scan.getState())
}

// 订阅主进程推来的扫描状态，返回取消订阅的函数
export function subscribeScanState(fn: (state: ScanStateVO) => void): () => void {
  return window.api.scan.onState(fn)
}
