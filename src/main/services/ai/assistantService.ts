import OpenAI from 'openai'
import {
  AI_TEXT_MAX,
  AI_TITLE_MAX,
  type AiAskDTO,
  type AiAskResultVO,
  type AiConversationVO,
  type AiMessageVO,
  type AiStatusVO,
  type DirKeyDTO
} from '@shared/api'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
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
import { findDirNames, findImageBrief, findTagNamesOf, findVocabulary, searchImages } from '../../repositories/aiSearchRepository'
import { findActiveRootsByKind } from '../../repositories/libraryRootRepository'
import { findCategories } from '../../repositories/tagRepository'
import { itemsOfImages, RECENT_DAYS } from '../galleryService'
import { ASSISTANT_RULES, ASSISTANT_TOOLS } from './assistantPrompt'
import { chatCall } from './bailianClient'
import { routeLocally, type CondLabel, type DictDir, type DictTag, type SearchSpec } from './localRouter'
import { ensureProfile, profileOfConversation } from './profileService'
import { buildMessages, type PromptMessage } from './promptPrefix'

const log = getLogger('ai')

// 一次回复里最多显示几张图
const SHOW_MAX = 12
// 给模型看的结果最多几张
const BRIEF_MAX = 8
// 一次回答最多调几次模型（含工具往返）
const MAX_STEPS = 4

// 存在库里的“你说的话”
interface UserContent {
  text: string
  scope: DirKeyDTO | null
  includeR18: boolean
}

// 存在库里的“诺诺的回复”；llm 是下一轮当作历史发给模型的文字（不含 R-18 图的任何信息）
interface AssistantContent {
  text: string
  how: string | null
  imageIds: number[]
  llm: string
}

// 一次检索的结果：普通图（模型能看到）和 R-18 图（只在本地查，模型只知道数量）
interface SearchOutcome {
  ids: number[]
  total: number
  r18Ids: number[]
  r18Total: number
}

// 正在回答的对话（同一段对话不并发回答）
const answering = new Set<number>()

// 诺诺能不能用：只看有没有配置 DASHSCOPE_API_KEY
export function getAiStatus(): AiStatusVO {
  return { ready: !!readCloudCredentials().dashscopeApiKey }
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
async function toMessageVO(m: AiMessageEntity): Promise<AiMessageVO> {
  const base = { id: m.id, vote: m.vote ?? null, createdAt: m.createTime.toISOString() }
  if (m.role === 'USER') {
    const c = m.content as UserContent
    return { ...base, role: 'user', text: c.text, how: null, images: [] }
  }
  const c = m.content as AssistantContent
  return { ...base, role: 'assistant', text: c.text, how: c.how, images: await itemsOfImages(c.imageIds ?? []) }
}

// 一段对话的消息（工具往返不存，只有你说的和诺诺的回复）
export async function listMessages(conversationId: number): Promise<AiMessageVO[]> {
  checkId(conversationId)
  if (!(await findConversation(conversationId))) {
    throw new BizError('NOT_FOUND', '这段对话已经不在了')
  }
  const rows = await findMessages(conversationId)
  return Promise.all(rows.filter((m) => m.role !== 'TOOL').map(toMessageVO))
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
  if (s.kind === 'source' && Number.isInteger(s.id)) {
    return { kind: 'source', id: s.id }
  }
  if (s.kind === 'category' && typeof s.name === 'string' && s.name && !/[\\/]/.test(s.name)) {
    return { kind: 'category', name: s.name }
  }
  throw new BizError('BAD_REQUEST', '范围不对')
}

// 问诺诺：先存下这句话（没有对话就新开一段，用问题开头当名字），回复由 answer 另外生成
export async function ask(dto: AiAskDTO): Promise<AiAskResultVO> {
  const text = typeof dto?.text === 'string' ? dto.text.trim() : ''
  if (!text) {
    throw new BizError('BAD_REQUEST', '说点什么吧')
  }
  if (Array.from(text).length > AI_TEXT_MAX) {
    throw new BizError('BAD_REQUEST', `一次最多 ${AI_TEXT_MAX} 个字`)
  }
  const content: UserContent = { text, scope: checkScope(dto.scope), includeR18: dto.includeR18 === true }
  let conversation: (AiConversationEntity & { lastAt: Date }) | undefined
  if (dto.conversationId === null || dto.conversationId === undefined) {
    // 新对话锁定当前的核心档案版本，这段对话里前缀不变
    const profile = await ensureProfile()
    const created = await insertConversation(Array.from(text).slice(0, 14).join(''), profile.version)
    conversation = { ...created, lastAt: created.createTime }
  } else {
    checkId(dto.conversationId)
    conversation = await findConversation(dto.conversationId)
    if (!conversation) {
      throw new BizError('NOT_FOUND', '这段对话已经不在了')
    }
  }
  const message = await insertMessage(conversation.id, 'USER', content)
  return { conversation: { ...toConversationVO(conversation), updatedAt: message.createTime.toISOString() }, message: await toMessageVO(message) }
}

// 词典：标签（含分类名、别名）和目录名
async function loadDictionary(): Promise<{ tags: DictTag[]; dirs: DictDir[] }> {
  const [vocab, categories, dirs] = await Promise.all([findVocabulary(), findCategories(), findDirNames()])
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  return {
    tags: vocab.map((t) => ({ id: t.id, name: t.name, aliases: t.aliases, category: catName.get(t.categoryId) ?? '标签' })),
    dirs
  }
}

// “在哪里找”换成检索用的目录条件
async function scopeDirs(scope: DirKeyDTO | null): Promise<Array<{ rootId: number; prefix: string }> | undefined> {
  if (!scope) {
    return undefined
  }
  if (scope.kind === 'source') {
    return [{ rootId: scope.id, prefix: '' }]
  }
  const [catRoot] = await findActiveRootsByKind('CATEGORY')
  return [{ rootId: catRoot?.id ?? -1, prefix: scope.name }]
}

// 范围的显示名
async function scopeLabel(scope: DirKeyDTO | null, dirs: DictDir[]): Promise<string | null> {
  if (!scope) {
    return null
  }
  if (scope.kind === 'category') {
    return scope.name
  }
  return dirs.find((d) => d.kind === 'SOURCE' && d.rootId === scope.id)?.name ?? null
}

// 执行一次检索：普通图按条件查；打开 R-18 时 R-18 图用同样的条件另查一路（只在本地）
async function runSearch(spec: SearchSpec, dirs: Array<{ rootId: number; prefix: string }> | undefined, includeR18: boolean): Promise<SearchOutcome> {
  const base = {
    tagGroups: spec.tagGroups,
    keywords: spec.keywords.map((k) => k.toLowerCase()).filter(Boolean),
    orientation: spec.orientation,
    recentDays: spec.recent ? RECENT_DAYS : undefined,
    untagged: spec.untagged,
    dirs,
    limit: SHOW_MAX
  }
  const normal = await searchImages({ ...base, r18: 'exclude' })
  const r18 = includeR18 ? await searchImages({ ...base, r18: 'only' }) : { ids: [], total: 0 }
  return { ids: normal.ids, total: normal.total, r18Ids: r18.ids, r18Total: r18.total }
}

// “怎么找的”那行字：不用“·”，条件之间用逗号
function howText(conds: CondLabel[], found: number): string {
  const parts = conds.map(([k, v]) => `${k}「${v}」`).join('，')
  return parts ? `搜索了图库：${parts}，找到 ${found} 张` : `搜索了图库，找到 ${found} 张`
}

// 下一轮发给模型的历史文字：回复正文加上给用户看了哪些图（只列普通图）
async function historyText(text: string, ids: number[]): Promise<string> {
  if (ids.length === 0) {
    return text
  }
  const names = (await itemsOfImages(ids.slice(0, BRIEF_MAX))).map((i) => `#${i.imageId}「${i.name}」`).join('、')
  return `${text}\n（给用户看了 ${ids.length} 张图：${names}）`
}

// 本地能完整回答的：模板回复
function localReply(found: number, includeR18: boolean, conds: CondLabel[]): string {
  if (found === 0) {
    const what = conds.map(([, v]) => v).join('、')
    return `没找到${what ? `带“${what}”的` : '对得上的'}图。可以换个说法，或者少说一个条件试试。`
  }
  return `找到 ${found} 张。${includeR18 ? '' : '没有算上 R-18 图。'}`
}

// 模型给的检索参数换成检索条件：每个词先按标签名和别名对，对不上的当关键词
function specFromArgs(args: Record<string, unknown>, tags: DictTag[]): { spec: SearchSpec; conds: CondLabel[] } {
  const spec: SearchSpec = { tagGroups: [], keywords: [] }
  const conds: CondLabel[] = []
  const byName = new Map<string, DictTag>()
  for (const t of tags) {
    for (const n of [t.name, ...t.aliases]) {
      byName.set(n.toLowerCase(), t)
    }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 30) : '')
  // 结构化字段：对上标签就按标签查（都要满足）；对不上的放进关键词（任一）
  const loose: string[] = []
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
    } else if (!spec.keywords.includes(word.toLowerCase())) {
      spec.keywords.push(word.toLowerCase())
      loose.push(word)
    }
  }
  addWord(str(args.character), '角色')
  addWord(str(args.work), '作品')
  addWord(str(args.place), '地点')
  for (const w of Array.isArray(args.tags) ? args.tags.slice(0, 5) : []) {
    addWord(str(w), '标签')
  }
  for (const w of Array.isArray(args.keywords) ? args.keywords.slice(0, 5) : []) {
    addWord(str(w), '关键词')
  }
  if (loose.length > 0) {
    conds.push(['关键词', loose.join('、')])
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

// 一次回答的上下文
interface TurnContext {
  tags: DictTag[]
  dirs: Array<{ rootId: number; prefix: string }> | undefined
  includeR18: boolean
  userMessageId: number
  // 最近一次检索（结果图和“怎么找的”用它）
  last: { outcome: SearchOutcome; conds: CondLabel[] } | null
}

// 执行一个工具调用，返回给模型的文字（JSON）
async function runTool(name: string, rawArgs: string, ctx: TurnContext): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
  } catch {
    return JSON.stringify({ error: '参数不是合法的 JSON' })
  }
  if (name === 'search_images') {
    const { spec, conds } = specFromArgs(args, ctx.tags)
    if (spec.tagGroups.length === 0 && spec.keywords.length === 0 && !spec.orientation && !spec.recent && !spec.untagged) {
      return JSON.stringify({ error: '没有可用的检索条件；semantic 现在不参与检索，请给出标签或关键词' })
    }
    const outcome = await runSearch(spec, ctx.dirs, ctx.includeR18)
    ctx.last = { outcome, conds }
    const brief = outcome.ids.slice(0, BRIEF_MAX)
    const tagNames = await findTagNamesOf(brief)
    const items = await itemsOfImages(brief)
    return JSON.stringify({
      total: outcome.total,
      images: items.map((i) => ({ id: i.imageId, name: i.name, tags: tagNames.get(i.imageId) ?? [] })),
      ...(ctx.includeR18 ? { r18Total: outcome.r18Total } : {})
    })
  }
  if (name === 'get_image') {
    const id = Number(args.id)
    const brief = Number.isInteger(id) ? await findImageBrief(id) : undefined
    if (!brief) {
      return JSON.stringify({ error: '没有这张图' })
    }
    if (brief.isR18) {
      return JSON.stringify({ id, r18: true })
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
    const category = typeof args.category === 'string' ? args.category.trim() : ''
    const list = ctx.tags.filter((t) => !category || t.category === category).slice(0, 200)
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

// 第④层：当前时间、范围、是否包含 R-18，加上这句话
function tailOf(text: string, scope: string | null, includeR18: boolean, now: Date): PromptMessage {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return {
    role: 'user',
    content: `[软件附注] 现在是 ${time}；在${scope ? `「${scope}」` : '全部图库'}里找；${includeR18 ? '包含' : '不包含'} R-18。\n\n${text}`
  }
}

// 调用失败统一成“网络异常”这类可展示的错误，原始错误只进日志
function cloudError(err: unknown): BizError {
  log.warn('诺诺调用云端失败', err)
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new BizError('DEPENDENCY_FAILED', '云端拒绝了请求，检查一下 DASHSCOPE_API_KEY')
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
  scopeName: string | null
): Promise<string> {
  const profile = await profileOfConversation(conversation.profileVersion)
  const past: PromptMessage[] = []
  for (const m of history) {
    if (m.role === 'USER') {
      past.push({ role: 'user', content: (m.content as UserContent).text })
    } else if (m.role === 'ASSISTANT') {
      past.push({ role: 'assistant', content: (m.content as AssistantContent).llm })
    }
  }
  const u = user.content as UserContent
  const tail: PromptMessage[] = [tailOf(u.text, scopeName, u.includeR18, new Date())]
  for (let step = 0; step < MAX_STEPS; step++) {
    const messages = buildMessages({ rules: ASSISTANT_RULES, profile, history: past, tail, cache: true })
    const res = await chatCall({ kind: 'chat', model: BAILIAN_CONFIG.chatModel, messages, tools: ASSISTANT_TOOLS })
    const calls = res.message.tool_calls ?? []
    if (calls.length === 0) {
      return (res.message.content ?? '').trim()
    }
    tail.push({ role: 'assistant', content: res.message.content ?? '', tool_calls: calls })
    for (const call of calls) {
      const fn = call.type === 'function' ? call.function : null
      const output = fn ? await runTool(fn.name, fn.arguments, ctx) : JSON.stringify({ error: '不支持的调用' })
      tail.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }
  // 步数用完还在调工具：按最后一次检索给个模板回复
  const found = (ctx.last?.outcome.total ?? 0) + (ctx.last?.outcome.r18Total ?? 0)
  return localReply(found, ctx.includeR18, ctx.last?.conds ?? [])
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
    const scopeName = await scopeLabel(u.scope, dict.dirs)
    const scopeConds: CondLabel[] = scopeName ? [['范围', scopeName]] : []

    let content: AssistantContent
    const routed = routeLocally(u.text, dict.tags, dict.dirs)
    if (routed) {
      // 输入框选了范围就以输入框为准；没选时用问题里点到的目录（点到几个就在其中任一里找）
      const routeDirs =
        dirs ??
        (routed.dirs.length > 0 ? routed.dirs.map((d) => ({ rootId: d.rootId, prefix: d.kind === 'SOURCE' ? '' : d.name })) : undefined)
      const outcome = await runSearch(routed.spec, routeDirs, u.includeR18)
      const found = outcome.total + outcome.r18Total
      const text = localReply(found, u.includeR18, routed.conds)
      const imageIds = [...outcome.ids, ...outcome.r18Ids].slice(0, SHOW_MAX)
      content = { text, how: howText([...scopeConds, ...routed.conds.filter((c) => !(dirs && c[0] === '范围'))], found), imageIds, llm: await historyText(text, outcome.ids) }
    } else {
      if (!getAiStatus().ready) {
        throw new BizError('DEPENDENCY_FAILED', '诺诺还没连上云端')
      }
      const ctx: TurnContext = { tags: dict.tags, dirs, includeR18: u.includeR18, userMessageId: user.id, last: null }
      let text: string
      try {
        text = await answerWithModel(conversation, rows.slice(0, -1), user, ctx, scopeName)
      } catch (err) {
        throw err instanceof BizError ? err : cloudError(err)
      }
      const outcome = ctx.last?.outcome
      const found = outcome ? outcome.total + outcome.r18Total : 0
      const imageIds = outcome ? [...outcome.ids, ...outcome.r18Ids].slice(0, SHOW_MAX) : []
      content = {
        text: text || '诺诺没想好怎么回答，换个说法再问一次吧。',
        how: ctx.last ? howText([...scopeConds, ...ctx.last.conds], found) : null,
        imageIds,
        llm: await historyText(text, outcome?.ids ?? [])
      }
    }
    const saved = await insertMessage(conversationId, 'ASSISTANT', content)
    return toMessageVO(saved)
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
  if ((await updateVote(messageId, vote)) === 0) {
    throw new BizError('NOT_FOUND', '这条回复已经不在了')
  }
}

// 新对话的四个示例问题：从图库里非 R-18 图的角色、作品、主题、地点和目录随机拼，每次换一批
export async function suggestIdeas(random: () => number = Math.random): Promise<string[]> {
  const dict = await loadDictionary()
  const vocab = await findVocabulary()
  const general = new Set(vocab.filter((t) => t.general).map((t) => t.id))
  const pool = (category: string): string[] => dict.tags.filter((t) => t.category === category && general.has(t.id)).map((t) => t.name)
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
