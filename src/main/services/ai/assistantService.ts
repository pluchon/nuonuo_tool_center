import OpenAI from 'openai'
import {
  AI_TEXT_MAX,
  AI_TITLE_MAX,
  type AiAskDTO,
  type AiAskResultVO,
  type AiAttachment,
  type AiConversationVO,
  type AiContextUsage,
  type AiMessageVO,
  type AiStatusVO,
  type DirKeyDTO,
  type GalleryItemVO
} from '@shared/api'
import { BAILIAN_CONFIG, EMBEDDING_CONFIG, bailianUnavailableMessage, isTokenPlanLocalMode, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import {
  findConversation,
  findConversations,
  findMessages,
  insertConversation,
  insertMemory,
  insertMessage,
  updateConversation,
  updateVote,
  type AiConversationEntity,
  type AiMessageEntity
} from '../../repositories/aiConversationRepository'
import { countEmbeddings, visibleResultIds, findDirNames, findImageBrief, findTagNamesOf, findVocabulary, searchImages, type AiSearchFilter, type AiSearchHit } from '../../repositories/aiSearchRepository'
import { findActiveRootsByKind } from '../../repositories/libraryRootRepository'
import { findCategories } from '../../repositories/tagRepository'
import { itemsOfImages, RECENT_DAYS } from '../galleryService'
import { ASSISTANT_RULES, ASSISTANT_TOOLS, NUONUO_PERSONA } from './assistantPrompt'
import { chatCall } from './bailianClient'
import { routeLocally, routeTagRequest, type CondLabel, type DictDir, type DictTag, type SearchSpec, type RoutedQuery } from './localRouter'
import { ensureProfile, profileOfConversation } from './profileService'
import { recordEvent } from './eventService'
import { relevantMemories } from './memoryRetrieval'
import { cachedSearchValue, searchCacheKey, SEARCH_CACHE_TTL } from '../../repositories/aiSearchCacheRepository'
import { contrastDescriptions, IMAGE_MIN_SIMILARITY, prepareRatedUpload, semanticVector, uploadVector } from './embeddingService'
import { checkAttachments, type StoredAttachment } from './assistantAttachment'
import { earConditions, earWords, verifyEarTypes } from './earSearch'
import { followupEvidence, hairQuery } from './visualFollowup'
import { hasSearchableImage } from '../../repositories/aiSearchRepository'
import { buildMessages, type PromptMessage } from './promptPrefix'
import { contextUsage, fitContext } from './contextWindow'

const log = getLogger('ai')

// 给模型看的结果最多几张
const BRIEF_MAX = 8
// 一次回答最多调几次模型（含工具往返）
const MAX_STEPS = 4

// 旧版本分别使用过 image 和 attachment，读取时统一为附件列表。
interface UserContent {
  text: string
  scope: DirKeyDTO | null
  includeR18: boolean
  attachments?: StoredAttachment[]
  attachment?: AiAttachment
  image?: string
}

function attachmentsOf(content: UserContent): StoredAttachment[] {
  if (content.attachments) return content.attachments
  if (content.attachment) return [content.attachment]
  return content.image ? [{ kind: 'image', name: '', mimeType: 'image/jpeg', dataUrl: content.image }] : []
}

// Markdown 正文属于用户消息；历史轮次同样保留正文，以支持追问附件。
function userText(content: UserContent): string {
  const file = attachmentsOf(content).find((a) => a.kind === 'markdown')
  if (file) {
    return [content.text, `附件「${file.name}」\n${file.text}`].filter(Boolean).join('\n\n')
  }
  return content.text || '（发了一张图，让诺诺按图找相似的）'
}

// 回复正文与结果卡片分开保存，历史回放也按当前分级和复核状态读取卡片。
interface AssistantContent {
  text: string
  how: string | null
  imageIds: number[]
  contextUsage?: AiContextUsage
  // 读取单图详情或词表的正文可能含随后改为 R-18 的信息，追问时重新查询。
  readLibraryMetadata?: boolean
  // 这次回答带上的记忆（赞、踩时调整它们的可信度）
  memoryIds?: number[]
}

// 一次检索的结果：普通图（模型能看到）和 R-18 图（只在本地查，模型只知道数量）
interface SearchOutcome {
  imageIds: number[]
  ordinaryIds: number[]
}

// 正在回答的对话（同一段对话不并发回答）
const answering = new Set<number>()

// 是否配置了百炼 API Key
export function getAiStatus(): AiStatusVO {
  return isTokenPlanLocalMode() ? { ready: false, localOnly: true } : { ready: !!readCloudCredentials().dashscopeApiKey }
}

// 对话转成界面用的结构
function toConversationVO(c: AiConversationEntity & { lastAt: Date }): AiConversationVO {
  return { id: c.id, title: c.title, pinned: c.pinned, updatedAt: c.lastAt.toISOString() }
}

// 全部对话
export async function listConversations(): Promise<AiConversationVO[]> {
  return (await findConversations()).map(toConversationVO)
}

// 消息转成界面用的结构；结果图按存下的 id 现查（改了名字、删了图都能反映出来）
function toMessageVO(m: AiMessageEntity, images: GalleryItemVO[] = []): AiMessageVO {
  const base = { id: m.id, vote: m.vote ?? null, createdAt: m.createTime.toISOString() }
  if (m.role === 'USER') {
    const c = m.content as UserContent
    const attachments = attachmentsOf(c).map((file): AiAttachment => file.kind === 'image'
      ? { kind: file.kind, name: file.name, mimeType: file.mimeType, dataUrl: file.dataUrl } : file)
    return { ...base, role: 'user', text: c.text, how: null, images: [], attachments,
      image: attachments.find((a) => a.kind === 'image')?.dataUrl ?? null, attachment: attachments[0] ?? null }
  }
  const c = m.content as AssistantContent
  const hasStoredResults = Boolean(c.imageIds?.length)
  const allHidden = hasStoredResults && !images.length
  return {
    ...base, role: 'assistant', hasStoredResults, images, image: null,
    ...(c.contextUsage ? { contextUsage: c.contextUsage } : {}),
    text: allHidden ? '这些图片目前不在检索范围内。' : replyText(c),
    how: allHidden ? null : c.how?.replace(/(?:至少)?找到 \d+ 张$/u, `找到 ${images.length} 张`) ?? null
  }
}

// 一段对话的消息（工具往返不存，只有你说的和诺诺的回复）
export async function listMessages(conversationId: number): Promise<AiMessageVO[]> {
  checkId(conversationId)
  if (!(await findConversation(conversationId))) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
  const rows = (await findMessages(conversationId)).filter((m) => m.role !== 'TOOL')
  // 同一目录的历史消息共用一次查询，每轮仍按当时的目录和 R-18 开关恢复卡片。
  const batches = new Map<string, { scope: DirKeyDTO | null; ids: Set<number>; includeR18: boolean; items: Map<number, GalleryItemVO> }>()
  let scope: DirKeyDTO | null = null
  let includeR18 = false
  const messages = rows.map((row) => {
    if (row.role === 'USER') {
      const user = row.content as UserContent
      scope = user.scope ?? null
      includeR18 = user.includeR18 === true
      return { row, includeR18 }
    }
    const ids = (row.content as AssistantContent).imageIds ?? []
    const key = JSON.stringify(scope)
    const batch = batches.get(key) ?? { scope, ids: new Set<number>(), includeR18: false, items: new Map<number, GalleryItemVO>() }
    for (const id of ids) batch.ids.add(id)
    batch.includeR18 ||= includeR18
    batches.set(key, batch)
    return { row, ids, batch, includeR18 }
  })
  for (const batch of batches.values()) {
    if (!batch.ids.size || batch.scope?.kind === 'source') continue
    const items = await itemsOfImages([...batch.ids], batch.includeR18, await scopeDirs(batch.scope))
    for (const item of items) batch.items.set(item.imageId, item)
  }
  return messages.map(({ row, ids, batch, includeR18 }) => {
    const images: GalleryItemVO[] = []
    for (const id of ids ?? []) {
      const item = batch?.items.get(id)
      if (item && (includeR18 || !item.isR18)) images.push(item)
    }
    return toMessageVO(row, images)
  })
}

// id 必须是正整数
function checkId(id: unknown): asserts id is number {
  if (!Number.isInteger(id) || (id as number) <= 0) {
    throw new BizError('BAD_REQUEST', 'id 不对')
  }
}

// 校验“在哪里找”
function checkScope(scope: unknown): DirKeyDTO | null {
  if (scope === null || scope === undefined) {
    return null
  }
  const s = scope as DirKeyDTO
  if (s.kind === 'source') throw new BizError('BAD_REQUEST', '诺诺助手只能检索类目录')
  if (s.kind === 'category' && typeof s.name === 'string' && s.name && !/[\\/]/.test(s.name)) {
    return { kind: 'category', name: s.name }
  }
  throw new BizError('BAD_REQUEST', '范围不对')
}

// 问诺诺：先存下这句话（没有对话就新开一段，用问题开头当名字），回复由 answer 另外生成
export async function ask(dto: AiAskDTO): Promise<AiAskResultVO> {
  const text = typeof dto?.text === 'string' ? dto.text.trim() : ''
  if (Array.from(text).length > AI_TEXT_MAX) {
    throw new BizError('BAD_REQUEST', `一次最多 ${AI_TEXT_MAX} 个字`)
  }
  const attachments = await checkAttachments(dto?.attachments, dto?.attachment, dto?.image)
  if (attachments.length && isTokenPlanLocalMode()) throw new BizError('DEPENDENCY_FAILED', bailianUnavailableMessage('附件需要云端模型'))
  if (!text && !attachments.length) throw new BizError('BAD_REQUEST', '说点什么吧')
  const content: UserContent = { text, scope: checkScope(dto.scope), includeR18: dto.includeR18 === true, ...(attachments.length ? { attachments } : {}) }
  let conversation: (AiConversationEntity & { lastAt: Date }) | undefined
  if (dto.conversationId === null || dto.conversationId === undefined) {
    // 新对话锁定当前的核心档案版本，这段对话里前缀不变
    const profile = await ensureProfile()
    const title = text ? Array.from(text).slice(0, 14).join('') : attachments.find((a) => a.kind === 'markdown')?.name || attachments[0]?.name || '按图找相似'
    const chars = Array.from(title)
    const created = await insertConversation(chars.length <= AI_TITLE_MAX ? title : chars.slice(0, AI_TITLE_MAX - 1).join('') + '…', profile.version)
    conversation = { ...created, lastAt: created.createTime }
  } else {
    checkId(dto.conversationId)
    conversation = await findConversation(dto.conversationId)
    if (!conversation) {
      throw new BizError('NOT_FOUND', '这段对话已经不在了')
    }
  }
  const message = await insertMessage(conversation.id, 'USER', content)
  return { conversation: { ...toConversationVO(conversation), updatedAt: message.createTime.toISOString() }, message: toMessageVO(message) }
}

// 词典：标签（含分类名、别名）和目录名
async function loadDictionary() {
  const [vocab, categories, dirs] = await Promise.all([findVocabulary(true), findCategories(), findDirNames()])
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  return {
    tags: vocab.map((t) => ({ id: t.id, name: t.name, aliases: t.aliases, category: catName.get(t.categoryId) ?? '标签', general: t.general })),
    dirs
  }
}

// “在哪里找”换成检索用的目录条件
async function scopeDirs(scope: DirKeyDTO | null): Promise<Array<{ rootId: number; prefix: string }> | undefined> {
  if (!scope) {
    return undefined
  }
  if (scope.kind === 'source') {
    return []
  }
  const [catRoot] = await findActiveRootsByKind('CATEGORY')
  return [{ rootId: catRoot?.id ?? -1, prefix: scope.name }]
}

// 先按全部条件的标签匹配排序，再补充文字和画面结果。模型只能读取普通图片。
async function runSearch(
  spec: SearchSpec,
  dirs: Array<{ rootId: number; prefix: string }> | undefined,
  includeR18: boolean,
  tags: DictTag[],
  semantic?: AiSearchFilter['vector'],
  query = '',
  candidateIds?: number[],
  evidence?: Awaited<ReturnType<typeof followupEvidence>>
): Promise<SearchOutcome> {
  const requiredGroups = (spec.requiredWords ?? []).map((word) => [word])
  const base = {
    ids: candidateIds,
    tagGroups: spec.tagGroups,
    keywordGroups: [...requiredGroups, ...spec.keywordGroups],
    orientation: spec.orientation,
    recentDays: spec.recent ? RECENT_DAYS : undefined,
    untagged: spec.untagged,
    dirs
  }
  // 只有语义描述、没有字面条件时不跑字面那一路（否则会把范围里的全部图都算进来）；没有语义时照常跑（如“二次元里的图”）
  const hasLiteral = base.tagGroups.length > 0 || base.keywordGroups.length > 0 || !!base.orientation || !!base.recentDays || !!base.untagged || !semantic
  const ears = earConditions(query, spec.keywordGroups)
  const preferredTagGroups = base.keywordGroups.map((words) => tags
    .filter((tag) => [tag.name, ...tag.aliases].some((name) => words.includes(name.toLowerCase())))
    .map((tag) => tag.id))
  const empty: AiSearchHit = { ids: [], total: 0 }
  const normal = hasLiteral ? await searchImages({ ...base, preferredTagGroups, r18: 'exclude' }) : empty
  const protectedHits = includeR18 && hasLiteral ? await searchImages({
    ...base, preferredTagGroups, keywordGroups: [...base.keywordGroups, ...ears.map(earWords)], r18: 'only'
  }) : empty
  const visual = semantic ? await searchImages({ ...base, ids: evidence?.unchecked ?? candidateIds, keywordGroups: requiredGroups, r18: 'exclude', vector: semantic }) : empty
  const visualIds = [...(evidence?.matches ?? []), ...visual.ids]
  const ordinary = new Set(await verifyEarTypes([...new Set([...normal.ids, ...visualIds])], ears))
  const ranked = [...new Set([
    ...(normal.tagMatchedIds ?? []), ...(protectedHits.tagMatchedIds ?? []),
    ...normal.ids, ...protectedHits.ids, ...visualIds
  ])]
  const protectedIds = new Set(protectedHits.ids)
  return {
    imageIds: ranked.filter((id) => ordinary.has(id) || protectedIds.has(id)),
    ordinaryIds: ranked.filter((id) => ordinary.has(id) && !protectedIds.has(id))
  }
}

// 按上传的图找相似的（只在有向量的普通图里找）
async function searchByImage(image: Extract<StoredAttachment, { kind: 'image' }>, dirs: Array<{ rootId: number; prefix: string }> | undefined): Promise<number[]> {
  const vec = await uploadVector(image.dataUrl, image.originalHash)
  const hit = await searchImages({
    tagGroups: [],
    keywordGroups: [],
    dirs,
    r18: 'exclude',
    vector: { values: vec, model: EMBEDDING_CONFIG.model, minSimilarity: IMAGE_MIN_SIMILARITY }
  })
  return hit.ids
}

// “怎么找的”那行字：不用“·”，条件之间用逗号
function howText(conds: CondLabel[], found: number): string {
  const parts = conds.map(([k, v]) => `${k}「${v}」`).join('，')
  return `搜索了图库${parts ? `：${parts}` : ''}，找到 ${found} 张`
}

function localReply(found: number): string {
  return found ? '' : '没找到符合条件的图片。'
}

// 旧版本可能把模型复述的内部注记当作回答保存。只信任本轮实际保存的结果编号。
function replyText(content: AssistantContent): string {
  if (/[（(]给用户看了\s*\d+\s*张图/.test(content.text)) return content.imageIds?.length ? localReply(content.imageIds.length) : '这条旧回复没有保存图片结果。'
  if ('llm' in content && content.how) return localReply(content.imageIds?.length ?? 0)
  return content.text
}

// 模型省略工具调用时，明确的找图指令仍按本轮问题查询数据库。
const searchRequest = /^(?:(?:请问|麻烦|请|可以|能不能|能|你|帮我|给我|替我|我想|我要|我想要|我|再|重新|继续|在图库里)\s*)*(?:想看看|想看|搜索|检索|查找|搜搜|搜一下|搜|找找|找一下|找)\s*/u

function requestedSearch(text: string): string | null {
  const query = text.trim()
  if (!searchRequest.test(query) && !/^(?:有没有|有无|给我看看).*(?:图|照片|壁纸)/u.test(query)) return null
  return query.replace(searchRequest, '').replace(/(?:的(?:图片|照片|图)|[？！?!。])+$/u, '').trim() || query
}

// 只有脱离历史也有明确含义的找图请求可以复用计划；记忆、词表、模型或范围变化时重新规划。
async function standalonePlanKey(query: string, u: UserContent, history: AiMessageEntity[], tags: Array<DictTag & { general: boolean }>, version: number | null) {
  if (attachmentsOf(u).length || query.length > 120 || /[这那它她他]|上次|刚才|前面|继续|再来|其中|剩下|其他|另外|一样|相似|要求|记住|偏好|喜欢|推荐|解释|比较|第.{0,4}张|按.*(?:筛选|描述)/u.test(query)) return
  const context: string[] = []
  for (const message of history) {
    if (message.role === 'USER') {
      const previous = message.content as UserContent
      if (attachmentsOf(previous).length) return
      if (previous.text !== u.text) context.push(previous.text)
    } else {
      const reply = message.content as AssistantContent
      if (!reply.how || (reply.text && reply.text !== localReply(0))) return
    }
  }
  const memories = await relevantMemories(u.text)
  return searchCacheKey('search-plan-v1', [BAILIAN_CONFIG.chatModel, query.trim(), context, u.scope, u.includeR18, version,
    tags.map((t) => [t.name, t.aliases, t.category, t.general]), memories.map((m) => [m.id, m.content])])
}

// “这些图里”明确限定在最近一轮结果；单独输入另一种特征仍检索当前完整范围。
function followupQuery(text: string): string | undefined {
  return /^(?:请|帮我)?(?:在|从)?(?:刚才|上次|上轮|上一轮)?(?:的)?(?:这几张|这些|刚才的|上次的)(?:图片|插画|图|结果)?(?:里面|里|中)(?:面)?[，,\s]*(?:筛选|找找|找出|只看|想看|看看|找|看|有)?\s*(.+)$/u.exec(text.trim())?.[1]?.replace(/(?:的图|吗|呢|[？?！!。])+$/u, '').trim()
}

// 模型给的检索参数换成检索条件：每个词先按标签名和别名对，对不上的当关键词
function specFromArgs(args: Record<string, unknown>, tags: DictTag[], query: string): { spec: SearchSpec; conds: CondLabel[] } {
  const requiredWords: string[] = []
  const spec: SearchSpec = { tagGroups: [], keywordGroups: [], requiredWords }
  const conds: CondLabel[] = []
  const byName = new Map<string, DictTag>()
  for (const t of tags) {
    for (const n of [t.name, ...t.aliases]) {
      byName.set(n.toLowerCase(), t)
    }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 30) : '')
  // 专名和用户指定的标签是硬性条件，即便词表中没有也不能在向量检索时丢弃。
  const addWord = (word: string, label: string): void => {
    if (!word) {
      return
    }
    const t = byName.get(word.toLowerCase())
    if (t) {
      if (!spec.tagGroups.some((g) => g.includes(t.id))) {
        spec.tagGroups.push([t.id])
        conds.push([t.category || label, t.name])
      }
    } else if (!requiredWords.includes(word.toLowerCase())) {
      requiredWords.push(word.toLowerCase())
      conds.push([label, word])
    }
  }
  addWord(str(args.character), '角色')
  addWord(str(args.work), '作品')
  addWord(str(args.place), '地点')
  for (const group of Array.isArray(args.keywordGroups) ? args.keywordGroups.slice(0, 12) : []) {
    if (!Array.isArray(group)) continue
    const words = [...new Set(group.slice(0, 8).map((word) => str(word).toLowerCase()).filter(Boolean))]
    if (words.length) {
      spec.keywordGroups.push(words)
      conds.push(['关键词', words.join('、')])
    }
  }
  // 模型有时把同一画面条件同时写进 tags 和 keywordGroups。普通描述仍可通过画面命中。
  const visualWords = new Set(spec.keywordGroups.flat())
  for (const w of Array.isArray(args.tags) ? args.tags.slice(0, 5) : []) {
    const word = str(w)
    if (query.includes('标签') || !visualWords.has(word.toLowerCase())) addWord(word, '标签')
  }
  const ori = args.orientation
  if (ori === 'portrait' || ori === 'landscape' || ori === 'square') {
    spec.orientation = ori
    conds.push(['方向', { portrait: '竖图', landscape: '横图', square: '方图' }[ori]])
  }
  if (args.recent === true) {
    spec.recent = true
    conds.push(['时间', '最近导入'])
  }
  if (args.untagged === true) {
    spec.untagged = true
    conds.push(['状态', '还没打标签'])
  }
  return { spec, conds }
}

// 完整识别的自然查询保留专名、目录和方向约束。主题等画面条件还可以通过文字或视觉补充。
function descriptiveSpec(route: RoutedQuery, tags: DictTag[]): SearchSpec {
  const spec: SearchSpec = { ...route.spec, tagGroups: [], keywordGroups: [] }
  for (const group of route.spec.tagGroups) {
    const terms = tags.filter((tag) => group.includes(tag.id))
    const words = terms.flatMap((tag) => [tag.name, ...tag.aliases].map((name) => name.toLowerCase()))
    const ears = earConditions('', words.map((word) => [word]))
    if (terms.length && (ears.length || terms.every((tag) => !['角色', '作品', '画师', '地点', '人物'].includes(tag.category)))) {
      const related = ears.flatMap((group) => group.map((type) => type.words[0] + '少女'))
      spec.keywordGroups.push([...new Set([...words, ...related])])
    } else {
      spec.tagGroups.push(group)
    }
  }
  return spec
}

// 本地已识别全部条件时，只向百炼索取画面描述和对照词，无需发送历史会话或图库资料。
async function localVisualSupplement(query: string): Promise<{ text: string; vector: NonNullable<AiSearchFilter['vector']> } | undefined> {
  if (!(await countEmbeddings(EMBEDDING_CONFIG.model))) return
  try {
    const plan = await cachedSearchValue(
      searchCacheKey('local-visual-v1', [BAILIAN_CONFIG.chatModel, query]),
      (value): value is { text: string; contrast: string[] } => !!value && typeof value === 'object' &&
        'text' in value && typeof value.text === 'string' && 'contrast' in value && Array.isArray(value.contrast),
      async () => {
        if (!getAiStatus().ready) return
        const { message } = await chatCall({
          kind: 'chat', model: BAILIAN_CONFIG.chatModel, tools: [ASSISTANT_TOOLS[0]],
          messages: [
            { role: 'system', content: '调用 search_images。semantic 只描述用户指定的画面内容，contrast 提供一至两条最容易混淆的画面，保留主体，只改变关键特征。目录、时间和标签约束已在本地处理。' },
            { role: 'user', content: query }
          ]
        })
        const call = message.tool_calls?.find((item) => item.type === 'function' && item.function.name === 'search_images')
        if (call?.type !== 'function') return
        const args = JSON.parse(call.function.arguments) as Record<string, unknown> | null
        const text = typeof args?.semantic === 'string' ? args.semantic.trim().slice(0, 100) : ''
        const contrast = contrastDescriptions(text, args?.contrast)
        if (text && contrast.length) return { text, contrast }
      }
    )
    if (!plan) return
    const vector = await semanticVector(plan.text, plan.contrast)
    if (vector) return { text: plan.text, vector }
  } catch (err) {
    log.warn('画面检索未完成，本轮保留已匹配的本地结果', err)
  }
}

// 一次回答的上下文
interface TurnContext {
  contextUsage?: AiContextUsage
  tags: Array<DictTag & { general: boolean }>
  dirs: Array<{ rootId: number; prefix: string }> | undefined
  includeR18: boolean
  userMessageId: number
  query: string
  needsDetails: boolean
  cacheablePlan?: Record<string, unknown>
  otherToolUsed?: boolean
  candidateIds?: number[]
  // 模型漏填视觉对照时只补问一次，保留原查询的全部条件。
  awaitingContrast?: Record<string, unknown>
  previousResults?: { ids: number[]; includeR18: boolean; scope: DirKeyDTO | null }
  readLibraryMetadata?: boolean
  // 最近一次检索（结果图和“怎么找的”用它）
  last: { outcome: SearchOutcome; conds: CondLabel[] } | null
  // 这次带上的记忆
  memoryIds?: number[]
}

// 执行一个工具调用，返回给模型的文字（JSON）
async function runTool(name: string, rawArgs: string, ctx: TurnContext): Promise<string> {
  if (name !== 'search_images') ctx.otherToolUsed = true
  let args: Record<string, unknown> = {}
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
  } catch {
    return JSON.stringify({ error: '参数不是合法的 JSON' })
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return JSON.stringify({ error: '工具参数应为 JSON 对象' })
  if (name === 'search_images') {
    const pending = ctx.awaitingContrast
    if (pending) args = { ...pending, contrast: args.contrast }
    const { spec, conds } = specFromArgs(args, ctx.tags, ctx.query)
    // 语义描述：有向量就按向量再找一路；查询向量失败时降级成只用关键词，不冒充语义判断
    const semanticText = typeof args.semantic === 'string' ? args.semantic.trim().slice(0, 100) : ''
    if (semanticText && !pending && !contrastDescriptions(semanticText, args.contrast).length) {
      ctx.awaitingContrast = args
      return JSON.stringify({ error: '画面检索缺少有效的 contrast。请重新调用 search_images，只补充一至两条最容易混淆的相似画面，保留原有条件。' })
    }
    ctx.awaitingContrast = undefined
    const semantic = await semanticVector(semanticText, args.contrast)
    // 即使普通图可按向量检索，画面描述也要参与本地元数据匹配，覆盖无向量和 R-18 图片。
    if (semanticText && !spec.keywordGroups.length) {
      spec.keywordGroups.push([semanticText.toLowerCase()])
      if (!semantic) conds.push(['关键词', semanticText])
    }
    const literal = spec.tagGroups.length > 0 || spec.keywordGroups.length > 0 || !!spec.requiredWords?.length || !!spec.orientation || !!spec.recent || !!spec.untagged
    if (!literal && !semantic) {
      return JSON.stringify({ error: '没有可用的检索条件，请给出标签、关键词或画面描述' })
    }
    const outcome = await runSearch(spec, ctx.dirs, ctx.includeR18, ctx.tags, semantic, ctx.query, ctx.candidateIds)
    if (ctx.last) ctx.otherToolUsed = true
    if (!semanticText || semantic) ctx.cacheablePlan = args
    ctx.last = { outcome, conds: semantic ? [...conds, ['画面', semanticText]] : conds }
    if (args.answerFromResults === true) ctx.needsDetails = true
    const brief = outcome.ordinaryIds.slice(0, BRIEF_MAX)
    const tagNames = await findTagNamesOf(brief)
    const items = await itemsOfImages(brief, false, ctx.dirs)
    return JSON.stringify({
      total: outcome.ordinaryIds.length,
      images: items.map((i) => ({ id: i.imageId, name: i.name, tags: tagNames.get(i.imageId) ?? [] })),
      ...(ctx.includeR18 ? { r18Total: outcome.imageIds.length - outcome.ordinaryIds.length } : {})
    })
  }
  if (name === 'get_image') {
    ctx.readLibraryMetadata = true
    let id = Number(args.id)
    if (args.position !== undefined) {
      const previous = ctx.previousResults
      const position = Number(args.position)
      if (!previous || !Number.isSafeInteger(position) || position < 1 || position > previous.ids.length) {
        return JSON.stringify({ error: '没有这张图' })
      }
      const visible = await visibleResultIds(previous.ids, previous.includeR18, await scopeDirs(previous.scope))
      id = previous.ids.filter((imageId) => visible.has(imageId))[position - 1]
    }
    const brief = Number.isInteger(id) ? await findImageBrief(id, { dirs: ctx.dirs }) : undefined
    if (!brief) {
      return JSON.stringify({ error: '没有这张图' })
    }
    const tagNames = await findTagNamesOf([id])
    return JSON.stringify({
      id,
      name: brief.displayName ?? brief.relPath?.split('\\').pop() ?? '',
      file: brief.relPath?.split('\\').pop() ?? '',
      size: brief.width && brief.height ? `${brief.width}×${brief.height}` : '',
      tags: tagNames.get(id) ?? [],
      description: brief.description ?? ''
    })
  }
  if (name === 'list_tags') {
    ctx.readLibraryMetadata = true
    const category = typeof args.category === 'string' ? args.category.trim() : ''
    const list = ctx.tags.filter((t) => t.general && (!category || t.category === category)).slice(0, 200)
    return JSON.stringify(list.map((t) => ({ name: t.name, category: t.category, aliases: t.aliases })))
  }
  if (name === 'remember') {
    const content = typeof args.content === 'string' ? args.content.trim().slice(0, 200) : ''
    if (!content) {
      return JSON.stringify({ error: '内容是空的' })
    }
    await insertMemory(content, 'preference', 0.9, ctx.userMessageId)
    return JSON.stringify({ ok: true })
  }
  return JSON.stringify({ error: `没有 ${name} 这个工具` })
}

// 第④层：当前时间、范围、是否包含 R-18、检索到的记忆，加上这句话
function tailOf(text: string, scope: string | null, includeR18: boolean, now: Date, memories: string[]): PromptMessage {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const memo = memories.length ? `\n[软件附注] 记得的偏好：\n${memories.map((m) => `- ${m}`).join('\n')}` : ''
  return {
    role: 'user',
    content: `[软件附注] 现在是 ${time}；在${scope ? `「${scope}」` : '全部类目录'}里找；${includeR18 ? '包含' : '不包含'} R-18。${memo}\n\n${text}`
  }
}

// 调用失败统一成“网络异常”这类可展示的错误，原始错误只进日志
function cloudError(err: unknown): BizError {
  log.warn('诺诺调用云端失败', err)
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new BizError('DEPENDENCY_FAILED', '云端拒绝了请求，请检查百炼 API Key')
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new BizError('DEPENDENCY_FAILED', '云端太忙了，等一会儿再试')
  }
  return new BizError('DEPENDENCY_FAILED', '网络异常')
}

// 对话循环：固定前缀 + 历史 + 这句话，工具往返最多几步
async function answerWithModel(
  conversation: AiConversationEntity,
  history: AiMessageEntity[],
  user: AiMessageEntity,
  ctx: TurnContext,
  scopeName: string | null,
  image?: Extract<StoredAttachment, { kind: 'image' }>
): Promise<string> {
  const past: PromptMessage[] = []
  let previousIncludeR18 = false
  let previousScope: DirKeyDTO | null = null
  for (const m of history) {
    if (m.role === 'USER') {
      const uc = m.content as UserContent
      previousIncludeR18 = uc.includeR18 === true
      previousScope = uc.scope ?? null
      past.push({ role: 'user', content: userText(uc) })
    } else if (m.role === 'ASSISTANT') {
      const c = m.content as AssistantContent
      if (c.how) ctx.previousResults = { ids: c.imageIds ?? [], includeR18: previousIncludeR18, scope: previousScope }
      past.push({ role: 'assistant', content: c.how || c.readLibraryMetadata ? '已查询图库。' : replyText(c) })
    }
  }
  const u = user.content as UserContent
  if (image) {
    const url = await prepareRatedUpload(image.dataUrl, image.originalHash)
    const fitted = fitContext(
      [{ role: 'system', content: `${NUONUO_PERSONA}\n按照用户提供的文件和本轮要求观察所附图片，回答时遵循用户指定的格式。` }],
      past,
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: userText(u) }] }]
    )
    const res = await chatCall({ kind: 'chat', model: BAILIAN_CONFIG.visionSearchModel, messages: fitted.messages, maxTokens: fitted.maxTokens })
    ctx.contextUsage = contextUsage(res.usage, fitted.inputBound, res.message)
    return (res.message.content ?? '').trim()
  }
  const profile = await profileOfConversation(conversation.profileVersion, true, new Set(ctx.tags.filter((t) => t.general).map((t) => t.name)))
  const memories = await relevantMemories(u.text)
  ctx.memoryIds = memories.map((m) => m.id)
  const tail: PromptMessage[] = [tailOf(userText(u), scopeName, u.includeR18, new Date(), memories.map((m) => m.content))]
  const [system, ...historyWithMark] = buildMessages({ rules: ASSISTANT_RULES, profile, history: past, tail: [], cache: true })
  for (let step = 0; step < MAX_STEPS; step++) {
    const fitted = fitContext([system], historyWithMark, tail, ASSISTANT_TOOLS)
    const res = await chatCall({ kind: 'chat', model: BAILIAN_CONFIG.chatModel, messages: fitted.messages, tools: ASSISTANT_TOOLS, maxTokens: fitted.maxTokens })
    ctx.contextUsage = contextUsage(res.usage, fitted.inputBound, res.message)
    const calls = res.message.tool_calls ?? []
    if (calls.length === 0) {
      const response = (res.message.content ?? '').trim()
      if (ctx.awaitingContrast) {
        await runTool('search_images', '{}', ctx)
        return localReply(ctx.last?.outcome.imageIds.length ?? 0)
      }
      // 模型偶尔直接报告命中结果。按本轮原文执行检索，禁止用模型文字作为卡片来源。
      if (!ctx.needsDetails && !ctx.last) {
        const query = requestedSearch(u.text)
        const reportsResults = /(?:找[到了出]|搜[到了出]|匹配到|检索到|共[有计])[^。\n]{0,16}(?:张|图片)|给用户看了\s*\d+\s*张图/.test(response)
        if (query || reportsResults) {
          const guidance = await runTool('search_images', JSON.stringify({ semantic: query ?? u.text }), ctx)
          if (ctx.awaitingContrast) {
            tail.push({ role: 'user', content: `[软件附注] 本轮尚未执行检索。${guidance}` })
            continue
          }
        }
      }
      return response
    }
    tail.push({ role: 'assistant', content: res.message.content ?? '', tool_calls: calls })
    for (const call of calls) {
      const fn = call.type === 'function' ? call.function : null
      const output = fn ? await runTool(fn.name, fn.arguments, ctx) : JSON.stringify({ error: '不支持的调用' })
      tail.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
    if (!ctx.needsDetails && ctx.last && calls.every((call) => call.type === 'function' && call.function.name === 'search_images')) {
      const found = ctx.last.outcome.imageIds.length
      return localReply(found)
    }
  }
  // 步数用完还在调工具：按最后一次检索给个模板回复
  if (ctx.awaitingContrast) await runTool('search_images', '{}', ctx)
  const found = ctx.last?.outcome.imageIds.length ?? 0
  return localReply(found)
}

// 回答这段对话里最后一句还没回复的话：本地能完整对上的直接查库，否则进对话循环
export async function answer(conversationId: number): Promise<AiMessageVO> {
  checkId(conversationId)
  if (answering.has(conversationId)) {
    throw new BizError('CONFLICT', '诺诺还在回上一句')
  }
  answering.add(conversationId)
  try {
    const conversation = await findConversation(conversationId)
    if (!conversation) {
      throw new BizError('NOT_FOUND', '这段对话已经不在了')
    }
    const rows = (await findMessages(conversationId)).filter((m) => m.role !== 'TOOL')
    const user = rows[rows.length - 1]
    if (!user || user.role !== 'USER') {
      throw new BizError('CONFLICT', '没有要回复的话')
    }
    const u = user.content as UserContent
    const dict = await loadDictionary()
    const dirs = await scopeDirs(u.scope)
    const scopeName = u.scope?.kind === 'category' ? u.scope.name : null
    const scopeConds: CondLabel[] = scopeName ? [['范围', scopeName]] : []

    let content: AssistantContent
    const attachments = attachmentsOf(u)
    if (attachments.length && isTokenPlanLocalMode()) throw new BizError('DEPENDENCY_FAILED', bailianUnavailableMessage('附件需要云端模型'))
    const image = attachments.find((a) => a.kind === 'image')
    const history = rows.slice(0, -1)
    const refinement = attachments.length ? undefined : followupQuery(u.text)
    const input = refinement ?? u.text
    const explicit = attachments.length ? null : routeTagRequest(input, dict.tags, dict.dirs)
    const routed = attachments.length ? null : explicit ?? routeLocally(input, dict.tags, dict.dirs)
    const query = requestedSearch(input) ?? input
    const hairCondition = !attachments.length && !explicit ? hairQuery(query) : undefined
    const previousIndex = history.findLastIndex((m) => m.role === 'ASSISTANT' && (m.content as AssistantContent).how)
    const previous = history[previousIndex]
    let recent: number[] | undefined
    if ((refinement || hairCondition) && previous && previous.createTime.getTime() > Date.now() - SEARCH_CACHE_TTL) {
      const request = history.slice(0, previousIndex).findLast((m) => m.role === 'USER')?.content as UserContent | undefined
      const ids = (previous.content as AssistantContent).imageIds ?? []
      const visible = await visibleResultIds(ids, request?.includeR18 === true, await scopeDirs(request?.scope ?? null))
      recent = ids.filter((id) => visible.has(id))
    }
    const candidateIds = refinement === undefined ? undefined : recent ?? []
    const hair = (recent || isTokenPlanLocalMode()) ? hairCondition : undefined
    if (image && attachments.length === 1) {
      // 按图找相似：先过本地分级闸门再上云算向量，在有向量的普通图里找，不调对话模型
      let imageIds: number[]
      try {
        imageIds = await searchByImage(image, dirs)
      } catch (err) {
        throw err instanceof BizError ? err : cloudError(err)
      }
      const text = localReply(imageIds.length)
      content = {
        text,
        how: `按你传的图找了相似的${scopeConds.length ? `（${scopeConds.map(([k, v]) => `${k}「${v}」`).join('，')}）` : ''}，找到 ${imageIds.length} 张`,
        imageIds
      }
    } else if (candidateIds?.length === 0) {
      content = { text: recent ? localReply(0) : '最近一天没有可继续筛选的检索结果。', how: null, imageIds: [] }
    } else if (!attachments.length && (routed || hair || requestedSearch(input)) && !await hasSearchableImage(dirs, u.includeR18)) {
      content = { text: localReply(0), how: howText(scopeConds, 0), imageIds: [] }
    } else if (hair) {
      const evidence = await followupEvidence(hair.tag, recent ?? [], dirs, candidateIds)
      const vector = evidence.unchecked.length ? await semanticVector(hair.text, hair.contrasts) : undefined
      const spec: SearchSpec = { tagGroups: [], keywordGroups: hair.keywords }
      const { imageIds } = await runSearch(spec, dirs, u.includeR18, dict.tags, vector, query, candidateIds, evidence)
      content = { imageIds, text: localReply(imageIds.length), how: howText([...scopeConds, ['画面', hair.text]], imageIds.length) }
    } else if (routed) {
      const spec = explicit ? explicit.spec : descriptiveSpec(routed, dict.tags)
      const routeDirs = dirs ?? (routed.dirs.length ? routed.dirs.map((d) => ({
        rootId: d.rootId, prefix: d.kind === 'SOURCE' ? '' : d.name
      })) : undefined)
      const supplement = spec.keywordGroups.length ? await localVisualSupplement(query) : undefined
      const { imageIds } = await runSearch(spec, routeDirs, u.includeR18, dict.tags, supplement?.vector, explicit ? '' : query, candidateIds)
      const conds = [...scopeConds, ...routed.conds.filter((c) => !(dirs && c[0] === '范围'))]
      if (supplement) conds.push(['画面', supplement.text])
      content = { text: localReply(imageIds.length), how: howText(conds, imageIds.length), imageIds }
    } else {
      const key = !refinement && await standalonePlanKey(query, u, history, dict.tags, conversation.profileVersion)
      const ctx: TurnContext = { tags: dict.tags, dirs, includeR18: u.includeR18, userMessageId: user.id, query, candidateIds, last: null, needsDetails: attachments.length > 0 }
      let text = ''
      let answered = false
      const generate = async () => {
        if (!getAiStatus().ready) {
          const ears = earConditions(query, [])
          if (isTokenPlanLocalMode() && !attachments.length && (refinement || requestedSearch(input) || ears.length)) {
            const keywordGroups = ears.length ? ears.map(earWords) : [[query.toLowerCase()]]
            const outcome = await runSearch({ tagGroups: [], keywordGroups }, dirs, u.includeR18, dict.tags, undefined, query, candidateIds)
            ctx.last = { outcome, conds: [['关键词', query]] }
            answered = true
            return
          }
          throw new BizError('DEPENDENCY_FAILED', bailianUnavailableMessage('诺诺还没连上云端'))
        }
        text = await answerWithModel(conversation, history, user, ctx, scopeName, image)
        answered = true
        return !ctx.needsDetails && !ctx.otherToolUsed ? ctx.cacheablePlan : undefined
      }
      try {
        const cached = key ? await cachedSearchValue(key, (value): value is Record<string, unknown> =>
          !!value && typeof value === 'object' && !Array.isArray(value), generate) : undefined
        if (cached && !answered) await runTool('search_images', JSON.stringify(cached), ctx)
        if (!answered && !ctx.last) await generate()
      } catch (err) {
        throw err instanceof BizError ? err : cloudError(err)
      }
      const outcome = ctx.last?.outcome
      const imageIds = outcome?.imageIds ?? []
      const found = imageIds.length
      content = {
        text: outcome && !ctx.needsDetails ? localReply(found) : text || '诺诺没想好怎么回答，换个说法再问一次吧。',
        how: ctx.last ? howText([...scopeConds, ...ctx.last.conds], found) : null,
        imageIds,
        ...(ctx.readLibraryMetadata ? { readLibraryMetadata: true } : {}),
        ...(ctx.contextUsage ? { contextUsage: ctx.contextUsage } : {}),
        memoryIds: ctx.memoryIds ?? []
      }
    }
    const saved = await insertMessage(conversationId, 'ASSISTANT', content)
    return toMessageVO(saved, await itemsOfImages(content.imageIds, u.includeR18, dirs))
  } finally {
    answering.delete(conversationId)
  }
}

// 重命名对话：去掉首尾空白，空的不改
export async function renameConversation(id: number, title: string): Promise<AiConversationVO> {
  checkId(id)
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) {
    throw new BizError('BAD_REQUEST', '名字不能是空的')
  }
  if (Array.from(name).length > AI_TITLE_MAX) {
    throw new BizError('BAD_REQUEST', `名字最多 ${AI_TITLE_MAX} 个字`)
  }
  if ((await updateConversation(id, { title: name })) === 0) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
  return toConversationVO((await findConversation(id))!)
}

// 置顶 / 取消置顶
export async function pinConversation(id: number, pinned: boolean): Promise<void> {
  checkId(id)
  if ((await updateConversation(id, { pinned: pinned === true })) === 0) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
}

// 删除对话（逻辑删除，可撤销）
export async function deleteConversation(id: number): Promise<void> {
  checkId(id)
  if (!(await findConversation(id))) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
  await updateConversation(id, { deleteState: 1 })
}

// 撤销删除对话
export async function undoDeleteConversation(id: number): Promise<void> {
  checkId(id)
  if (!(await findConversation(id, true))) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
  await updateConversation(id, { deleteState: 0 })
}

// 给回复点赞、踩，或再点一次取消
export async function voteMessage(messageId: number, vote: 'UP' | 'DOWN' | null): Promise<void> {
  checkId(messageId)
  if (vote !== 'UP' && vote !== 'DOWN' && vote !== null) {
    throw new BizError('BAD_REQUEST', '反馈不对')
  }
  const updated = await updateVote(messageId, vote)
  if (!updated) {
    throw new BizError('NOT_FOUND', '这条回复已经不在了')
  }
  // 赞和踩只当弱参考：记进事件流，做梦时调整这次用到的记忆的可信度
  if (vote) {
    await recordEvent('reply.vote', null, { vote, memoryIds: (updated.content as AssistantContent).memoryIds ?? [] })
  }
}

// 诺诺是不是正在回答（做梦时看忙不忙）
export function isAnswering(): boolean {
  return answering.size > 0
}

// 新对话的四个示例问题：从图库里非 R-18 图的角色、作品、主题、地点和目录随机拼，每次换一批
export async function suggestIdeas(random: () => number = Math.random): Promise<string[]> {
  const dict = await loadDictionary()
  const pool = (category: string): string[] => dict.tags.filter((t) => t.category === category && t.general).map((t) => t.name)
  const character = pool('角色')
  const work = pool('作品')
  const theme = pool('主题')
  const place = pool('地点')
  const dirNames = dict.dirs.map((d) => d.name)
  const any = (a: string[]): string => a[Math.floor(random() * a.length)]
  const templates: Array<[string[][], () => string]> = [
    [[character], () => `找${any(character)}的图`],
    [[work, theme], () => `${any(work)}里的${any(theme)}`],
    [[place], () => `${any(place)}拍的${any(['风景', '夜景', '照片'])}`],
    [[dirNames, theme], () => `${any(dirNames)}里的${any(theme)}`],
    [[theme], () => `最近导入的${any(theme)}`],
    [[theme], () => `${any(theme)}的图，要竖的`],
    [[character, theme], () => `${any(character)}的${any(theme)}`],
    [[work], () => `${any(work)}的图`]
  ]
  const usable = templates.filter(([need]) => need.every((p) => p.length > 0))
  for (let k = usable.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1))
    ;[usable[k], usable[j]] = [usable[j], usable[k]]
  }
  const ideas: string[] = []
  for (const [, make] of usable) {
    const t = make()
    if (ideas.length < 4 && !ideas.includes(t)) {
      ideas.push(t)
    }
  }
  return ideas
}
