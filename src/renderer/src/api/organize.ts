import type { OrganizeEstimateVO, OrganizeFolderVO, OrganizeStateVO } from '@shared/api'
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
