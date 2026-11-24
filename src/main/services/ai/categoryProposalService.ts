import { mkdir, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { DIR_NAME_MAX, type CategoryProposalVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { isWithin, pathKey } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import { categoryProposal } from '../../db/schema'
import { findPendingOps, insertBatch, renameRowsUnder, observeOrganizeTarget, updateBatchStatus, updateOpStatus } from '../../repositories/fileOpRepository'
import { ensureCategoryRoot } from '../categoryHome'
import { categoryDirectory, categoryRel, invalidateCategoryTree, readCategoryTree } from '../fileOps/categoryPaths'
import { resolveFolder } from '../fileOps/folderOpsService'
import { enqueue } from '../fileOps/fileOpsService'
import { getScanState } from '../scan/scanService'
import { referencePreviews } from '../../repositories/aiReferenceRepository'
import { applyFiling, prepareFiling, type FilingGroup } from './categoryFiling'
import { analyzeNewTags } from './categoryAnalysis'
import { parseCategoryRequest } from './categoryRequest'

type Payload = Pick<CategoryProposalVO, 'entries' | 'scope' | 'analysisCount'> & { started?: boolean; originalId?: string; parentId?: string; filing?: FilingGroup[] }
export type CategoryReply = { text: string; categoryProposalId?: number; proposalNote?: true }
type Action = { kind: 'file'; ids: number[]; path?: string } | { kind: 'analyze'; scope?: string } | { kind: 'create'; path: string } | { kind: 'move'; path: string; targetParent: string }
type Row = typeof categoryProposal.$inferSelect
const currentHome = async () => (await resolveFolder({ kind: 'category', path: '' })).abs
const parentRel = (path: string) => dirname(path) === '.' ? '' : dirname(path)

export async function listCategoryPaths(selectedCategory?: string): Promise<string[]> {
  return readCategoryTree(await currentHome(), selectedCategory ? categoryRel(selectedCategory) : null)
}

async function publicPlan(row: Row): Promise<CategoryProposalVO> {
  const { entries, scope, analysisCount, started = false, filing } = row.payload as Payload
  const plan: CategoryProposalVO = { id: row.id, status: row.status, entries, scope, analysisCount, started }
  if (row.status === 'pending' && filing?.length) {
    const ids = [...new Set(filing.flatMap(group => group.imageIds))]
    const visible = ids.slice(0, 6)
    const previews = await referencePreviews(visible)
    const hashes = new Map(previews.filter(p => !p.isR18).map(p => [p.imageId, p.hash]))
    plan.filingPreview = { total: ids.length, hashes: visible.map(id => hashes.get(id) ?? null) }
  }
  return plan
}

async function readPlan(id: number, messageId: number): Promise<Row> {
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(messageId)) throw new BizError('BAD_REQUEST', '目录提案编号无效')
  const [row] = await getDatabase().db.select().from(categoryProposal).where(and(eq(categoryProposal.id, id),
    sql`exists (select 1 from ai_message m join ai_conversation c on c.id = m.conversation_id
      where m.id = ${messageId} and m.delete_state = 0 and c.delete_state = 0 and m.role = 'ASSISTANT'
      and m.content->>'categoryProposalId' = ${String(id)})`))
  if (!row) throw new BizError('NOT_FOUND', '这条目录提案已经撤回')
  return row
}

export async function getCategoryProposal(id: number, messageId: number): Promise<CategoryProposalVO> {
  return publicPlan(await readPlan(id, messageId))
}

export function describeProposal(plan: CategoryProposalVO): string {
  if (plan.status === 'cancelled') return '这份提案已取消。'
  if (plan.status === 'pending') return plan.started ? '这份提案尚未执行完毕。' : '这份提案还在等待确认。'
  const entry = plan.entries[0]
  if (entry?.kind === 'copy') return '已复制并核验的图片：' + plan.entries.map(e => '「' + e.path + '」' + e.count + ' 张').join('、') + '。'
  if (entry?.kind === 'move') return '已将「' + entry.from + '」迁移到「' + entry.path + '」。'
  return plan.entries.length ? '目录已就绪。这次只处理了目录，尚未复制图片。' : '本次提案没有创建目录或复制图片。'
}

// 对话历史保留当时的提案正文；后续追问使用最新的确认状态。
export async function proposalStatesInHistory(ids: number[]) {
  const states = new Map<number, string>()
  if (ids.length) {
    const rows = await getDatabase().db.select({ id: categoryProposal.id, status: categoryProposal.status, payload: categoryProposal.payload })
      .from(categoryProposal).where(inArray(categoryProposal.id, [...new Set(ids)]))
    for (const row of rows) {
      const { entries, filing, started } = row.payload as Payload
      const status = row.status === 'cancelled' ? '已取消' : row.status === 'pending' ? (started ? '部分执行，待继续' : '待确认')
        : filing ? '已核验图片副本' : '目录操作已完成，未执行图片归档'
      states.set(row.id, JSON.stringify({ status, paths: entries.slice(0, 100).map(e => e.path) }))
    }
  }
  return states
}

function proposalReply(id: number, payload: Payload): CategoryReply {
  const first = payload.entries[0]
  const text = payload.filing ? '已选好目标目录，确认后复制图片。' : payload.analysisCount ? `已根据 ${payload.analysisCount} 张新增图片的标签整理目录提案。`
    : first.from ? `准备把「${first.from}」迁移到「${first.path}」，等你确认喵。` : `准备创建类目录「${first.path}」，等你确认喵。`
  return { text, categoryProposalId: id }
}

export async function restorePreparedProposal(id: number): Promise<CategoryReply> {
  const [row] = await getDatabase().db.select().from(categoryProposal).where(eq(categoryProposal.id, id))
  if (!row) throw new BizError('NOT_FOUND', '目录提案已不存在')
  return proposalReply(id, row.payload as Payload)
}

async function save(home: string, payload: Payload, sourceMessageId?: number, ids: number[] = []): Promise<CategoryReply> {
  return getDatabase().db.transaction(async (tx) => {
    const [row] = await tx.insert(categoryProposal).values({ home, payload }).returning({ id: categoryProposal.id })
    if (ids.length) {
      await tx.execute(sql`insert into category_analyzed_image(image_id, proposal_id)
        select id, ${row.id} from unnest(${sql.param(ids)}::bigint[]) id`)
    }
    // 即使进程在助手回复入库之前退出，重试原消息也能找回这次提案。
    if (sourceMessageId) await tx.execute(sql`update ai_message
      set content = jsonb_set(content, '{preparedProposalId}', to_jsonb(${row.id}::integer))
      where id = ${sourceMessageId} and role = 'USER' and delete_state = 0`)
    return proposalReply(row.id, payload)
  })
}

// 同一进程中不同会话可能同时发起分析；串行准备避免两次请求分析相同的新增图片。
let preparing = Promise.resolve()
export function prepareCategoryAction(action: Action, selectedCategory?: string, sourceMessageId?: number): Promise<CategoryReply> {
  const run = preparing.then(() => prepare(action, selectedCategory, sourceMessageId))
  preparing = run.then(() => undefined, () => undefined)
  return run
}

async function prepare(action: Action, selectedCategory?: string, sourceMessageId?: number): Promise<CategoryReply> {
  const home = await currentHome()
  const selected = selectedCategory ? categoryRel(selectedCategory) : null
  const scope = action.kind === 'analyze' && action.scope ? categoryRel(action.scope) : selected
  if (selected && scope && !isWithin(join(home, selected), join(home, scope))) throw new BizError('BAD_REQUEST', '分析范围超出当前选中的类目录')
  const payload: Payload = { scope, analysisCount: 0, entries: [] }
  if (action.kind === 'file') {
    const filing = await prepareFiling(home, selected, action.ids, action.path)
    return save(home, { ...payload, filing, entries: filing.map(g => ({ kind: 'copy', path: g.path, count: g.imageIds.length })) }, sourceMessageId)
  }
  if (action.kind === 'analyze') {
    if (scope && !await categoryDirectory(home, scope)) throw new BizError('NOT_FOUND', '选中的类目录已不存在')
    const { ids, entries } = await analyzeNewTags(home, scope)
    if (!ids.length) {
      const [previous] = await getDatabase().db.select().from(categoryProposal).where(and(
        eq(categoryProposal.status, 'pending'), eq(categoryProposal.home, home),
        sql`(payload->>'analysisCount')::int > 0 and (payload->>'scope') is not distinct from ${scope}::text`
      )).orderBy(desc(categoryProposal.id)).limit(1)
      return { text: '没有新增的已标注图片。', ...(previous ? { categoryProposalId: previous.id, proposalNote: true as const } : {}) }
    }
    return save(home, { ...payload, entries, analysisCount: ids.length }, sourceMessageId, ids)
  }
  if (typeof action.path !== 'string') throw new BizError('BAD_REQUEST', '请填写相对类目录根的路径')
  const path = categoryRel(action.path)
  if (action.kind === 'create') {
    if (await categoryDirectory(home, path)) return { text: '这个类目录已经存在。' }
    let prefix = ''
    for (const name of path.split('\\')) {
      prefix = join(prefix, name)
      if (Array.from(name).length > DIR_NAME_MAX && !await categoryDirectory(home, prefix)) {
        throw new BizError('BAD_REQUEST', `新目录名最多 ${DIR_NAME_MAX} 个字`)
      }
    }
    payload.entries.push({ kind: 'create', path })
  } else {
    if (action.kind !== 'move' || typeof action.targetParent !== 'string') throw new BizError('BAD_REQUEST', '目录操作无效')
    const parent = action.targetParent ? categoryRel(action.targetParent) : ''
    const to = join(parent, basename(path))
    if (pathKey(path) === pathKey(to) || isWithin(join(home, path), join(home, parent))) throw new BizError('BAD_REQUEST', '目标不能是原位置或自身的子目录')
    const from = await categoryDirectory(home, path)
    const target = await categoryDirectory(home, parent)
    if (!from || !target) throw new BizError('NOT_FOUND', '原目录或目标父目录不存在')
    if (await categoryDirectory(home, to)) throw new BizError('CONFLICT', '目标位置已有同名目录')
    payload.originalId = from.identity
    payload.parentId = target.identity
    payload.entries.push({ kind: 'move', from: path, path: to })
  }
  return save(home, payload, sourceMessageId)
}

export async function prepareCategoryRequest(text: string, selectedCategory?: string, sourceMessageId?: number): Promise<CategoryReply | null> {
  const action = parseCategoryRequest(text)
  if (!action) return null
  return prepareCategoryAction(action.kind === 'move' ? { kind: 'move', path: action.from, targetParent: action.parent } : action, selectedCategory, sourceMessageId)
}

async function makeDirectory(home: string, path: string): Promise<void> {
  await ensureCategoryRoot(home, true)
  let rel = ''
  for (const name of categoryRel(path).split('\\')) {
    rel = join(rel, name)
    if (await categoryDirectory(home, rel)) continue
    if (Array.from(name).length > DIR_NAME_MAX) throw new BizError('BAD_REQUEST', `新目录名最多 ${DIR_NAME_MAX} 个字`)
    await mkdir(join(home, rel)).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
    if (!await categoryDirectory(home, rel)) throw new BizError('CONFLICT', '目录位置已改变')
  }
}

async function moveTree(home: string, payload: Payload, from: string, to: string, begin: () => Promise<void>): Promise<void> {
  const root = await ensureCategoryRoot(home)
  const parent = await categoryDirectory(home, parentRel(to))
  if (!root || parent?.identity !== payload.parentId) throw new BizError('CONFLICT', '目标父目录已更换，请重新生成提案')
  const original = await categoryDirectory(home, from)
  const destination = await categoryDirectory(home, to)
  const { db } = getDatabase()
  if (!original && destination?.identity === payload.originalId) {
    // 上次可能已完成磁盘操作，启动恢复也可能已经同步了索引；重复更新不会改变其他目录。
    await renameRowsUnder(db, root.id, from, to)
    return
  }
  if (!original || original.identity !== payload.originalId || destination) throw new BizError('CONFLICT', '目录位置已发生变化，请重新生成提案')
  const occupied = await db.execute(sql`select 1 from image_file where root_id = ${root.id} and delete_state = 0
    and starts_with(lower(replace(rel_path, chr(92), '/')), ${to.replaceAll('\\', '/').toLowerCase() + '/'}) limit 1`)
  if (occupied.rows.length) throw new BizError('CONFLICT', '目标位置已有文件记录')
  const destAbs = join(home, to)
  await begin()
  const batchId = await db.transaction(async (tx) => {
    const id = await insertBatch(tx, '迁移类目录', [{ opType: 'RENAME', imageFileId: null, fromPath: original.abs, toPath: destAbs, contentHash: original.identity }])
    await updateBatchStatus(tx, id, 'APPLYING')
    return id
  })
  const [op] = await findPendingOps(batchId)
  try {
    await rename(original.abs, destAbs)
  } catch (err) {
    await db.transaction(async (tx) => {
      await updateOpStatus(tx, op.id, 'FAILED', (err as Error).message)
      await updateBatchStatus(tx, batchId, 'FAILED')
    })
    throw err
  }
  await db.transaction(async (tx) => {
    await renameRowsUnder(tx, root.id, from, to)
    await updateOpStatus(tx, op.id, 'DONE')
    await updateBatchStatus(tx, batchId, 'APPLIED')
  })
}

export async function decideCategoryProposal(id: number, messageId: number, apply: boolean): Promise<CategoryProposalVO> {
  if (typeof apply !== 'boolean') throw new BizError('BAD_REQUEST', '请选择确认或取消')
  return enqueue(async () => {
    const row = await readPlan(id, messageId)
    if (row.status !== 'pending') return publicPlan(row)
    const payload = row.payload as Payload
    if (!apply && payload.started) throw new BizError('CONFLICT', '提案已经开始执行，请继续完成')
    const begin = async () => {
      if (payload.started) return
      payload.started = true
      await getDatabase().db.update(categoryProposal).set({ payload }).where(eq(categoryProposal.id, id))
    }
    if (apply) {
      if (getScanState().progress) throw new BizError('CONFLICT', '请等目录扫描完成后再确认')
      if (pathKey(row.home) !== pathKey(await currentHome())) throw new BizError('CONFLICT', '类目录根位置已变更')
      if (payload.filing) await applyFiling(row.home, payload.filing, begin)
      for (const entry of payload.entries) {
        if (entry.kind === 'move' || entry.kind === 'copy') continue
        const current = await categoryDirectory(row.home, entry.path)
        if (entry.kind === 'existing' && !current) throw new BizError('CONFLICT', '原有类目录已不存在')
      }
      for (const entry of payload.entries) {
        if (entry.kind === 'move' && entry.from) await moveTree(row.home, payload, entry.from, entry.path, begin)
        if (entry.kind === 'create') {
          await begin()
          await makeDirectory(row.home, entry.path)
          await observeOrganizeTarget(entry.path)
        }
      }
      invalidateCategoryTree()
    }
    const [updated] = await getDatabase().db.update(categoryProposal).set({ status: apply ? 'applied' : 'cancelled' }).where(eq(categoryProposal.id, id)).returning()
    return publicPlan(updated)
  })
}
