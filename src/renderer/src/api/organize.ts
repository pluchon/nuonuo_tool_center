import type {
  OrganizeEstimateVO,
  OrganizeFolderVO,
  OrganizeStateVO,
  ReorganizeEstimateVO,
  ReorganizeRelookResultVO,
  ReorganizeResetResultVO
} from '@shared/api'
import { unwrap } from './request'

// 一键整理的当前状态
export function fetchOrganizeState(): Promise<OrganizeStateVO> {
  return unwrap(window.api.organize.state())
}

// 开始前的估算
export function fetchOrganizeEstimate(): Promise<OrganizeEstimateVO> {
  return unwrap(window.api.organize.estimate())
}

// 开始（方案出错后再调一次是重试）
export function startOrganize(): Promise<OrganizeStateVO> {
  return unwrap(window.api.organize.start())
}

// 按批好的方案分图，返回生成了多少条建议
export function approveOrganize(plan: OrganizeFolderVO[]): Promise<number> {
  return unwrap(window.api.organize.approve(plan))
}

// 取消
export function cancelOrganize(): Promise<OrganizeStateVO> {
  return unwrap(window.api.organize.cancel())
}

// 订阅状态变化
export function onOrganizeState(listener: (state: OrganizeStateVO) => void): () => void {
  return window.api.organize.onState(listener)
}

// 重新整理前的估算
export function fetchReorganizeEstimate(): Promise<ReorganizeEstimateVO> {
  return unwrap(window.api.reorganize.estimate())
}

// 取消重新整理估算
export function dismissReorganizeEstimate(): Promise<void> {
  return unwrap(window.api.reorganize.dismissEstimate())
}

// 模式 1：归回源目录
export function resetOrganizedToSource(): Promise<ReorganizeResetResultVO> {
  return unwrap(window.api.reorganize.resetToSource())
}

// 模式 2：已整理图片参考已有信息重看
export function startReorganizeRelook(): Promise<ReorganizeRelookResultVO> {
  return unwrap(window.api.reorganize.relook())
}
