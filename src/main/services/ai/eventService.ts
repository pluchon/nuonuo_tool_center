// 事件流：软件里的操作只追加记下来，做梦时整理成偏好（设计 6.4）。涉及 R-18 图的事件标出来，不进整理材料；
// 记事件失败只写日志，不影响操作本身
import { eq } from 'drizzle-orm'
import { getLogger } from '../../common/logger'
import { getDatabase } from '../../db/client'
import { aiEvent, image } from '../../db/schema'

const log = getLogger('ai')

// 事件类型：改名、加标签、去标签、移动 / 复制到哪个目录、采用 / 不要 AI 建议、贴回外部 AI 结果、回复的赞踩
export type EventKind =
  | 'rename'
  | 'tag.add'
  | 'tag.remove'
  | 'file.move'
  | 'file.copy'
  | 'suggestion.accept'
  | 'suggestion.reject'
  | 'assist.import'
  | 'reply.vote'

// 记一条事件
export async function recordEvent(kind: EventKind, imageId: number | null, payload: Record<string, unknown>): Promise<void> {
  try {
    const { db } = getDatabase()
    let isR18 = false
    if (imageId !== null) {
      const [row] = await db.select({ isR18: image.isR18 }).from(image).where(eq(image.id, imageId)).limit(1)
      isR18 = row?.isR18 ?? false
    }
    await db.insert(aiEvent).values({ kind, imageId, payload, isR18 })
  } catch (err) {
    log.warn(`记录事件 ${kind} 失败`, err)
  }
}

// 一次操作涉及多张图时逐张记
export async function recordEvents(kind: EventKind, imageIds: number[], payload: Record<string, unknown>): Promise<void> {
  for (const id of imageIds) {
    await recordEvent(kind, id, payload)
  }
}
