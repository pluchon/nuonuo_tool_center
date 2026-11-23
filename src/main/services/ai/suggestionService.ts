// AI 建议：列出一张图待确认的各项、逐项采用或不要、全部采用；其他 AI 辅助整理的提示词和贴回结果的整理（设计 6.5、6.6）
import { TAGS_PER_IMAGE, type AiSuggestionVO, type SuggestionBatchVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { categoryTopNames, ensureCategoryTop } from '../fileOps/folderOpsService'
import { copyImages } from '../fileOps/transferService'
import { getDatabase } from '../../db/client'
import { findImageBrief, findTagNamesOf, findVocabulary } from '../../repositories/aiSearchRepository'
import { findResultsOf, insertAiResult, LOOK_CONTENT_REJECTED, updateFieldStatus, updateSource, type FieldState } from '../../repositories/aiResultRepository'
import { findLatestProfile } from '../../repositories/aiProfileRepository'
import { updateR18 } from '../../repositories/imageRepository'
import { findCategories } from '../../repositories/tagRepository'
import { addTag, renameImage } from '../imageEditService'
import { recordEvent, recordEvents } from './eventService'
import { kindOfKey, normalizeFields, pendingStatus, valueOf, type SuggestionFields } from './suggestion'

// 一次最多一起处理多少张（和多选上限一致）
const MANY_MAX = 200

// id 必须是正整数
function checkId(id: unknown): asserts id is number {
  if (!Number.isInteger(id) || (id as number) <= 0) {
    throw new BizError('BAD_REQUEST', 'id 不对')
  }
}

// 一张图待确认的建议（几份建议里同一项只列一次，先来的在前）
export async function listSuggestions(imageId: number): Promise<AiSuggestionVO[]> {
  checkId(imageId)
  const out: AiSuggestionVO[] = []
  for (const r of await findResultsOf(imageId)) {
    const status = (r.fieldStatus ?? {}) as Record<string, FieldState>
    for (const [key, state] of Object.entries(status)) {
      const kind = kindOfKey(key)
      if (state !== 'PENDING' || !kind || out.some((s) => s.key === key)) {
        continue
      }
      const value = kind === 'r18Review' ? LOOK_CONTENT_REJECTED : valueOf(r.result as SuggestionFields, key)
      out.push({ key, kind, value, origin: r.origin })
    }
  }
  // 放进类目录的：标出目录现在还不存在（采用时新建）
  const dir = out.findIndex((s) => s.kind === 'dir')
  if (dir >= 0) {
    if ((await findImageBrief(imageId))?.isR18) {
      out.splice(dir, 1)
    } else {
      const names = (await categoryTopNames()).map((n) => n.toLowerCase())
      out[dir].isNew = !names.includes(out[dir].value.toLowerCase())
    }
  }
  // 按名字、标签、角色、作品、出处、放进类目录的顺序
  const order = ['r18Review', 'name', 'tag', 'who', 'work', 'src', 'dir']
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
}

// 复制进类目录（目录不在就建），源目录里的原图不动；有没复制成的报原因
async function copyIntoCategory(imageIds: number[], name: string): Promise<void> {
  const { pg } = getDatabase()
  const { rows } = await pg.query('SELECT 1 FROM image WHERE id = ANY($1::bigint[]) AND is_r18 LIMIT 1', [imageIds])
  if (rows.length > 0) throw new BizError('CONFLICT', 'R-18 图片不参与自动整理')
  const abs = await ensureCategoryTop(name)
  const res = await copyImages({ view: 'all', sort: 'new' }, imageIds, [abs])
  if (res.failed > 0) {
    throw new BizError('DEPENDENCY_FAILED', `有 ${res.failed} 张没放进「${name}」：${res.error ?? '原因不明'}`)
  }
}

// 分类名 → 分类 id（角色、作品）
async function categoryIdOf(name: string): Promise<number | undefined> {
  return (await findCategories()).find((c) => c.name === name)?.id
}

// 采用一项：名字写进图片名字，标签、角色、作品当标签加上（角色、作品放进对应分类），出处记下来
async function apply(imageId: number, kind: Exclude<AiSuggestionVO['kind'], 'r18Review'>, value: string): Promise<void> {
  if (kind === 'name') {
    await renameImage(imageId, value, { record: false })
  } else if (kind === 'dir') {
    await copyIntoCategory([imageId], value)
  } else if (kind === 'src') {
    await updateSource(imageId, value)
  } else {
    const categoryId = kind === 'who' ? await categoryIdOf('角色') : kind === 'work' ? await categoryIdOf('作品') : undefined
    const res = await addTag({ imageIds: [imageId], name: value, categoryId }, { record: false })
    if (res.skipped > 0) {
      throw new BizError('CONFLICT', `这张图已经有 ${TAGS_PER_IMAGE} 个标签了，先去掉一个再采用`)
    }
  }
}

// 把所有建议里这一项的状态改掉
async function mark(imageId: number, key: string, state: FieldState): Promise<void> {
  for (const r of await findResultsOf(imageId)) {
    const status = { ...((r.fieldStatus ?? {}) as Record<string, FieldState>) }
    if (status[key] === 'PENDING') {
      status[key] = state
      await updateFieldStatus(r.id, status)
    }
  }
}

// 采用或不要一项，返回剩下的
export async function decideSuggestion(imageId: number, key: string, accept: boolean): Promise<AiSuggestionVO[]> {
  checkId(imageId)
  const item = (await listSuggestions(imageId)).find((s) => s.key === key)
  if (!item) {
    throw new BizError('NOT_FOUND', '这条建议已经处理过了')
  }
  if (item.kind === 'r18Review') {
    if (!(await updateR18([imageId], accept, true))) throw new BizError('NOT_FOUND', '这条建议已经处理过了')
    return listSuggestions(imageId)
  }
  if (accept) {
    await apply(imageId, item.kind, item.value)
  }
  await mark(imageId, key, accept ? 'ACCEPTED' : 'REJECTED')
  await recordEvent(accept ? 'suggestion.accept' : 'suggestion.reject', imageId, { kind: item.kind, value: item.value, origin: item.origin })
  return listSuggestions(imageId)
}

// 全部采用（标签满了的那几项留着，报一次原因）
export async function acceptAllSuggestions(imageId: number): Promise<AiSuggestionVO[]> {
  checkId(imageId)
  let firstError: unknown = null
  for (const item of await listSuggestions(imageId)) {
    if (item.kind === 'r18Review') continue
    try {
      await apply(imageId, item.kind, item.value)
      await mark(imageId, item.key, 'ACCEPTED')
      await recordEvent('suggestion.accept', imageId, { kind: item.kind, value: item.value, origin: item.origin })
    } catch (err) {
      firstError ??= err
    }
  }
  if (firstError) {
    throw firstError
  }
  return listSuggestions(imageId)
}

// 多张图的建议一起采用或不要（一组、多选、键盘快审）：放进同一个类目录的合成一次复制；
// 一张图里有一项没处理成，这张图剩下的留着，最后报第一个原因
export async function decideMany(rawIds: unknown, accept: unknown): Promise<SuggestionBatchVO> {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MANY_MAX || rawIds.some((v) => !Number.isInteger(v) || v <= 0)) {
    throw new BizError('BAD_REQUEST', `一次最多处理 ${MANY_MAX} 张`)
  }
  const ids = [...new Set(rawIds as number[])]
  let error: string | null = null
  // 放进类目录的按目录分组，其余的逐项处理
  const byDir = new Map<string, number[]>()
  const bad = new Set<number>()
  let reviewOnly = 0
  for (const id of ids) {
    const suggestions = await listSuggestions(id)
    if (suggestions.length === 1 && suggestions[0].kind === 'r18Review') reviewOnly++
    for (const item of suggestions) {
      if (item.kind === 'r18Review') continue
      if (!accept) {
        await mark(id, item.key, 'REJECTED')
        await recordEvent('suggestion.reject', id, { kind: item.kind, value: item.value, origin: item.origin })
        continue
      }
      if (item.kind === 'dir') {
        byDir.set(item.value, [...(byDir.get(item.value) ?? []), id])
        continue
      }
      try {
        await apply(id, item.kind, item.value)
        await mark(id, item.key, 'ACCEPTED')
        await recordEvent('suggestion.accept', id, { kind: item.kind, value: item.value, origin: item.origin })
      } catch (err) {
        bad.add(id)
        error ??= err instanceof Error ? err.message : String(err)
      }
    }
  }
  for (const [dir, list] of byDir) {
    try {
      await copyIntoCategory(list, dir)
      for (const id of list) {
        await mark(id, 'dir', 'ACCEPTED')
      }
      await recordEvents('suggestion.accept', list.slice(0, 50), { kind: 'dir', value: dir, origin: 'NONO' })
    } catch (err) {
      list.forEach((id) => bad.add(id))
      error ??= err instanceof Error ? err.message : String(err)
    }
  }
  return { done: ids.length - bad.size - reviewOnly, failed: bad.size, error }
}

// ===== 其他 AI 辅助整理 =====

// 图库里已有的标签按分类列出来（只取用在非 R-18 图上的，每类最多 20 个）
async function vocabLines(): Promise<string[]> {
  const [vocab, categories] = await Promise.all([findVocabulary(), findCategories()])
  const byCat = new Map<string, string[]>()
  for (const t of vocab.filter((x) => x.general)) {
    const name = categories.find((c) => c.id === t.categoryId)?.name ?? '其他'
    const list = byCat.get(name) ?? []
    if (list.length < 20) {
      list.push(t.name)
    }
    byCat.set(name, list)
  }
  return [...byCat].map(([cat, names]) => `- ${cat}：${names.join('、')}`)
}

// 我的整理习惯：核心档案正文里的每一行；还没整理出来时用几条默认的
export async function habitLines(): Promise<string[]> {
  const content = (await findLatestProfile())?.content.trim() ?? ''
  const lines = content
    .split(/\n|。/)
    .map((l) => l.replace(/^[-*\s]+/, '').trim())
    .filter(Boolean)
  return (lines.length ? lines : ['角色名用中文圈子里最常用的叫法', '表情包的名字直接用图里的那句话', '标签尽量用下面已有的词，同一个意思不要造新词']).map((l) => `- ${l}`)
}

// 字节数写成好读的大小
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// 复制给其他 AI 的完整提示词：任务、这张图已知的信息、我的整理习惯、图库里已有的标签、要求、输出格式和例子
export async function assistPrompt(imageId: number): Promise<string> {
  checkId(imageId)
  const brief = await findImageBrief(imageId)
  if (!brief) {
    throw new BizError('NOT_FOUND', '这张图已经不在图库里了')
  }
  const file = brief.relPath?.split('\\').pop() ?? ''
  const tags = (await findTagNamesOf([imageId])).get(imageId) ?? []
  const { pg } = getDatabase()
  const size = (await pg.query<{ byte_size: number }>('SELECT byte_size FROM image WHERE id = $1', [imageId])).rows[0]?.byte_size ?? 0
  return [
    '你是一个帮我整理本地图库的助手。我会发给你一张图片，请你看图后帮我补全这张图的名字、角色、作品、标签、出处和描述。',
    '',
    '## 这张图已知的信息',
    `- 文件名：${file}`,
    `- 尺寸和大小：${brief.width && brief.height ? `${brief.width}×${brief.height}` : '未知'}，${sizeText(Number(size))}`,
    `- 现在的名字：${brief.displayName ?? file}`,
    `- 已有标签：${tags.length ? tags.join('、') : '无'}`,
    '',
    '## 我的整理习惯',
    ...(await habitLines()),
    '',
    '## 图库里已有的标签（按分类，优先从这里选）',
    ...(await vocabLines()),
    '',
    '## 要求',
    '- 只根据图片内容和上面的信息判断；认不出、不确定的字段写空字符串，不要编造。',
    '- 名字、角色、作品、每个标签都不超过 15 个字。',
    `- 标签最多 ${TAGS_PER_IMAGE} 个，只写有辨识度的内容，不重复已有标签、角色名或作品名。`,
    '- 出处只写你能确定的作品页面链接（http 开头）；不确定就写空字符串。',
    '- 描述用一句话；如果图里有文字（比如表情包），把文字原样写进描述。',
    '- 用中文回答。只输出下面格式的一个 json 代码块，代码块前后不要写任何别的文字。',
    '',
    '## 输出格式',
    '```json',
    '{',
    '  "name": "",',
    '  "character": "",',
    '  "work": "",',
    '  "tags": [],',
    '  "source": "",',
    '  "description": ""',
    '}',
    '```',
    '',
    '## 例子',
    '```json',
    '{',
    '  "name": "好椰",',
    '  "character": "甘雨",',
    '  "work": "原神",',
    '  "tags": ["表情包", "Q版"],',
    '  "source": "",',
    '  "description": "Q版甘雨举着牌子，牌子上写着“好椰”"',
    '}',
    '```'
  ].join('\n')
}

// 交给诺诺整理：本地对齐叫法、去重、归类，存成来源为外部 AI 的建议（不调云端，R-18 图也能用）；返回整理出几项
export async function importAssist(imageId: number, raw: unknown): Promise<number> {
  checkId(imageId)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BizError('BAD_REQUEST', '没找到 json 代码块')
  }
  const vocab = await findVocabulary()
  const canonical = new Map<string, string>()
  for (const t of vocab) {
    for (const n of [t.name, ...t.aliases]) {
      canonical.set(n.toLowerCase(), t.name)
    }
  }
  const existing = (await findTagNamesOf([imageId])).get(imageId) ?? []
  const fields = normalizeFields(raw, { canonical, existing })
  const status = pendingStatus(fields)
  const n = Object.keys(status).length
  if (n === 0) {
    throw new BizError('BAD_REQUEST', '没整理出能用的内容')
  }
  await insertAiResult({ imageId, kind: 'IDENTIFY', origin: 'EXTERNAL', model: 'external', result: fields, fieldStatus: status })
  await recordEvent('assist.import', imageId, { fields: n })
  return n
}
