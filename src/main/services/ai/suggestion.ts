// AI 建议的统一格式：诺诺看图的结果和外部 AI 贴回来的结果都整理成这样，再拆成一项一项让你确认（设计 6.5、6.6）
import { NAME_MAX, TAGS_PER_IMAGE, TAG_NAME_MAX, type AiSuggestionVO } from '@shared/api'

// 一份建议
export interface SuggestionFields {
  name: string
  character: string
  work: string
  tags: string[]
  source: string
  description: string
}

export type SuggestionKind = AiSuggestionVO['kind']

// 一项建议在 fieldStatus 里的键：name、who、work、src、dir、tag:<标签名>
export function fieldKey(kind: SuggestionKind, value: string): string {
  return kind === 'tag' ? `tag:${value}` : kind
}

// 从键还原种类
export function kindOfKey(key: string): SuggestionKind | null {
  if (key.startsWith('tag:')) {
    return 'tag'
  }
  return key === 'name' || key === 'who' || key === 'work' || key === 'src' || key === 'dir' || key === 'r18Review' ? key : null
}

// 截到最多 n 个字（按字算，不按 UTF-16 码元）
function clip(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('')
}

// 取字符串字段：去首尾空白、压掉多余空白
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
}

// 整理时要用的图库信息
export interface NormalizeContext {
  // 小写的标签名或别名 → 标签的正式名字（对齐你的叫法）
  canonical: Map<string, string>
  // 这张图已有的标签名（不再建议）
  existing: string[]
}

// 把一份原始结果整理干净：字数上限、标签对齐到图库里已有的叫法、去重、不和角色作品重复、不和已有标签重复；
// 出处只接受 http(s) 链接
export function normalizeFields(raw: unknown, ctx: NormalizeContext): SuggestionFields {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const align = (s: string): string => ctx.canonical.get(s.toLowerCase()) ?? s
  const character = clip(align(str(o.character)), TAG_NAME_MAX)
  const work = clip(align(str(o.work)), TAG_NAME_MAX)
  const existing = new Set(ctx.existing.map((t) => t.toLowerCase()))
  const tags: string[] = []
  for (const t of Array.isArray(o.tags) ? o.tags : []) {
    const name = clip(align(str(t)), TAG_NAME_MAX)
    const low = name.toLowerCase()
    if (!name || existing.has(low) || tags.some((x) => x.toLowerCase() === low) || low === character.toLowerCase() || low === work.toLowerCase()) {
      continue
    }
    tags.push(name)
    if (tags.length === TAGS_PER_IMAGE) break
  }
  const source = str(o.source)
  return {
    name: clip(str(o.name), NAME_MAX),
    character: existing.has(character.toLowerCase()) ? '' : character,
    work: existing.has(work.toLowerCase()) ? '' : work,
    tags,
    source: /^https?:\/\/\S+$/i.test(source) ? source.slice(0, 300) : '',
    description: clip(str(o.description), 200)
  }
}

// 一份建议拆成待确认的各项（描述不在里面，直接写进图片描述）
export function pendingStatus(f: SuggestionFields): Record<string, 'PENDING'> {
  const out: Record<string, 'PENDING'> = {}
  if (f.name) {
    out.name = 'PENDING'
  }
  for (const t of f.tags) {
    out[fieldKey('tag', t)] = 'PENDING'
  }
  if (f.character) {
    out.who = 'PENDING'
  }
  if (f.work) {
    out.work = 'PENDING'
  }
  if (f.source) {
    out.src = 'PENDING'
  }
  return out
}

// 一项建议的值（“放进类目录”的建议存的是 { dir }）
export function valueOf(f: SuggestionFields & { dir?: string }, key: string): string {
  const kind = kindOfKey(key)
  if (kind === 'tag') {
    return key.slice(4)
  }
  if (kind === 'dir') {
    return typeof f.dir === 'string' ? f.dir : ''
  }
  return kind === 'name' ? f.name : kind === 'who' ? f.character : kind === 'work' ? f.work : kind === 'src' ? f.source : ''
}
