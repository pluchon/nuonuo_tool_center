// 进度断点：退出时还没做完的任务（扫描、本地分级）把做到哪记在 app_setting 里，下次启动接着显示“200/3000”而不是从 0 开始
import { findActiveSettings, upsertSettings } from '../repositories/appSettingRepository'

// 扫描和本地分级各自的断点
export const SCAN_CHECKPOINT = 'progress.scan'
export const RATING_CHECKPOINT = 'progress.rating'

// 读一个断点；没有或已清掉（存的是空对象）时返回 null
export async function loadCheckpoint<T extends object>(key: string): Promise<T | null> {
  const row = (await findActiveSettings()).find((s) => s.key === key)
  const v = row?.value
  return v && typeof v === 'object' && Object.keys(v).length > 0 ? (v as T) : null
}

// 记下断点；传 null 清掉（任务做完了或你手动停了）。设置值不能为空，清掉时存空对象
export async function saveCheckpoint(key: string, value: object | null): Promise<void> {
  await upsertSettings([{ key, value: value ?? {} }])
}
