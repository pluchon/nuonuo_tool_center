// 核心档案：每次对话、看图都带上的第②层前缀；词表变化后立即生成新版（不冻结旧词表），对话仍锁定开始时的版本以维持缓存
import { findLatestProfile, findProfileByVersion, insertProfile } from '../../repositories/aiProfileRepository'
import { findVocabulary } from '../../repositories/aiSearchRepository'
import { findCategories } from '../../repositories/tagRepository'
import { profileText, type TagVocab } from './assistantPrompt'
import { stableStringify } from './promptPrefix'

// 词表里每个分类最多带多少个标签
const PER_CATEGORY_MAX = 80

// 当前图库的标签词表：仅取类目录里已确认（无待审 AI 建议）且用在非 R-18 图上的标签
export async function currentVocab(): Promise<TagVocab> {
  const [tags, categories] = await Promise.all([findVocabulary(true), findCategories()])
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  const vocab: TagVocab = {}
  for (const t of tags) {
    if (!t.general) {
      continue
    }
    const name = catName.get(t.categoryId) ?? '其他'
    const list = (vocab[name] ??= [])
    if (list.length < PER_CATEGORY_MAX) {
      list.push(t.name)
    }
  }
  return vocab
}

// 拿到最新的档案；还没有就建第 1 版；词表一旦变化立即生成新版本（新对话立刻感知）
export async function ensureProfile(_now: Date = new Date()): Promise<{ version: number }> {
  const [latest, vocab] = await Promise.all([findLatestProfile(), currentVocab()])
  if (!latest) {
    return insertProfile(1, '', vocab)
  }
  const changed = stableStringify(latest.tagVocab) !== stableStringify(vocab)
  if (changed) {
    return insertProfile(latest.version + 1, latest.content, vocab)
  }
  return latest
}

// 读取某版档案正文及其中包含的标签名集合（供进行中对话计算第④层实时增量）
export async function profileSnapshotForConversation(
  version: number | null,
  includeVocabulary = true,
  allowedTags?: ReadonlySet<string>
): Promise<{ text: string; includedTags: Set<string> }> {
  const row = version !== null ? await findProfileByVersion(version) : await findLatestProfile()
  if (!row) {
    return { text: '', includedTags: new Set() }
  }
  const vocab = includeVocabulary ? (row.tagVocab as TagVocab) : {}
  const includedTags = new Set<string>()
  const filtered: TagVocab = {}
  for (const [category, names] of Object.entries(vocab)) {
    const nextNames = allowedTags ? names.filter((name) => allowedTags.has(name)) : names
    filtered[category] = nextNames
    for (const name of nextNames) includedTags.add(name)
  }
  return { text: profileText(row.version, row.content, filtered), includedTags }
}

// 对话锁定的那一版档案的文字；老对话没有锁定版本时用最新的
export async function profileOfConversation(
  version: number | null,
  includeVocabulary = true,
  allowedTags?: ReadonlySet<string>
): Promise<string> {
  return (await profileSnapshotForConversation(version, includeVocabulary, allowedTags)).text
}
