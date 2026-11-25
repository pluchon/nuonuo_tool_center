import type { AiImageReference } from '@shared/api'
import type { AiMessageEntity } from '../../repositories/aiConversationRepository'
import { addImageExclusion } from '../../repositories/aiMemoryRepository'
import { referencedHistory, referenceOrdinal, selectReferenceGroup } from './assistantReferences'

type Method = 'tag' | 'metadata' | 'vector' | 'feature' | 'filter'
export interface MatchEvidence {
  methods: Record<number, Method>
  tagConditions?: string[]
}
export interface SearchRecord {
  imageIds: number[]
  how: string | null
  evidence?: MatchEvidence
  incomplete?: string
}

const methodText: Record<Method, string> = {
  tag: '它在当次检索中符合已确认的标签条件',
  metadata: '它的本地文字记录符合当时的关键词条件',
  vector: '它在当次检索中达到了画面向量相似度要求',
  feature: '当时的本地图片识别记录符合所选画面特征',
  filter: '它符合当时选定的图库范围和筛选条件'
}

function exclusion(text: string): 'once' | 'always' | undefined {
  // 仅采用含有排除指令的分句。「这次排除，以后照常」不能建立长期偏好。
  for (const clause of text.split(/[，,。；;！？!?\n]/u)) {
    if (/(?:别|不要|不用|无需)(?:再)?(?:排除|隐藏|去掉)/u.test(clause)) continue
    const action = /排除|去掉|隐藏|不(?:再|想)?看|不要|别(?:再)?(?:给我)?(?:推荐|显示|看|展示)/u
    const target = /这(?:一)?张|那张|第\s*[零一二两三四五六七八九十百千\d]+\s*张/u
    if (action.test(clause) && target.test(clause)) {
      return /以后|今后|往后|下次也|一直|永远/u.test(clause) ? 'always' : 'once'
    }
  }
}

// 引用位置在生成卡片时确定。隐藏或移除一张图，不能把它的序号转给另一张。
export async function resultFollowup(
  text: string, references: AiImageReference[], history: AiMessageEntity[], userId: number,
  visible: (ids: number[], source?: number) => Promise<Set<number>>
): Promise<(SearchRecord & { text: string; readLibraryMetadata: true }) | null> {
  const why = /(?:为什么|为何|怎么|凭什么|依据|原因).{0,18}(?:命中|匹配|符合|出现|找到|搜到|选中|选出|推荐|是这张|是搜索结果)|(?:命中|匹配|入选|推荐).{0,8}(?:原因|依据|理由)/u.test(text)
  const omit = exclusion(text)
  if (!why && !omit) return null
  const group = selectReferenceGroup(text, references.length ? references : referencedHistory(history, text))
  const position = referenceOrdinal(text)
  if (!group.length || (position === undefined && !/这张|那张|该图/u.test(text)
    && (!references.length || !/(?:命中|匹配|入选|推荐)/u.test(text)))) return null
  const chosen = position === undefined ? (group.length === 1 ? group[0] : undefined) : group.find((ref) => ref.position === position)
  const sources = history.filter((m) => m.role === 'ASSISTANT' && (m.content as SearchRecord).how)
  const source = sources.find((m) => m.id === chosen?.sourceMessageId)
  const stored = source?.content as SearchRecord | undefined
  const id = chosen?.imageId
  const reply = (message: string) => ({ text: message, how: null, imageIds: [], readLibraryMetadata: true as const })
  if (!id) return reply('请指定是哪一张图，或把那张卡片拖到输入框。')
  const available = await visible(stored?.imageIds.includes(id) ? stored.imageIds : group.map((r) => r.imageId), source?.id)
  if (!available.has(id)) return reply('这张图片已不在当前检索范围内。')
  if (omit) {
    const permanent = omit === 'always'
    if (permanent) await addImageExclusion(id, userId)
    const ids = (stored?.imageIds ?? group.map((ref) => ref.imageId)).filter((item) => item !== id && available.has(item))
    return { ...reply(permanent ? '记住了，以后检索时会排除这张图。' : '这次先把这张图收起来。'),
      imageIds: ids, how: `本轮筛选，保留 ${ids.length} 张`, evidence: stored?.evidence, incomplete: stored?.incomplete }
  }
  const method = stored?.evidence?.methods[id]
  if (!method) return reply('这张图没有保存对应检索的命中依据。')
  const tags = method === 'tag' ? stored?.evidence?.tagConditions?.join('、') : ''
  return reply(methodText[method] + (tags ? `「${tags}」` : '') + '。')
}
