// 核心档案：每次对话、看图都带上的第②层前缀。最多一天出一个新版本；对话锁定开始时的版本，保证缓存前缀不变
import { findLatestProfile, findProfileByVersion, insertProfile } from '../../repositories/aiProfileRepository'
import { findVocabulary } from '../../repositories/aiSearchRepository'
import { findCategories } from '../../repositories/tagRepository'
import { profileText, type TagVocab } from './assistantPrompt'
import { stableStringify } from './promptPrefix'

// 两个版本之间至少隔多久
const MIN_INTERVAL_MS = 24 * 3600 * 1000
// 词表里每个分类最多带多少个标签
const PER_CATEGORY_MAX = 80

// 当前图库的标签词表：只取用在非 R-18 图上的标签，按分类分组，组内按标签 id
export async function currentVocab(): Promise<TagVocab> {
  const [tags, categories] = await Promise.all([findVocabulary(), findCategories()])
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

// 拿到最新的档案；还没有就建第 1 版；词表变了且离上一版超过一天就出新版本（正文沿用，做梦以后才会改正文）
export async function ensureProfile(now: Date = new Date()): Promise<{ version: number }> {
  const vocab = await currentVocab()
  const latest = await findLatestProfile()
  if (!latest) {
    return insertProfile(1, '', vocab)
  }
  const changed = stableStringify(latest.tagVocab) !== stableStringify(vocab)
  if (changed && now.getTime() - latest.createTime.getTime() >= MIN_INTERVAL_MS) {
    return insertProfile(latest.version + 1, latest.content, vocab)
  }
  return latest
}

// 对话锁定的那一版档案的文字；老对话没有锁定版本时用最新的
export async function profileOfConversation(version: number | null): Promise<string> {
  const row = version !== null ? await findProfileByVersion(version) : await findLatestProfile()
  if (!row) {
    return ''
  }
  return profileText(row.version, row.content, row.tagVocab as TagVocab)
}
