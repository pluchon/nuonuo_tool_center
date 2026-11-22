// 一键整理（设计 6.10）：先把还没看过的图看一遍，再一次纯文本调用出类目录方案，你批了方案后在本地把图分进目录。
// 结果都是“放进类目录”的建议，进“AI 建议”由你审；R-18 图不看、不分。状态记在 app_setting，退出后重开接着来
import {
  DIR_NAME_MAX,
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
import { findActiveSettings, upsertSettings } from '../../repositories/appSettingRepository'
import {
  countLookCandidates,
  findLookCandidates,
  findOpenLookJobs,
  findOrganizeTerms,
  cancelBacklogJobs,
  insertLookJobs,
  insertOrganizeResults,
  type OrganizeTerms
} from '../../repositories/aiResultRepository'
import { countRatingCandidates } from '../../repositories/imageRepository'
import { categoryTopNames } from '../fileOps/folderOpsService'
import { isRatingBusy } from '../rating/ratingService'
import { chatCall } from './bailianClient'
import { PRIORITY_BACKLOG, scheduleLook } from './lookService'
import { habitLines } from './suggestionService'

const log = getLogger('organize')

// 状态在设置表里的键（settingsService 跳过 ai. 开头的键）
const STATE_KEY = 'ai.organize'
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
let planning = false

// 配置（启动时调一次）
export function configureOrganize(next: OrganizeConfig): void {
  config = next
}

// 当前状态
export function getOrganizeState(): OrganizeStateVO {
  return state
}

// 改状态：存库并推给界面
async function setState(next: OrganizeStateVO): Promise<void> {
  state = next
  await upsertSettings([{ key: STATE_KEY, value: next }])
  config?.onState(next)
}

// 启动：读回上次的状态；看图中的检查一下看完没有，出方案出到一半的重新出
export async function initOrganize(): Promise<void> {
  const row = (await findActiveSettings()).find((s) => s.key === STATE_KEY)
  const saved = row?.value as OrganizeStateVO | undefined
  if (saved && typeof saved === 'object' && typeof saved.phase === 'string') {
    state = { phase: saved.phase, plan: saved.plan ?? null, error: saved.error ?? null }
  }
  if (state.phase === 'ASSIGNING') {
    await setState({ phase: 'IDLE', plan: null, error: null })
  } else if (state.phase === 'PLANNING') {
    void makePlan()
  } else if (state.phase === 'LOOKING') {
    await checkLooking()
  } else if (state.phase === 'FOLLOWING') {
    await onRatingBatch()
  }
}

// 开始前的估算：要看多少张、大概多少 token 和钱
// 还没判完的按最多都要看、都走批量来算
export async function estimateOrganize(): Promise<OrganizeEstimateVO> {
  const toLook = await countLookCandidates(new Date(0))
  const ratingLeft = await countRatingCandidates()
  const realtime = Math.min(toLook, ORGANIZE_COST.realtimeMax)
  const yuan = realtime * ORGANIZE_COST.realtimeYuanPerImage + (toLook - realtime + ratingLeft) * ORGANIZE_COST.batchYuanPerImage
  return { toLook, tokens: (toLook + ratingLeft) * ORGANIZE_COST.tokensPerImage, yuan: Math.round(yuan * 100) / 100, ratingLeft }
}

// 开始：还没看过的图都排进看图队列（包括看图上线前的老图），看完自动出方案；没有要看的直接出方案。
// 方案出错后再点一次就是重试
export async function startOrganize(): Promise<OrganizeStateVO> {
  if (!readCloudCredentials().dashscopeApiKey) {
    throw new BizError('DEPENDENCY_FAILED', '诺诺还没连上云端')
  }
  if (state.phase === 'PLAN_READY' && !state.plan) {
    void makePlan()
    return state
  }
  if (state.phase !== 'IDLE') {
    throw new BizError('CONFLICT', '一键整理已经在进行了')
  }
  // 本地分级没做完也能开始：先用已经判完的出方案，批了之后剩下的判完再陆续补进来
  const ids = await findLookCandidates(new Date(0), 1_000_000)
  if (ids.length > 0) {
    await insertLookJobs(ids)
    log.info(`一键整理：排进 ${ids.length} 张看图`)
  }
  await setState({ phase: 'LOOKING', plan: null, error: null })
  scheduleLook()
  await checkLooking()
  return state
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
  const open = await findOpenLookJobs()
  if (open.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING')) {
    return
  }
  void makePlan()
}

// 取消：回到空闲（已经交出去的看完为止，还没交的补图取消，已经生成的建议留着）
export async function cancelOrganize(): Promise<OrganizeStateVO> {
  if (state.phase === 'FOLLOWING') {
    await cancelBacklogJobs()
  }
  await setState({ phase: 'IDLE', plan: null, error: null })
  return state
}

// ===== 方案已批后陆续补图 =====

// 分级每判完一小批：判完、过了闸门、还没看过的老图按半价排进看图（只走批量）
export async function onRatingBatch(): Promise<void> {
  if (state.phase !== 'FOLLOWING') {
    return
  }
  const ids = await findLookCandidates(new Date(0), 1_000_000)
  if (ids.length > 0) {
    await insertLookJobs(ids, PRIORITY_BACKLOG)
    log.info(`一键整理补图：排进 ${ids.length} 张（批量）`)
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
  const rows = assignFolders(await findOrganizeTerms(), state.plan)
  await insertOrganizeResults(rows, BAILIAN_CONFIG.chatModel)
  if (rows.length > 0) {
    log.info(`一键整理补图：又分了 ${rows.length} 张`)
    config?.onSuggested()
  }
  return rows.length
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
  if (planning) {
    return
  }
  planning = true
  try {
    await setState({ phase: 'PLANNING', plan: null, error: null })
    const all = await findOrganizeTerms()
    const existing = await categoryTopNames()
    const stats = {
      characters: topTerms(all, (t) => t.characters, STAT_LIMITS.characters),
      works: topTerms(all, (t) => t.works, STAT_LIMITS.works),
      tags: topTerms(all, (t) => t.tags, STAT_LIMITS.tags)
    }
    const allowed = new Set([...stats.characters, ...stats.works, ...stats.tags].map(([w]) => w))
    if (allowed.size === 0) {
      await setState({ phase: 'PLAN_READY', plan: null, error: '没有能用来分类的标签和建议，先让诺诺看看图或打几个标签' })
      return
    }
    const res = await chatCall({
      kind: 'organize',
      model: BAILIAN_CONFIG.chatModel,
      messages: [{ role: 'user', content: planPrompt(existing, all.length, stats, await habitLines()) }],
      timeoutMs: PLAN_TIMEOUT_MS
    })
    const text = String(res.message.content ?? '')
    const plan = sanitizePlan(parseAssistJson(text), allowed, existing)
    if (plan.length === 0) {
      // 只有目录名和标签词，不含图片内容，记下来方便查为什么用不了
      log.warn(`一键整理方案用不了：${text.slice(0, 600)}`)
    }
    await setState(plan.length ? { phase: 'PLAN_READY', plan, error: null } : { phase: 'PLAN_READY', plan: null, error: '诺诺没给出能用的方案，再试一次' })
  } catch (err) {
    log.warn('一键整理出方案失败', err)
    await setState({ phase: 'PLAN_READY', plan: null, error: '出方案时网络异常，再试一次' })
  } finally {
    planning = false
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
  let rows: Array<{ imageId: number; dir: string }> = []
  try {
    rows = assignFolders(await findOrganizeTerms(), plan)
    await insertOrganizeResults(rows, BAILIAN_CONFIG.chatModel)
    log.info(`一键整理：生成 ${rows.length} 条放进类目录的建议`)
    if (rows.length > 0) {
      config?.onSuggested()
    }
  } catch (err) {
    await setState({ phase: 'IDLE', plan: null, error: null })
    throw err
  }
  // 记住批过的方案：本地分级后判完的、还在看的图，之后陆续按它分；都做完了自己收尾
  await setState({ phase: 'FOLLOWING', plan, error: null })
  await onRatingBatch()
  return rows.length
}
