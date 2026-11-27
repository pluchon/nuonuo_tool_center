import type { AiImageReference, AiSearchScope, DirKeyDTO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { currentReferenceRecords, findReferenceOrigins, type ReferenceScope } from '../../repositories/aiReferenceRepository'
import type { AiMessageEntity } from '../../repositories/aiConversationRepository'
import { visibleResultIds, type AiSearchFilter } from '../../repositories/aiSearchRepository'
import { findActiveRootsByKind } from '../../repositories/libraryRootRepository'

// 统一解析助手范围：指定类目录 / 全部类目录 / 全部类目录与已整理图片
export async function scopeQuery(
  scope: AiSearchScope | DirKeyDTO | null | undefined
): Promise<{ dirs: AiSearchFilter['dirs']; includeOrganized: boolean }> {
  if (!scope) {
    return { dirs: undefined, includeOrganized: false }
  }
  if (scope.kind === 'organized') {
    return { dirs: undefined, includeOrganized: true }
  }
  if (scope.kind === 'source') {
    return { dirs: [], includeOrganized: false }
  }
  const [catRoot] = await findActiveRootsByKind('CATEGORY')
  return { dirs: [{ rootId: catRoot?.id ?? -1, prefix: scope.name }], includeOrganized: false }
}

// “在哪里找”换成检索用的目录条件
export async function scopeDirs(scope: AiSearchScope | DirKeyDTO | null): Promise<Array<{ rootId: number; prefix: string }> | undefined> {
  return (await scopeQuery(scope)).dirs
}

export async function visibleReferenceResults(ids: number[], origin: ReferenceScope, current: ReferenceScope): Promise<Set<number>> {
  const allowR18 = origin.includeR18 === true && current.includeR18 === true
  const originQuery = await scopeQuery(origin.scope ?? null)
  const currentQuery = await scopeQuery(current.scope ?? null)
  const allowed = await visibleResultIds(ids, allowR18, originQuery.dirs, originQuery.includeOrganized)
  if (
    currentQuery.includeOrganized ||
    (!current.scope && !originQuery.includeOrganized) ||
    (current.scope?.kind === 'category' && origin.scope?.kind === 'category' && origin.scope.name === current.scope.name)
  ) {
    return allowed
  }
  return visibleResultIds([...allowed], allowR18, currentQuery.dirs, currentQuery.includeOrganized)
}

function resultGroups(refs: AiImageReference[]): Map<number, AiImageReference[]> {
  const groups = new Map<number, AiImageReference[]>()
  for (const ref of refs) {
    if (!ref.sourceMessageId) continue
    const group = groups.get(ref.sourceMessageId)
    if (group) group.push(ref)
    else groups.set(ref.sourceMessageId, [ref])
  }
  return groups
}

export async function checkReferences(input: unknown, conversationId: number | null,
  visible: (ids: number[], scope: ReferenceScope) => Promise<Set<number>>): Promise<AiImageReference[]> {
  if (input == null) return []
  if (!Array.isArray(input)) throw new BizError('BAD_REQUEST', '图片引用格式无效')
  const seen = new Set<number>()
  const refs: AiImageReference[] = []
  for (const r of input) {
    if (!Number.isSafeInteger(r?.imageId) || r.imageId <= 0 || !Number.isSafeInteger(r.position) || r.position < 1
      || typeof r.groupId !== 'string' || !(r.sourceMessageId === undefined ? /^gallery:[\w-]{1,64}$/.test(r.groupId)
        : Number.isSafeInteger(r.sourceMessageId) && r.sourceMessageId > 0 && r.groupId === 'result:' + r.sourceMessageId)) {
      throw new BizError('BAD_REQUEST', '图片引用格式无效')
    }
    if (seen.has(r.imageId)) continue
    seen.add(r.imageId)
    refs.push({ imageId: r.imageId, groupId: r.groupId, position: r.position, name: '',
      ...(r.sourceMessageId ? { sourceMessageId: r.sourceMessageId } : {}) })
  }
  if (!refs.length) return []
  const origins = resultGroups(refs)
  if (origins.size) {
    const rows = await findReferenceOrigins(conversationId, [...origins.keys()])
    if (rows.length !== origins.size) throw new BizError('CONFLICT', '引用的检索结果已经变更')
    for (const row of rows) {
      const ids = row.ids ?? []
      const allowed = await visible(ids, { scope: row.scope, includeR18: row.include_r18 })
      const shown = ids.filter((id) => allowed.has(id))
      for (const r of origins.get(Number(row.id)) ?? []) {
        if (!allowed.has(r.imageId) || (ids[r.position - 1] !== r.imageId && shown[r.position - 1] !== r.imageId)) {
          throw new BizError('CONFLICT', '引用的检索结果或范围已经变更')
        }
      }
    }
  }
  const current = await currentReferenceRecords([...seen], false)
  for (const r of refs) {
    const item = current.get(r.imageId)
    if (!item) throw new BizError('CONFLICT', '部分引用图片已经移除，请移除对应引用后重试')
    r.name = item.name
  }
  return refs
}

function ordinal(value?: string): number | undefined {
  if (!value) return
  if (/^\d+$/.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  let sum = 0
  let digit = 0
  for (const c of value.replace(/两/g, '二')) {
    if (units[c]) {
      sum += (digit || 1) * units[c]
      digit = 0
    } else {
      digit = digits.indexOf(c)
    }
  }
  return sum + digit
}

export function referenceOrdinal(text: string): number | undefined {
  return ordinal(text.match(/第\s*([0-9零一二两三四五六七八九十百千]+)\s*(?:张|幅|个图)/u)?.[1])
}

export function selectReferenceGroup(query: string, refs: AiImageReference[]): AiImageReference[] {
  const groups = [...new Set(refs.map((r) => r.groupId))]
  const n = ordinal(query.match(/第\s*([0-9零一二两三四五六七八九十百千]+)\s*组/u)?.[1])
  if (n !== undefined) return refs.filter((r) => r.groupId === groups[n - 1])
  if (/上一组|前一组/u.test(query)) return refs.filter((r) => r.groupId === groups.at(-2))
  if (/这一?组|最后一组/u.test(query) || (groups.length > 1 && referenceOrdinal(query) !== undefined)) return refs.filter((r) => r.groupId === groups.at(-1))
  return refs
}

export function referencedHistory(history: AiMessageEntity[], query = ''): AiImageReference[] {
  const pastGroups = /(?:前一|上一|第.{1,6})组/u.test(query)
  const collected = new Map<string, AiImageReference[]>()
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]
    const c = row.content as { references?: AiImageReference[]; imageIds?: number[]; how?: string | null }
    const refs = row.role === 'USER' ? c.references : c.how ? (c.imageIds ?? []).map((imageId, index) =>
      ({ imageId, name: '', position: index + 1, groupId: 'result:' + row.id, sourceMessageId: row.id })) : undefined
    if (!refs) {
      // 新上传的附件没有图库编号，不能沿用它之前的图片作为本次指代。
      const user = row.content as { attachments?: unknown[]; attachment?: unknown; image?: unknown }
      if (row.role === 'USER' && (user.attachments?.length || user.attachment || user.image)) break
      continue
    }
    if (!pastGroups) return refs
    const groups = new Map<string, AiImageReference[]>()
    for (const ref of refs) {
      const group = groups.get(ref.groupId)
      if (group) group.push(ref)
      else groups.set(ref.groupId, [ref])
    }
    for (const [id, group] of [...groups].reverse()) if (!collected.has(id)) collected.set(id, group)
  }
  return [...collected.values()].reverse().flat()
}

// 最近一次明确选图或单图结果成为谈话对象。新附件和新结果会替换旧对象。
export function conversationFocus(history: AiMessageEntity[]): AiImageReference[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]
    const c = row.content as { references?: AiImageReference[]; focusReferences?: AiImageReference[]; how?: string;
      imageIds?: number[]; attachments?: unknown[]; attachment?: unknown; image?: unknown }
    if (row.role === 'ASSISTANT') {
      if (c.focusReferences) return c.focusReferences
      if (c.how) return c.imageIds?.length === 1 ? [{ imageId: c.imageIds[0], position: 1, name: '',
        groupId: 'result:' + row.id, sourceMessageId: row.id }] : []
    } else if (row.role === 'USER') {
      if (c.references?.length) return c.references
      if (c.attachments?.length || c.attachment || c.image) return []
    }
  }
  return []
}

// 二次筛选保留当前引用组的顺序，同时复核每组原来的目录和分级。
export async function filterReferenceIds(refs: AiImageReference[], visible: (ids: number[], source?: number) => Promise<Set<number>>): Promise<number[]> {
  const groups = resultGroups(refs)
  const gallery = refs.filter((r) => r.sourceMessageId === undefined)
  const allowed = gallery.length ? await visible(gallery.map((r) => r.imageId)) : new Set<number>()
  for (const [source, group] of groups) {
    for (const id of await visible(group.map((r) => r.imageId), source)) allowed.add(id)
  }
  return refs.map((r) => r.imageId).filter((id) => allowed.has(id))
}

export async function referenceDetails(chosen: AiImageReference[],
  allowResult: (ids: number[], source: number) => Promise<Set<number>>) {
  const hidden = new Set<AiImageReference>()
  for (const [id, group] of resultGroups(chosen)) {
    const allowed = await allowResult(group.map((r) => r.imageId), id)
    for (const ref of group) {
      if (!allowed.has(ref.imageId)) hidden.add(ref)
    }
  }
  const visible = chosen.filter((r) => !hidden.has(r))
  const now = await currentReferenceRecords(visible.map((r) => r.imageId))
  return visible.flatMap((r) => {
    const entry = now.get(r.imageId)
    return entry ? [{ ...r, entry }] : []
  })
}

export async function ordinaryReferenceDetails(refs: AiImageReference[],
  visible: (ids: number[], source?: number) => Promise<Set<number>>, checkScope: boolean, includeR18 = false) {
  const allowed = checkScope && refs.length ? await visible(refs.map(r => r.imageId)) : null
  const records = await referenceDetails(allowed ? refs.filter(r => allowed.has(r.imageId)) : refs, visible)
  return records.filter(r => includeR18 || !r.entry.is_r18).map(r => ({
    imageId: r.imageId, position: r.position, name: r.entry.name, tags: r.entry.tags,
    ...(r.entry.is_r18 ? { isR18: true } : {})
  }))
}

export async function resolveReferenceQuery(text: string, input: AiImageReference[], history: AiMessageEntity[], allowResult: (ids: number[], source: number) => Promise<Set<number>>, includeR18 = false) {
  const index = referenceOrdinal(text)
  // 只在请求完整对应本地字段时直接读取。创作、改名和解释等开放式请求保留原文交给模型。
  const field = text.trim().replace(/[？?。！!]+$/u, '')
    .replace(/^(?:请)?(?:比较|查看|列出|看看)?(?:刚才)?/u, '')
    .replace(/^(?:第\s*[零一二两三四五六七八九十百千\d]+\s*组|上一组|这一组)?(?:第\s*[零一二两三四五六七八九十百千\d]+\s*[张幅]|这(?:[零一二两三四五六七八九十百千\d]+|几)张|这些|这张|它们)?(?:图片|图)?的?/u, '')
  const common = /^(?:共同|共有|相同)的?标签(?:有哪些)?$/u.test(field)
  const detail = /^(?:叫什么(?:名字)?|名字|名称|文件名|(?:有哪些|有什么|哪些|已有)?(?:已确认的?)?标签)$/u.test(field)
  const direct = common || detail || (index !== undefined && !field)
  const inherited = !input.length && (index !== undefined || /这(?:张|些|几张)(?:图|引用)/u.test(text)
    || (direct && /这[些几组两张幅]|它们|共同|上一组|第.{1,6}组/u.test(text)))
  if (!input.length && !inherited) return
  const refs = input.length ? input : referencedHistory(history, text)
  if (!refs.length) return
  let chosen = selectReferenceGroup(text, refs)
  if (index !== undefined) chosen = chosen.filter((r) => r.position === index)
  if (!chosen.length) return { reply: '这组引用里没有指定的图片。' }
  // 历史结果保留原始序号。图片不再可见时不能用下一张代替。
  const originalCount = chosen.length
  const items = await referenceDetails(chosen, allowResult)
  if (!items.length) return { reply: '引用的图片目前不可用。' }
  if (common) {
    if (items.length !== originalCount) return { reply: '部分引用图片目前不可用，无法确认全部图片的共同标签。' }
    const counts = new Map<string, number>()
    for (const { entry } of items) for (const t of new Set(entry.tags)) counts.set(t, (counts.get(t) ?? 0) + 1)
    const names = [...counts].filter(([, count]) => count === items.length).map(([name]) => name)
    return { focusReferences: chosen, reply: names.length ? '共同标签：' + names.join('、') + '。' : '这些图片没有共同的已确认标签。' }
  }
  if (direct || !text.trim()) return { focusReferences: chosen, reply: items.map(({ position, entry }) =>
    '第 ' + position + ' 张「' + entry.name + '」' + (entry.tags.length ? '的已确认标签：' + entry.tags.join('、') : '暂无已确认标签') + '。').join('\n') }
  const allowedItems = includeR18 ? items : items.filter((r) => !r.entry.is_r18)
  if (!allowedItems.length) return { reply: '这些引用图片仅支持查询本地标签和名称。' }
  const modelReferences = allowedItems.map(({ imageId, position }) => ({ imageId, position }))
  const groups = new Map([...new Set(refs.map((r) => r.groupId))].map((id, i) => [id, i + 1]))
  const note = allowedItems.map(({ imageId, position, groupId, entry }) => ({
    id: imageId,
    group: groups.get(groupId),
    position,
    name: entry.name,
    tags: entry.tags,
    ...(entry.is_r18 ? { isR18: true } : {})
  }))
  return { focusReferences: chosen, modelReferences, modelNote: '本轮图库引用的本地记录（仅元数据）：' + JSON.stringify(note) }
}
