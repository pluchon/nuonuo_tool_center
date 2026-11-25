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
import { BAILIAN_CONFIG, ORGANIZE_COST, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isValidDirName } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import { getWorkflow, upsertWorkflow } from '../../repositories/aiWorkflowRepository'
import { findActiveSettings, readSetting, writeSettings } from '../../repositories/appSettingRepository'
import {
  countOrganizeEstimate,
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
import { categoryPaths } from '../fileOps/folderOpsService'
import { categoryPathIndex } from '../fileOps/categoryPaths'
import { recordLocalReuse } from '../../repositories/aiSearchCacheRepository'
import { isRatingBusy } from '../rating/ratingService'
import { chatCall } from './bailianClient'
import { scheduleLook } from './lookService'
import { habitLines } from './suggestionService'

const log = getLogger('organize')

// 旧版设置键（用于首次启动时从 app_setting 平滑迁移到 ai_workflow）
const LEGACY_STATE_KEY = 'ai.organize'
const RULES_KEY = 'ai.organize.rules'
const LEGACY_LOOK_FROM_KEY = 'ai.organizeLookFrom'
// 新建目录最多几个；交给模型的词每类最多几个
const NEW_FOLDERS_MAX = 12
const STAT_LIMITS = { characters: 40, works: 30, tags: 60 } as const
// 出方案的超时
const PLAN_TIMEOUT_MS = 120_000

interface OrganizeWorkflowState {
  plan: OrganizeFolderVO[] | null
  lookFrom: string | null
}

// 一键整理需要的外部信息
export interface OrganizeConfig {
  // 状态变了：推给界面
  onState: (state: OrganizeStateVO) => void
  // 有新建议了：界面刷新“AI 建议”
  onSuggested: () => void
}

let config: OrganizeConfig | null = null
let state: OrganizeStateVO = { phase: 'IDLE', plan: null, error: null }
let workflowVersion: number | undefined
let starting = false
let planning: OrganizeStateVO | null = null
let lookFrom: Date | null = null

function workflowStatus(next: OrganizeStateVO): string {
  if (next.phase === 'IDLE') return 'IDLE'
  if (next.error) return 'FAILED'
  if (next.phase === 'PLAN_READY') return 'WAITING'
  return 'RUNNING'
}

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
async function setState(next: OrganizeStateVO, rules?: OrganizeFolderVO[]): Promise<void> {
  const prev = state
  state = next
  const payload = {
    status: workflowStatus(next),
    phase: next.phase,
    state: { plan: next.plan, lookFrom: lookFrom ? lookFrom.toISOString() : null } satisfies OrganizeWorkflowState,
    error: next.error ?? null
  }
  try {
    const saved = rules
      ? await getDatabase().db.transaction(async (tx) => {
          await writeSettings(tx, [{ key: RULES_KEY, value: rules }])
          return upsertWorkflow<OrganizeWorkflowState>('ORGANIZE', 'default', payload, workflowVersion, tx)
        })
      : await upsertWorkflow<OrganizeWorkflowState>('ORGANIZE', 'default', payload, workflowVersion)
    workflowVersion = saved.version
  } catch (err) {
    if (state === next) {
      state = prev
    }
    throw err
  }
  if (state === next) {
    config?.onState(next)
  }
}

// 在窗口和自动扫描启动前恢复状态，让界面从上次进度开始显示。
export async function restoreOrganize(): Promise<void> {
  let wf = await getWorkflow<OrganizeWorkflowState>('ORGANIZE', 'default')
  if (!wf) {
    const rows = await findActiveSettings()
    const saved = rows.find((s) => s.key === LEGACY_STATE_KEY)?.value as OrganizeStateVO | undefined
    const from = rows.find((s) => s.key === LEGACY_LOOK_FROM_KEY)?.value
    const hasLegacyState = saved && typeof saved === 'object' && typeof saved.phase === 'string'
    const legacyLookFrom = typeof from === 'string' && !Number.isNaN(new Date(from).getTime()) ? new Date(from).toISOString() : null
    if (hasLegacyState || legacyLookFrom) {
      const restored: OrganizeStateVO = hasLegacyState
        ? { phase: saved.phase, plan: saved.plan ?? null, error: saved.error ?? null }
        : { phase: 'IDLE', plan: null, error: null }
      wf = await upsertWorkflow<OrganizeWorkflowState>('ORGANIZE', 'default', {
        status: workflowStatus(restored),
        phase: restored.phase,
        state: { plan: restored.plan, lookFrom: legacyLookFrom },
        error: restored.error ?? null
      })
    }
  }
  if (wf) {
    workflowVersion = wf.version
    const from = wf.state?.lookFrom
    lookFrom = typeof from === 'string' && !Number.isNaN(new Date(from).getTime()) ? new Date(from) : null
    state = {
      phase: (wf.phase as OrganizeStateVO['phase']) ?? 'IDLE',
      plan: wf.state?.plan ?? null,
      error: wf.error ?? null
    }
    config?.onState(state)
  } else {
    workflowVersion = undefined
    lookFrom = null
    state = { phase: 'IDLE', plan: null, error: null }
  }
  if (state.phase === 'LOOKING') {
    await refreshLooked()
  }
}

// 看图队列恢复后继续原来的阶段。
export async function resumeOrganize(): Promise<void> {
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
export async function estimateOrganize(signal?: AbortSignal): Promise<OrganizeEstimateVO> {
  const { toLook, ratingLeft } = await countOrganizeEstimate(signal)
  const realtime = Math.min(toLook, ORGANIZE_COST.realtimeMax)
  const yuan = realtime * ORGANIZE_COST.realtimeYuanPerImage + (toLook - realtime + ratingLeft) * ORGANIZE_COST.batchYuanPerImage
  return { toLook, tokens: (toLook + ratingLeft) * ORGANIZE_COST.tokensPerImage, yuan: Math.round(yuan * 100) / 100, ratingLeft }
}

// 开始：还没看过的图都排进看图队列（包括看图上线前的老图），看完自动出方案；没有要看的直接出方案。
// 方案出错后再点一次就是重试
export async function startOrganize(): Promise<OrganizeStateVO> {
  if (!readCloudCredentials().dashscopeApiKey) {
    throw new BizError('DEPENDENCY_FAILED', LOOK_KEY_HINT)
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
    const { enqueued, version } = await enqueueOrganizeLooks<OrganizeWorkflowState>(
      {
        status: workflowStatus(next),
        phase: next.phase,
        state: { plan: null, lookFrom: from.toISOString() },
        error: null
      },
      workflowVersion
    )
    workflowVersion = version
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
    const saved = await upsertWorkflow<OrganizeWorkflowState>(
      'ORGANIZE',
      'default',
      {
        status: workflowStatus(state),
        phase: state.phase,
        state: { plan: state.plan, lookFrom: lookFrom.toISOString() },
        error: state.error ?? null
      },
      workflowVersion
    )
    workflowVersion = saved.version
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
  const persisted = await readSetting<OrganizeFolderVO[]>(RULES_KEY)
  const index = categoryPathIndex(await categoryPaths())
  const plan = availableRules(persisted?.length ? persisted : state.plan, index)
  const n = await insertOrganizeResults(assignFolders(await findOrganizeTerms(), plan), BAILIAN_CONFIG.chatModel)
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
  const existingLow = categoryPathIndex(existing)
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
    const rawName = typeof o.name === 'string' ? o.name.trim() : ''
    const known = existingLow.get(rawName.replaceAll('/', '\\').toLowerCase())
    const name = known ?? Array.from(rawName).slice(0, DIR_NAME_MAX).join('').trim()
    if ((!known && !isValidDirName(name)) || names.has(name.toLowerCase())) {
      continue
    }
    const isNew = !known
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

// 已有归档与标签同名时优先采用，只把没有明确归属的词留给模型方案。
export function reuseOrganizePaths(plan: OrganizeFolderVO[], stats: Record<'characters' | 'works' | 'tags', Array<[string, number]>>, paths: string[]): OrganizeFolderVO[] {
  const lookup = categoryPathIndex(paths)
  const result = new Map<string, OrganizeFolderVO>()
  const kinds = ['characters', 'works', 'tags'] as const
  const assigned = new Set<string>()
  for (const kind of kinds) {
    for (const [word] of stats[kind]) {
      const key = word.toLowerCase()
      const name = lookup.get(key)
      if (!name || assigned.has(key)) continue
      if (!result.has(name) && result.size >= ORGANIZE_FOLDERS_MAX) continue
      const target = result.get(name) ?? { name, isNew: false, characters: [], works: [], tags: [] }
      if (target[kind].length >= ORGANIZE_TERMS_MAX) continue
      target[kind].push(word)
      result.set(name, target)
      assigned.add(key)
    }
  }
  for (const folder of plan) {
    if (!result.has(folder.name) && result.size >= ORGANIZE_FOLDERS_MAX) continue
    const target = result.get(folder.name) ?? { ...folder, characters: [], works: [], tags: [] }
    for (const kind of kinds) {
      target[kind].push(...folder[kind].filter((w) => !assigned.has(w.toLowerCase())).slice(0, ORGANIZE_TERMS_MAX - target[kind].length))
    }
    if (kinds.some((kind) => target[kind].length)) result.set(folder.name, target)
  }
  return [...result.values()]
}

function availableRules(rules: OrganizeFolderVO[], index: Map<string, string>): OrganizeFolderVO[] {
  return rules.flatMap((folder) => {
    const known = index.get(folder.name.toLowerCase())
    if (known) return [{ ...folder, name: known, isNew: false }]
    return folder.isNew ? [folder] : []
  })
}

async function makePlan(): Promise<void> {
  if (planning === state) {
    return
  }
  const current: OrganizeStateVO = { phase: 'PLANNING', plan: null, error: null }
  planning = current
  try {
    await setState(current)
    let all = await findOrganizeTerms()
    const existing = await categoryPaths(true)
    const index = categoryPathIndex(existing)
    const saved = await readSetting<OrganizeFolderVO[]>(RULES_KEY) ?? []
    const confirmed = availableRules(saved, index)
    const missing = new Set(saved.filter((f) => !f.isNew && !index.has(f.name.toLowerCase())).map((f) => f.name.toLowerCase()))
    const covered = assignFolders(all, confirmed)
    if (state !== current) return
    if (covered.length) {
      if (await insertOrganizeResults(covered, 'confirmed-rules')) config?.onSuggested()
      if (state !== current) return
      const ids = new Set(covered.map((r) => r.imageId))
      all = all.filter((t) => !ids.has(t.imageId))
      if (!all.some((t) => t.tags.length || t.characters.length || t.works.length)) {
        await recordLocalReuse()
        if (state !== current) return
        await setState({phase:'FOLLOWING',plan:confirmed,error:null})
        await maybeFinish()
        return
      }
    }
    const stats = {
      characters: topTerms(all, (t) => t.characters, STAT_LIMITS.characters),
      works: topTerms(all, (t) => t.works, STAT_LIMITS.works),
      tags: topTerms(all, (t) => t.tags, STAT_LIMITS.tags)
    }
    const allowed = new Set([...stats.characters, ...stats.works, ...stats.tags].map(([w]) => w))
    const lookup = categoryPathIndex(existing)
    const matching = [...allowed].map((w) => lookup.get(w.toLowerCase())).filter((p): p is string => !!p)
    const promptPaths = [...new Set([...matching, ...existing])].slice(0, 160)
    if (state !== current) {
      return
    }
    if (allowed.size === 0) {
      await setState({ phase: 'PLAN_READY', plan: null, error: '没有能用来分类的标签和建议，先让诺诺看看图或打几个标签' })
      return
    }
    if (matching.length === allowed.size) {
      const local = reuseOrganizePaths([], stats, existing)
      if (local.reduce((n, f) => n + f.characters.length + f.works.length + f.tags.length, 0) === allowed.size) {
        await setState({ phase: 'PLAN_READY', plan: local, error: null })
        return
      }
    }
    const habits = await habitLines()
    if (state !== current) return
    const res = await chatCall({
      kind: 'organize',
      model: BAILIAN_CONFIG.chatModel,
      messages: [{ role: 'user', content: planPrompt(promptPaths, all.length, stats, habits) }],
      timeoutMs: PLAN_TIMEOUT_MS
    })
    if (state !== current) {
      return
    }
    const text = String(res.message.content ?? '')
    const suggestions = sanitizePlan(parseAssistJson(text), allowed, existing).filter((f) => !missing.has(f.name.toLowerCase()))
    const plan = reuseOrganizePaths(suggestions, stats, existing)
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
  const existingLow = categoryPathIndex(existing)
  const names = new Set<string>()
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map((w) => w.trim()).slice(0, ORGANIZE_TERMS_MAX) : []
  return raw.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>
    const input = typeof o.name === 'string' ? o.name.trim() : ''
    const known = existingLow.get(input.replaceAll('/', '\\').toLowerCase())
    const name = known ?? input
    if (!known && state.plan?.some((f) => !f.isNew && f.name.toLowerCase() === input.toLowerCase())) {
      throw new BizError('CONFLICT', '原类目录位置已改变，请选择当前目录')
    }
    if (!known && (!isValidDirName(name) || Array.from(name).length > DIR_NAME_MAX)) {
      throw new BizError('BAD_REQUEST', `目录名「${name}」不能用：最多 ${DIR_NAME_MAX} 个字，不能有 \\ / : * ? " < > |`)
    }
    if (names.has(name.toLowerCase())) {
      throw new BizError('BAD_REQUEST', `目录「${name}」重复了`)
    }
    names.add(name.toLowerCase())
    return { name, isNew: !known, characters: list(o.characters), works: list(o.works), tags: list(o.tags) }
  })
}

// 本地分图：角色优先、其次作品、再次标签，按方案里目录的顺序取第一个对上的；对不上的不管
export function assignFolders(all: OrganizeTerms[], plan: OrganizeFolderVO[]): Array<{ imageId: number; dir: string; existing?: boolean }> {
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
  const existing = new Set(plan.filter((f) => !f.isNew).map((f) => f.name))
  const out: Array<{ imageId: number; dir: string; existing?: boolean }> = []
  for (const t of all) {
    const hit = (words: string[], m: Map<string, string>): string | undefined => words.map((w) => m.get(w.toLowerCase())).find(Boolean)
    const dir = hit(t.characters, byWho) ?? hit(t.works, byWork) ?? hit(t.tags, byTag)
    if (dir) {
      out.push({ imageId: t.imageId, dir, ...(existing.has(dir) ? {existing: true} : {}) })
    }
  }
  return out
}

// 按你批过的方案分图，生成“放进类目录”的建议；返回生成了多少条
export async function approveOrganize(rawPlan: unknown): Promise<number> {
  if (state.phase !== 'PLAN_READY') {
    throw new BizError('CONFLICT', '现在没有待确认的方案')
  }
  const plan = checkPlan(rawPlan, await categoryPaths(true))
  const previous = await readSetting<OrganizeFolderVO[]>(RULES_KEY) ?? []
  const kinds = ['characters','works','tags'] as const
  const rules = plan.map((f) => ({...f,characters:[...f.characters],works:[...f.works],tags:[...f.tags]}))
  const known = new Map(rules.map((f) => [f.name.toLowerCase(),f]))
  for (const kind of kinds) {
    const replaced = new Set(plan.flatMap((f) => f[kind].map((w) => w.toLowerCase())))
    for (const old of previous) {
      const words = old[kind].filter((w) => !replaced.has(w.toLowerCase()))
      if (!words.length) continue
      let rule = known.get(old.name.toLowerCase())
      if (!rule) {
        rule = {...old,characters:[],works:[],tags:[]}
        rules.push(rule)
        known.set(old.name.toLowerCase(),rule)
      }
      rule[kind].push(...words)
    }
  }
  await setState({ phase: 'ASSIGNING', plan, error: null }, rules)
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
