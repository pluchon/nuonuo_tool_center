// 做梦（设计 6.4，借鉴 Claude 的 dreaming 和 Letta 的 sleep-time compute）：只在空闲时把事件流整理成记忆，
// 再最多一天一次把记忆写成核心档案。拆成很多小步，每步开始前看忙不忙，忙了就停（已经发出的请求做完并保存），下次空闲接着做；
// 每步都可以重做，不会重复写入。大部分偏好用本地规则从统计里得出，只有写核心档案调模型
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { getLogger } from '../../common/logger'
import { findLatestProfile, insertProfile } from '../../repositories/aiProfileRepository'
import {
  findDreamCursor,
  findEventsAfter,
  findMemoriesByIds,
  findRecentEvents,
  findValidMemories,
  findValidMemoryByContent,
  insertMemoryRow,
  lastMemoryChange,
  saveDreamCursor,
  updateMemoryConfidence,
  type AiEventEntity
} from '../../repositories/aiMemoryRepository'
import { findTagNamesOf } from '../../repositories/aiSearchRepository'
import { chatCall } from './bailianClient'
import { currentVocab } from './profileService'

const log = getLogger('dream')

// 几分钟没操作才算空闲
const IDLE_MS = 5 * 60_000
// 多久看一次能不能做梦
const TICK_MS = 60_000
// 一小步最多整理多少条新事件；统计习惯时往回看多少条
const STEP_EVENTS = 200
const WINDOW_EVENTS = 3000
// 核心档案两个版本至少隔多久、最多多少字
const PROFILE_INTERVAL_MS = 24 * 3600 * 1000
const PROFILE_MAX = 500
// 规则得出偏好的门槛：同一件事至少几次
const MIN_COUNT = 3
// 赞、踩对可信度的影响（只是弱参考）；低于这个就标失效
const UP_DELTA = 0.05
const DOWN_DELTA = 0.1
const INVALID_BELOW = 0.2

// 做梦需要的外部信息
export interface DreamConfig {
  // 有活在跑（扫描、分级、看图、对话）
  isBusy: () => boolean
}

let config: DreamConfig | null = null
let lastActivity = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
let running = false

// 你操作了一下（每个 IPC 调用都算）
export function markActivity(): void {
  lastActivity = Date.now()
}

// 现在能不能继续做梦
function canDream(now: number = Date.now()): boolean {
  return !!config && now - lastActivity >= IDLE_MS && !config.isBusy()
}

// 一批事件里由规则得出的偏好：{内容, 次数}
export interface RuleFact {
  key: string
  content: string
  count: number
}

// 本地规则：把事件统计成偏好（什么图常放哪个目录、哪些说法总是不要）
export function factsFromEvents(events: AiEventEntity[], tagsOf: Map<number, string[]>): RuleFact[] {
  const counts = new Map<string, RuleFact>()
  const bump = (key: string, content: string): void => {
    const f = counts.get(key) ?? { key, content, count: 0 }
    f.count++
    counts.set(key, f)
  }
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    if ((e.kind === 'file.move' || e.kind === 'file.copy') && e.imageId && typeof p.to === 'string') {
      for (const tag of tagsOf.get(e.imageId) ?? []) {
        bump(`dir:${tag}:${p.to}`, `带「${tag}」标签的图常放进「${p.to}」目录`)
      }
    }
    if (e.kind === 'suggestion.reject' && typeof p.value === 'string') {
      const what = p.kind === 'tag' ? '标签' : p.kind === 'who' ? '角色名' : p.kind === 'work' ? '作品名' : p.kind === 'name' ? '名字' : '出处'
      if (p.kind !== 'name' && p.kind !== 'src') {
        bump(`reject:${p.kind}:${p.value}`, `不要用「${p.value}」当${what}`)
      }
    }
  }
  return [...counts.values()].filter((f) => f.count >= MIN_COUNT)
}

// 一小步：整理一批新事件（规则偏好、赞踩调可信度），保存进度；没有新事件返回 false
async function stepEvents(): Promise<boolean> {
  const cursor = await findDreamCursor()
  const events = await findEventsAfter(cursor?.lastEventId ?? 0, STEP_EVENTS)
  if (events.length === 0) {
    return false
  }
  // 习惯按最近一段时间的全部事件统计（不只这一批）：一天移一张的习惯也能攒够次数；同样的内容只会提高可信度，不会重复写
  const window = await findRecentEvents(['file.move', 'file.copy', 'suggestion.reject'], WINDOW_EVENTS)
  const imageIds = [...new Set(window.map((e) => e.imageId).filter((x): x is number => x !== null))]
  const facts = factsFromEvents(window, await findTagNamesOf(imageIds))
  for (const f of facts) {
    const existing = await findValidMemoryByContent(f.content)
    const confidence = Math.min(0.85, 0.5 + 0.05 * f.count)
    if (existing) {
      await updateMemoryConfidence(existing.id, Math.max(existing.confidence, confidence), false)
    } else {
      await insertMemoryRow(f.content, 'rule', confidence, events[events.length - 1].id)
    }
  }
  // 赞只给用到的记忆加一点分；踩降分，低到一定程度标失效（踩不单独形成偏好）
  for (const e of events.filter((x) => x.kind === 'reply.vote')) {
    const p = (e.payload ?? {}) as { vote?: string; memoryIds?: number[] }
    for (const m of await findMemoriesByIds(p.memoryIds ?? [])) {
      if (m.validTo) {
        continue
      }
      const next = p.vote === 'UP' ? Math.min(1, m.confidence + UP_DELTA) : Math.max(0, m.confidence - DOWN_DELTA)
      await updateMemoryConfidence(m.id, next, next < INVALID_BELOW)
    }
  }
  await saveDreamCursor(cursor?.jobId ?? null, events[events.length - 1].id)
  return true
}

// 一小步：记忆有变化且离上一版超过一天时，把记忆写成新的核心档案（调一次便宜的 flash；正在进行的对话不受影响）
async function stepProfile(now: Date = new Date()): Promise<boolean> {
  if (!readCloudCredentials().dashscopeApiKey) {
    return false
  }
  const latest = await findLatestProfile()
  const changed = await lastMemoryChange()
  if (!changed || (latest && (changed <= latest.createTime || now.getTime() - latest.createTime.getTime() < PROFILE_INTERVAL_MS))) {
    return false
  }
  const memories = await findValidMemories(60)
  if (memories.length === 0) {
    return false
  }
  const prompt = [
    '下面是一个人整理本地图库时的偏好记录（每条后面是可信度 0 到 1），以及旧的偏好摘要。',
    `请写一段新的偏好摘要，不超过 ${PROFILE_MAX} 个字：合并重复的，新的和旧的矛盾时以可信度高、更新的为准，可信度低于 0.4 的不写；`,
    '只写对起名字、打标签、分目录有用的习惯，用“- ”开头每条一行，不要写别的。',
    '',
    '## 旧的偏好摘要',
    latest?.content.trim() || '（还没有）',
    '',
    '## 偏好记录',
    ...memories.map((m) => `- ${m.content}（${m.confidence.toFixed(2)}）`)
  ].join('\n')
  const res = await chatCall({ kind: 'dream', model: BAILIAN_CONFIG.chatModel, messages: [{ role: 'user', content: prompt }] })
  const content = Array.from(String(res.message.content ?? '').trim()).slice(0, PROFILE_MAX).join('')
  if (!content) {
    return false
  }
  await insertProfile((latest?.version ?? 0) + 1, content, await currentVocab())
  log.info(`核心档案更新到第 ${(latest?.version ?? 0) + 1} 版`)
  return true
}

// 做一次梦：一小步一小步来，忙了就停
export async function dreamOnce(force = false): Promise<void> {
  if (running) {
    return
  }
  running = true
  try {
    while ((force || canDream()) && (await stepEvents())) {
      // 每整理完一批就重新看一次忙不忙
    }
    if (force || canDream()) {
      await stepProfile()
    }
  } catch (err) {
    log.warn('做梦出错，下次空闲再试', err)
  } finally {
    running = false
  }
}

// 开始定时看能不能做梦
export function startDreaming(next: DreamConfig): void {
  config = next
  if (!timer) {
    timer = setInterval(() => {
      if (canDream()) {
        void dreamOnce()
      }
    }, TICK_MS)
  }
}

// 退出前停掉
export function stopDreaming(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
