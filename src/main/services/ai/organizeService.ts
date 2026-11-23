// 一键整理（设计 6.10）：先把还没看过的图看一遍，再一次纯文本调用出类目录方案，你批了方案后在本地把图分进目录。
// 结果都是“放进类目录”的建议，进“AI 建议”由你审；R-18 图不看、不分。状态记在 app_setting，退出后重开接着来
import {
  DIR_NAME_MAX,
  LOOK_KEY_HINT,
  ORGANIZE_FOLDERS_MAX,
  ORGANIZE_TERMS_MAX,
  type OrganizeEstimateVO,
  type OrganizeFolderVO,
  type OrganizeStateVO
} from '@shared/api'
import { parseAssistJson } from '@shared/assistJson'
import { BAILIAN_CONFIG, ORGANIZE_COST, bailianUnavailableMessage, isTokenPlanLocalMode, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isValidDirName } from '../../common/pathUtil'
import { findActiveSettings, upsertSettings } from '../../repositories/appSettingRepository'
import {
  countLookCandidates,
  countLookProgress,
  enqueueNewLookJobs,
  findOpenLookJobs,
  findOrganizeTerms,
  cancelBacklogJobs,
  enqueueOrganizeLooks,
  LOOK_BACKLOG_PRIORITY,
  insertOrganizeResults,
  type OrganizeTerms
} from '../../repositories/aiResultRepository'
import { countRatingCandidates } from '../../repositories/imageRepository'
import { categoryTopNames } from '../fileOps/folderOpsService'
import { isRatingBusy } from '../rating/ratingService'
import { chatCall } from './bailianClient'
import { scheduleLook } from './lookService'
import { habitLines } from './suggestionService'

const log = getLogger('organize')

// 状态在设置表里的键（settingsService 跳过 ai. 开头的键）
const STATE_KEY = 'ai.organize'
// 这次整理从什么时候开始排看图（算看图进度用）
const LOOK_FROM_KEY = 'ai.organizeLookFrom'
// 新建目录最多几个；交给模型的词每类最多几个
const NEW_FOLDERS_MAX = 12
const STAT_LIMITS = { characters: 40, works: 30, tags: 60 } as const
// 出方案的超时
const PLAN_TIMEOUT_MS = 120_000

// 一键整理需要的外部信息
export interface OrganizeConfig {
  // 状态变了：推给界面
  onState: (state: OrganizeStateVO) => void
  // 有新建议了：界面刷新“AI 建议”
  onSuggested: () => void
}

let config: OrganizeConfig | null = null
let state: OrganizeStateVO = { phase: 'IDLE', plan: null, error: null }
let starting = false
let planning: OrganizeStateVO | null = null
let lookFrom: Date | null = null

// 配置（启动时调一次）
export function configureOrganize(next: OrganizeConfig): void {
  config = next
}

// 当前状态
export function getOrganizeState(): OrganizeStateVO {
  return state
}

// 耗时的整理阶段优先处理，自动扫描等到整理结束或方案待确认。
export function isOrganizing(): boolean {
  return state.phase !== 'IDLE' && state.phase !== 'PLAN_READY'
}

// 改状态：存库并推给界面
async function setState(next: OrganizeStateVO): Promise<void> {
  state = next
  await upsertSettings([{ key: STATE_KEY, value: next }])
  if (state === next) {
    config?.onState(next)
  }
}

// 在窗口和自动扫描启动前恢复状态，让界面从上次进度开始显示。
export async function restoreOrganize(): Promise<void> {
  const rows = await findActiveSettings()
  const row = rows.find((s) => s.key === STATE_KEY)
  const saved = row?.value as OrganizeStateVO | undefined
  const from = rows.find((s) => s.key === LOOK_FROM_KEY)?.value
  lookFrom = typeof from === 'string' && !Number.isNaN(new Date(from).getTime()) ? new Date(from) : null
  if (saved && typeof saved === 'object' && typeof saved.phase === 'string') {
    state = { phase: saved.phase, plan: saved.plan ?? null, error: saved.error ?? null }
    config?.onState(state)
  }
  if (state.phase === 'LOOKING') {
    await refreshLooked()
  }
}

// 看图队列恢复后继续原来的阶段。
export async function resumeOrganize(): Promise<void> {
  if (isTokenPlanLocalMode() && state.phase !== 'ASSIGNING') return
  if (state.phase === 'ASSIGNING') {
    if (state.plan) {
      await applyApprovedPlan(state.plan)
    } else {
      await setState({ phase: 'IDLE', plan: null, error: null })
    }
  } else if (state.phase === 'PLANNING') {
    void makePlan()
  } else if (state.phase === 'LOOKING') {
    await checkLooking()
  } else if (state.phase === 'FOLLOWING') {
    await onRatingBatch()
  }
}

// 开始前的估算：要看多少张、大概多少 token 和钱；ratingLeft 是本地分级还剩几张（大于 0 时界面不让开始）
export async function estimateOrganize(): Promise<OrganizeEstimateVO> {
  const toLook = await countLookCandidates(new Date(0), true)
  const ratingLeft = await countRatingCandidates()
  const realtime = Math.min(toLook, ORGANIZE_COST.realtimeMax)
  const yuan = realtime * ORGANIZE_COST.realtimeYuanPerImage + (toLook - realtime + ratingLeft) * ORGANIZE_COST.batchYuanPerImage
  return { toLook, tokens: (toLook + ratingLeft) * ORGANIZE_COST.tokensPerImage, yuan: Math.round(yuan * 100) / 100, ratingLeft }
}

// 开始：还没看过的图都排进看图队列（包括看图上线前的老图），看完自动出方案；没有要看的直接出方案。
// 方案出错后再点一次就是重试
export async function startOrganize(): Promise<OrganizeStateVO> {
  if (!readCloudCredentials().dashscopeApiKey) {
    throw new BizError('DEPENDENCY_FAILED', bailianUnavailableMessage(LOOK_KEY_HINT))
  }
  if (state.phase === 'PLAN_READY' && !state.plan) {
    void makePlan()
    return state
  }
  if (state.phase !== 'IDLE' || starting) {
    throw new BizError('CONFLICT', '一键整理已经在进行了')
  }
  starting = true
  try {
    const ratingLeft = await countRatingCandidates()
    if (isRatingBusy() || ratingLeft > 0) {
      throw new BizError('CONFLICT', ratingLeft > 0 ? `本地分级还剩 ${ratingLeft.toLocaleString('zh-CN')} 张，判完才能整理` : '本地分级还在进行，判完才能整理')
    }
    const from = new Date()
    const next: OrganizeStateVO = { phase: 'LOOKING', plan: null, error: null }
    const enqueued = await enqueueOrganizeLooks([{ key: LOOK_FROM_KEY, value: from.toISOString() }, { key: STATE_KEY, value: next }])
    lookFrom = from
    state = next
    if (enqueued > 0) {
      log.info(`一键整理：排进 ${enqueued} 张看图`)
    }
    config?.onState(state)
    scheduleLook()
    await checkLooking()
    return state
  } finally {
    starting = false
  }
}

// 看图队列变了时调用：整理在等看图、队列里已经没有排队和进行中的（出错的不等），就出方案
export async function checkLooking(): Promise<void> {
  if (isTokenPlanLocalMode()) return
  if (state.phase === 'FOLLOWING') {
    await maybeFinish()
    return
  }
  if (state.phase !== 'LOOKING') {
    return
  }
  await refreshLooked()
  const from = lookFrom
  const open = await findOpenLookJobs()
  if (state.phase !== 'LOOKING' || lookFrom !== from || open.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING')) {
    return
  }
  void makePlan()
}

// 看图进度变了就推给界面（只推不存，重开时从队列重新算）
async function refreshLooked(): Promise<void> {
  if (!lookFrom) {
    // 老版本开始的整理没记开始时间：用还没看完的里最早排进来的那张
    const first = (await findOpenLookJobs()).filter((j) => j.status !== 'FAILED').sort((a, b) => a.createTime.getTime() - b.createTime.getTime())[0]
    if (!first) {
      return
    }
    lookFrom = first.createTime
    await upsertSettings([{ key: LOOK_FROM_KEY, value: lookFrom.toISOString() }])
  }
  const looked = await countLookProgress(lookFrom)
  if (state.phase !== 'LOOKING' || (state.looked?.done === looked.done && state.looked?.total === looked.total)) {
    return
  }
  state = { ...state, looked }
  config?.onState(state)
}

// 取消：回到空闲（已经交出去的看完为止，还没交的补图取消，已经生成的建议留着）
export async function cancelOrganize(): Promise<OrganizeStateVO> {
  if (state.phase === 'ASSIGNING') {
    throw new BizError('CONFLICT', '正在生成分图建议，请稍候')
  }
  const following = state.phase === 'FOLLOWING'
  await setState({ phase: 'IDLE', plan: null, error: null })
  if (following) {
    await cancelBacklogJobs()
  }
  return state
}

// ===== 方案已批后陆续补图 =====

// 分级每判完一小批：判完、过了闸门、还没看过的老图按半价排进看图（只走批量）
export async function onRatingBatch(): Promise<void> {
  if (isTokenPlanLocalMode()) return
  if (state.phase !== 'FOLLOWING') {
    return
  }
  const count = await enqueueNewLookJobs(new Date(0), 1_000_000, LOOK_BACKLOG_PRIORITY)
  if (count > 0) {
    log.info(`一键整理补图：排进 ${count} 张（批量）`)
  }
  scheduleLook()
  await maybeFinish()
}

let assignTimer: ReturnType<typeof setTimeout> | null = null

// 有新的看图结果：攒几秒再按方案分一次（批量结果一次回来很多条）
export function onLookResult(): void {
  if (state.phase !== 'FOLLOWING' || assignTimer) {
    return
  }
  assignTimer = setTimeout(() => {
    assignTimer = null
    void assignWithPlan()
      .then(maybeFinish)
      .catch((err: unknown) => log.error('一键整理补图分图失败', err))
  }, 5_000)
}

// 按批过的方案把新看完的图分进类目录（只分还没有这类建议、还不在类目录里的）
async function assignWithPlan(): Promise<number> {
  if (state.phase !== 'FOLLOWING' || !state.plan) {
    return 0
  }
  const n = await insertOrganizeResults(assignFolders(await findOrganizeTerms(), state.plan), BAILIAN_CONFIG.chatModel)
  if (n > 0) {
    log.info(`一键整理补图：又分了 ${n} 张`)
    config?.onSuggested()
  }
  return n
}

// 分级全判完、看图队列里也没有排着和进行中的了：最后分一次，收尾
async function maybeFinish(): Promise<void> {
  if (state.phase !== 'FOLLOWING' || isRatingBusy() || (await countRatingCandidates()) > 0) {
    return
  }
  if ((await findOpenLookJobs()).some((j) => j.status === 'QUEUED' || j.status === 'RUNNING')) {
    return
  }
  await assignWithPlan()
  await setState({ phase: 'IDLE', plan: null, error: null })
  log.info('一键整理补图做完了')
}

// 统计每类词在待整理的图里出现几次，取最多的若干个
function topTerms(all: OrganizeTerms[], pick: (t: OrganizeTerms) => string[], limit: number): Array<[string, number]> {
  const count = new Map<string, number>()
  for (const t of all) {
    for (const w of pick(t)) {
      count.set(w, (count.get(w) ?? 0) + 1)
    }
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

// 出方案的提示词
function planPrompt(existing: string[], total: number, stats: Record<'characters' | 'works' | 'tags', Array<[string, number]>>, habits: string[]): string {
  const line = (label: string, list: Array<[string, number]>): string => `- ${label}：${list.length ? list.map(([w, n]) => `${w}(${n})`).join('、') : '无'}`
  return [
    '你在帮我整理本地图库的“类目录”：类目录是图库里按类别分好的文件夹，每张图会复制一份放进最合适的一个类目录。',
    '',
    '## 现有的类目录',
    existing.length ? existing.map((n) => `- ${n}`).join('\n') : '还没有',
    '',
    `## 待整理的 ${total} 张图里出现的词（括号里是张数）`,
    line('角色', stats.characters),
    line('作品', stats.works),
    line('标签', stats.tags),
    '',
    '## 我的整理习惯',
    ...habits,
    '',
    '## 要求',
    '- 设计一套类目录，让这些图分门别类；能沿用现有类目录的就沿用，名字写得和现有的一模一样。',
    `- 新建的目录最多 ${NEW_FOLDERS_MAX} 个；目录名用中文，最多 ${DIR_NAME_MAX} 个字，不能有 \\ / : * ? " < > | 这些字符。`,
    '- 每个目录列出它收哪些角色、作品、标签：只能从上面列出的词里选，原样照抄（不要带括号里的张数），一个词只能放进一个目录。',
    '- 太零散、凑不成一类的词不用管；不要为了凑数建只收一两张图的目录。',
    '- 只输出下面格式的一个 json 代码块，代码块前后不要写别的。',
    '',
    '```json',
    '{"folders":[{"name":"","characters":[],"works":[],"tags":[]}]}',
    '```'
  ].join('\n')
}

// 整理模型给的方案：名字合法、去重；词只留给过它的、每个词只进第一个目录；没有词的目录去掉；新建的最多 12 个
export function sanitizePlan(raw: unknown, allowed: Set<string>, existing: string[]): OrganizeFolderVO[] {
  const folders = raw && typeof raw === 'object' && Array.isArray((raw as { folders?: unknown }).folders) ? (raw as { folders: unknown[] }).folders : []
  const existingLow = new Map(existing.map((n) => [n.toLowerCase(), n]))
  const used = new Set<string>()
  const names = new Set<string>()
  const out: OrganizeFolderVO[] = []
  let created = 0
  const terms = (v: unknown): string[] => {
    const list: string[] = []
    for (const w of Array.isArray(v) ? v : []) {
      // 模型常把张数一起抄过来（“表情包(3)”），去掉
      const s = typeof w === 'string' ? w.trim().replace(/\s*[(（]\d+[)）]$/, '') : ''
      if (s && allowed.has(s) && !used.has(s.toLowerCase()) && list.length < ORGANIZE_TERMS_MAX) {
        used.add(s.toLowerCase())
        list.push(s)
      }
    }
    return list
  }
  for (const f of folders) {
    if (!f || typeof f !== 'object' || out.length >= ORGANIZE_FOLDERS_MAX) {
      continue
    }
    const o = f as Record<string, unknown>
    let name = typeof o.name === 'string' ? Array.from(o.name.trim()).slice(0, DIR_NAME_MAX).join('').trim() : ''
    name = existingLow.get(name.toLowerCase()) ?? name
    if (!isValidDirName(name) || names.has(name.toLowerCase())) {
      continue
    }
    const isNew = !existingLow.has(name.toLowerCase())
    if (isNew && created >= NEW_FOLDERS_MAX) {
      continue
    }
    const folder: OrganizeFolderVO = { name, isNew, characters: terms(o.characters), works: terms(o.works), tags: terms(o.tags) }
    if (folder.characters.length + folder.works.length + folder.tags.length === 0) {
      continue
    }
    names.add(name.toLowerCase())
    created += isNew ? 1 : 0
    out.push(folder)
  }
  return out
}

// 出方案：一次纯文本调用（flash、关思考、只调一次不打缓存标记）；失败时留在“方案待确认”并带上原因，可以重试
async function makePlan(): Promise<void> {
  if (planning === state) {
    return
  }
  const current: OrganizeStateVO = { phase: 'PLANNING', plan: null, error: null }
  planning = current
  try {
    await setState(current)
    const all = await findOrganizeTerms()
    const existing = await categoryTopNames()
    const stats = {
      characters: topTerms(all, (t) => t.characters, STAT_LIMITS.characters),
      works: topTerms(all, (t) => t.works, STAT_LIMITS.works),
      tags: topTerms(all, (t) => t.tags, STAT_LIMITS.tags)
    }
    const allowed = new Set([...stats.characters, ...stats.works, ...stats.tags].map(([w]) => w))
    const habits = allowed.size ? await habitLines() : []
    if (state !== current) {
      return
    }
    if (allowed.size === 0) {
      await setState({ phase: 'PLAN_READY', plan: null, error: '没有能用来分类的标签和建议，先让诺诺看看图或打几个标签' })
      return
    }
    const res = await chatCall({
      kind: 'organize',
      model: BAILIAN_CONFIG.chatModel,
      messages: [{ role: 'user', content: planPrompt(existing, all.length, stats, habits) }],
      timeoutMs: PLAN_TIMEOUT_MS
    })
    if (state !== current) {
      return
    }
    const text = String(res.message.content ?? '')
    const plan = sanitizePlan(parseAssistJson(text), allowed, existing)
    if (plan.length === 0) {
      // 只有目录名和标签词，不含图片内容，记下来方便查为什么用不了
      log.warn(`一键整理方案用不了：${text.slice(0, 600)}`)
    }
    await setState(plan.length ? { phase: 'PLAN_READY', plan, error: null } : { phase: 'PLAN_READY', plan: null, error: '诺诺没给出能用的方案，再试一次' })
  } catch (err) {
    if (state === current) {
      log.warn('一键整理出方案失败', err)
      await setState({ phase: 'PLAN_READY', plan: null, error: '出方案时出现错误，再试一次' })
    }
  } finally {
    if (planning === current) {
      planning = null
    }
  }
}

// 校验你批过的方案（可能改了名字、去掉了目录或词）
function checkPlan(raw: unknown, existing: string[]): OrganizeFolderVO[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORGANIZE_FOLDERS_MAX) {
    throw new BizError('BAD_REQUEST', '方案不对')
  }
  const existingLow = new Set(existing.map((n) => n.toLowerCase()))
  const names = new Set<string>()
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map((w) => w.trim()).slice(0, ORGANIZE_TERMS_MAX) : []
  return raw.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!isValidDirName(name) || Array.from(name).length > DIR_NAME_MAX) {
      throw new BizError('BAD_REQUEST', `目录名「${name}」不能用：最多 ${DIR_NAME_MAX} 个字，不能有 \\ / : * ? " < > |`)
    }
    if (names.has(name.toLowerCase())) {
      throw new BizError('BAD_REQUEST', `目录「${name}」重复了`)
    }
    names.add(name.toLowerCase())
    return { name, isNew: !existingLow.has(name.toLowerCase()), characters: list(o.characters), works: list(o.works), tags: list(o.tags) }
  })
}

// 本地分图：角色优先、其次作品、再次标签，按方案里目录的顺序取第一个对上的；对不上的不管
export function assignFolders(all: OrganizeTerms[], plan: OrganizeFolderVO[]): Array<{ imageId: number; dir: string }> {
  const index = (pick: (f: OrganizeFolderVO) => string[]): Map<string, string> => {
    const m = new Map<string, string>()
    for (const f of plan) {
      for (const w of pick(f)) {
        if (!m.has(w.toLowerCase())) {
          m.set(w.toLowerCase(), f.name)
        }
      }
    }
    return m
  }
  const byWho = index((f) => f.characters)
  const byWork = index((f) => f.works)
  const byTag = index((f) => f.tags)
  const out: Array<{ imageId: number; dir: string }> = []
  for (const t of all) {
    const hit = (words: string[], m: Map<string, string>): string | undefined => words.map((w) => m.get(w.toLowerCase())).find(Boolean)
    const dir = hit(t.characters, byWho) ?? hit(t.works, byWork) ?? hit(t.tags, byTag)
    if (dir) {
      out.push({ imageId: t.imageId, dir })
    }
  }
  return out
}

// 按你批过的方案分图，生成“放进类目录”的建议；返回生成了多少条
export async function approveOrganize(rawPlan: unknown): Promise<number> {
  if (state.phase !== 'PLAN_READY') {
    throw new BizError('CONFLICT', '现在没有待确认的方案')
  }
  const plan = checkPlan(rawPlan, await categoryTopNames())
  await setState({ phase: 'ASSIGNING', plan, error: null })
  return applyApprovedPlan(plan)
}

// 已生成的建议会被数据库查询排除，退出后可接着给剩余图片生成建议。
async function applyApprovedPlan(plan: OrganizeFolderVO[]): Promise<number> {
  let n = 0
  try {
    n = await insertOrganizeResults(assignFolders(await findOrganizeTerms(), plan), BAILIAN_CONFIG.chatModel)
    log.info(`一键整理：生成 ${n} 条放进类目录的建议`)
    if (n > 0) {
      config?.onSuggested()
    }
  } catch (err) {
    await setState({ phase: 'IDLE', plan: null, error: null })
    throw err
  }
  // 记住批过的方案：本地分级后判完的、还在看的图，之后陆续按它分；都做完了自己收尾
  await setState({ phase: 'FOLLOWING', plan, error: null })
  await onRatingBatch()
  return n
}
