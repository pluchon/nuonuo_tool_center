import { lstat, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { setImmediate as yieldToIpc } from 'node:timers/promises'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  LOOK_KEY_HINT,
  type ReorganizeEstimateVO,
  type ReorganizeRelookResultVO,
  type ReorganizeResetResultVO
} from '@shared/api'
import { ORGANIZE_COST, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { publishExclusive } from '../../common/publishFile'
import { bumpLibraryVersion } from '../../common/readCache'
import { retryOnWinBusy } from '../../common/winFs'
import { getDatabase } from '../../db/client'
import { col } from '../../db/sqlUtil'
import { aiJob, image, imageAiResult, imageFile, imageTag, libraryRoot } from '../../db/schema'
import { hasPendingSuggestion, LOOK_CONTENT_REJECTED } from '../../repositories/aiResultRepository'
import { relocateImageFile, retireRowsAt } from '../../repositories/fileOpRepository'
import { findActiveRootsByKind } from '../../repositories/libraryRootRepository'
import { verifyImageFile } from '../fileOps/fileOpRecovery'
import { enqueue, trashPath } from '../fileOps/fileOpsService'
import { isRatingBusy } from '../rating/ratingService'
import { getScanState } from '../scan/scanService'
import { scheduleLook } from './lookService'
import { getOrganizeState, isOrganizing } from './organizeService'

const log = getLogger('reorganize')

const ESTIMATE_BATCH_SIZE = 256
const MAX_SUFFIX = 999
const DB_CHUNK = 1000

const hasNormalFileSql = sql`exists (
  select 1 from ${imageFile}
  join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
  where ${col(imageFile.imageId)} = ${col(image.id)}
    and ${col(imageFile.deleteState)} = 0
    and ${col(imageFile.status)} = 'NORMAL'
    and ${col(libraryRoot.deleteState)} = 0
)`

const inCategorySql = sql`exists (
  select 1 from ${imageFile}
  join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
  where ${col(imageFile.imageId)} = ${col(image.id)}
    and ${col(imageFile.deleteState)} = 0
    and ${col(imageFile.status)} = 'NORMAL'
    and ${col(libraryRoot.deleteState)} = 0
    and ${col(libraryRoot.kind)} = 'CATEGORY'
)`

const hasAcceptedTagSql = sql`exists (
  select 1 from ${imageTag}
  where ${col(imageTag.imageId)} = ${col(image.id)}
    and ${col(imageTag.deleteState)} = 0
    and ${col(imageTag.status)} = 'ACCEPTED'
)`

// 已整理图片：未删除、非 R-18、有活跃 NORMAL 文件、无待确认 AI 建议，且已确认入库（有已采用标签或在类目录中）
const organizedWhereSql = sql`(
  ${col(image.deleteState)} = 0
  and ${col(image.isR18)} = false
  and ${hasNormalFileSql}
  and not ${hasPendingSuggestion}
  and (${hasAcceptedTagSql} or ${inCategorySql})
)`

const cloudAllowedSql = sql`(
  ${col(image.ratingSource)} = 'MANUAL'
  or (${col(image.ratingSource)} = 'MODEL' and ${col(image.rating)} in ('GENERAL', 'SENSITIVE'))
)`

const hasOpenLookSql = sql`exists (
  select 1 from ${aiJob}
  where ${col(aiJob.imageId)} = ${col(image.id)}
    and ${col(aiJob.kind)} = 'LOOK'
    and ${col(aiJob.deleteState)} = 0
    and ${col(aiJob.status)} in ('QUEUED', 'RUNNING')
)`

const ratingCandidateSql = sql`(
  ${col(image.ratingSource)} is null
  and ${col(image.thumbReady)} = 1
)`

function candidate(dir: string, name: string, n: number): string {
  if (n === 1) return join(dir, name)
  const ext = extname(name)
  return join(dir, `${basename(name, ext)} (${n})${ext}`)
}

async function isDirOnline(dirPath: string): Promise<boolean> {
  return stat(dirPath).then((s) => s.isDirectory(), () => false)
}

async function isFilePresent(filePath: string): Promise<boolean> {
  return lstat(filePath).then((s) => s.isFile(), () => false)
}

async function isValidSourceFile(filePath: string, expectedHash: string): Promise<boolean> {
  try {
    await verifyImageFile(filePath, expectedHash)
    return true
  } catch {
    return false
  }
}

async function trashCategoryFile(catAbs: string, catRootPath: string): Promise<boolean> {
  try {
    await retryOnWinBusy(() => trashPath(catAbs))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    if (!(await isDirOnline(catRootPath))) {
      throw new BizError('DEPENDENCY_FAILED', `类目录无法访问：${catRootPath}`)
    }
    return false
  }
}

let resettingOrganized = false

export function isResettingOrganized(): boolean {
  return resettingOrganized
}

async function isReorganizeRelookBusy(): Promise<boolean> {
  const { pg } = getDatabase()
  const res = await pg.query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_job
       WHERE kind = 'LOOK'
         AND delete_state = 0
         AND status IN ('QUEUED', 'RUNNING')
         AND payload->>'reorganize' = 'true'
     ) AS busy`
  )
  return res.rows[0]?.busy === true
}

export async function isReorganizeBusy(): Promise<boolean> {
  return resettingOrganized || (await isReorganizeRelookBusy())
}

function assertIdleBaseForReorganize(): void {
  if (isOrganizing() || getOrganizeState().phase !== 'IDLE') {
    throw new BizError('CONFLICT', '正在一键整理，请先完成或停止')
  }
  if (getScanState().progress !== null) {
    throw new BizError('CONFLICT', '正在扫描，请稍后再试')
  }
}

async function assertIdleForReorganize(): Promise<void> {
  assertIdleBaseForReorganize()
  if (await isReorganizeBusy()) {
    throw new BizError('CONFLICT', '正在重新整理，请先等待完成或停止当前队列')
  }
}

// 重新整理前的估算：已整理图片数、重新看图张数、预估 token/花费、已整理中待分级张数
export async function estimateReorganize(signal?: AbortSignal): Promise<ReorganizeEstimateVO> {
  const { db } = getDatabase()
  let cursor = 0
  let organizedCount = 0
  let toLook = 0
  let ratingLeft = 0

  for (;;) {
    signal?.throwIfAborted()
    const {
      rows: [row]
    } = await db.execute<{
      last_id: number
      size: number
      organized_count: number
      to_look: number
      rating_left: number
    }>(sql`select max(id) as last_id,
        count(*)::int as size,
        count(*) filter (where ${organizedWhereSql})::int as organized_count,
        count(*) filter (where ${organizedWhereSql} and ${cloudAllowedSql} and not ${hasOpenLookSql})::int as to_look,
        count(*) filter (where ${organizedWhereSql} and ${ratingCandidateSql})::int as rating_left
      from (select * from ${image} where id > ${cursor} order by id limit ${ESTIMATE_BATCH_SIZE}) as image`)

    organizedCount += Number(row?.organized_count ?? 0)
    toLook += Number(row?.to_look ?? 0)
    ratingLeft += Number(row?.rating_left ?? 0)

    if (!row || Number(row.size) < ESTIMATE_BATCH_SIZE) {
      const realtime = Math.min(toLook, ORGANIZE_COST.realtimeMax)
      const yuan =
        realtime * ORGANIZE_COST.realtimeYuanPerImage + (toLook - realtime + ratingLeft) * ORGANIZE_COST.batchYuanPerImage
      return {
        organizedCount,
        toLook,
        tokens: (toLook + ratingLeft) * ORGANIZE_COST.tokensPerImage,
        yuan: Math.round(yuan * 100) / 100,
        ratingLeft
      }
    }
    cursor = Number(row.last_id)
    await yieldToIpc()
  }
}

interface OrganizedFileRow {
  imageId: number
  contentHash: string
  fileId: number
  rootId: number
  rootKind: 'SOURCE' | 'CATEGORY'
  rootPath: string
  relPath: string
}

// 模式 1：归回源目录（不调用任何大模型，安全保留唯一原图副本）
export async function resetOrganizedToSource(): Promise<ReorganizeResetResultVO> {
  await assertIdleForReorganize()
  resettingOrganized = true
  try {
    return await enqueue(async () => {
      assertIdleBaseForReorganize()
      if (await isReorganizeRelookBusy()) {
        throw new BizError('CONFLICT', '正在重新整理，请先等待完成或停止当前队列')
      }
      const { db, pg } = getDatabase()
      const res = await pg.query<{
        image_id: number
        content_hash: string
        file_id: number
        root_id: number
        root_kind: 'SOURCE' | 'CATEGORY'
        root_path: string
        rel_path: string
      }>(
        `SELECT i.id AS image_id, i.content_hash, f.id AS file_id, f.root_id, r.kind AS root_kind, r.path AS root_path, f.rel_path
           FROM image i
           JOIN image_file f ON f.image_id = i.id AND f.delete_state = 0 AND f.status = 'NORMAL'
           JOIN library_root r ON r.id = f.root_id AND r.delete_state = 0
          WHERE i.delete_state = 0
            AND i.is_r18 = false
            AND NOT EXISTS (
              SELECT 1 FROM image_ai_result a
              WHERE a.image_id = i.id AND a.delete_state = 0
                AND EXISTS (
                  SELECT 1 FROM jsonb_each_text(coalesce(a.field_status, '{}'::jsonb)) AS fs
                  WHERE fs.value = 'PENDING' AND (NOT i.is_r18 OR fs.key <> 'dir')
                )
            )
            AND (
              EXISTS (
                SELECT 1 FROM image_tag it
                WHERE it.image_id = i.id AND it.delete_state = 0 AND it.status = 'ACCEPTED'
              )
              OR EXISTS (
                SELECT 1 FROM image_file fc
                JOIN library_root rc ON rc.id = fc.root_id
                WHERE fc.image_id = i.id AND fc.delete_state = 0 AND fc.status = 'NORMAL'
                  AND rc.delete_state = 0 AND rc.kind = 'CATEGORY'
              )
            )
          ORDER BY i.id, f.id`
      )

    const byImage = new Map<number, { contentHash: string; files: OrganizedFileRow[] }>()
    for (const r of res.rows) {
      const imageId = Number(r.image_id)
      const entry = byImage.get(imageId) ?? { contentHash: r.content_hash, files: [] }
      entry.files.push({
        imageId,
        contentHash: r.content_hash,
        fileId: Number(r.file_id),
        rootId: Number(r.root_id),
        rootKind: r.root_kind,
        rootPath: r.root_path,
        relPath: r.rel_path
      })
      byImage.set(imageId, entry)
    }

    if (byImage.size === 0) {
      return { resetImages: 0, removedCopies: 0, movedToSource: 0, skippedOnlyInCategory: 0 }
    }

    const sourceRoots = await findActiveRootsByKind('SOURCE')
    const onlineSourceRoots: typeof sourceRoots = []
    for (const sr of sourceRoots) {
      if (await isDirOnline(sr.path)) {
        onlineSourceRoots.push(sr)
      }
    }
    const onlineSourceIds = new Set(onlineSourceRoots.map((r) => r.id))

    const retiredFileIds: number[] = []
    const relocatedFiles: Array<{ fileId: number; rootId: number; relPath: string }> = []
    const resetImageIds: number[] = []
    let removedCopies = 0
    let movedToSource = 0
    let skippedOnlyInCategory = 0

    const commitDbChanges = async (): Promise<void> => {
      if (retiredFileIds.length === 0 && relocatedFiles.length === 0 && resetImageIds.length === 0) {
        return
      }
      await db.transaction(async (tx) => {
        for (let i = 0; i < retiredFileIds.length; i += DB_CHUNK) {
          const chunk = retiredFileIds.slice(i, i + DB_CHUNK)
          await tx.update(imageFile).set({ status: 'DELETED', deleteState: 1 }).where(inArray(imageFile.id, chunk))
        }
        for (const moved of relocatedFiles) {
          await retireRowsAt(tx, moved.rootId, moved.relPath)
          await relocateImageFile(tx, moved.fileId, moved.rootId, moved.relPath)
        }
        for (let i = 0; i < resetImageIds.length; i += DB_CHUNK) {
          const chunk = resetImageIds.slice(i, i + DB_CHUNK)
          await tx
            .update(image)
            .set({ displayName: null, description: null, source: null })
            .where(inArray(image.id, chunk))
          await tx
            .update(imageTag)
            .set({ deleteState: 1 })
            .where(and(inArray(imageTag.imageId, chunk), eq(imageTag.deleteState, 0)))
          await tx
            .update(imageAiResult)
            .set({ deleteState: 1 })
            .where(and(inArray(imageAiResult.imageId, chunk), eq(imageAiResult.deleteState, 0)))
          await tx
            .update(aiJob)
            .set({ status: 'CANCELLED', finishedAt: new Date() })
            .where(
              and(
                eq(aiJob.kind, 'LOOK'),
                eq(aiJob.deleteState, 0),
                inArray(aiJob.imageId, chunk),
                inArray(aiJob.status, ['QUEUED', 'FAILED'])
              )
            )
        }
      })
      bumpLibraryVersion()
    }

    try {
      for (const [imageId, entry] of byImage) {
        const catFiles = entry.files.filter((f) => f.rootKind === 'CATEGORY')
        const srcFiles = entry.files.filter((f) => f.rootKind === 'SOURCE')

        if (catFiles.length === 0) {
          resetImageIds.push(imageId)
          continue
        }

        let hasValidSource = false
        for (const sf of srcFiles) {
          if (!onlineSourceIds.has(sf.rootId)) continue
          if (await isValidSourceFile(join(sf.rootPath, sf.relPath), entry.contentHash)) {
            hasValidSource = true
            break
          }
        }

        if (hasValidSource) {
          for (const cf of catFiles) {
            const trashed = await trashCategoryFile(join(cf.rootPath, cf.relPath), cf.rootPath)
            retiredFileIds.push(cf.fileId)
            if (trashed) removedCopies += 1
          }
          resetImageIds.push(imageId)
          continue
        }

        if (onlineSourceRoots.length === 0) {
          skippedOnlyInCategory += 1
          continue
        }

        let primaryCat: OrganizedFileRow | null = null
        for (const cf of catFiles) {
          if (await isFilePresent(join(cf.rootPath, cf.relPath))) {
            primaryCat = cf
            break
          }
        }
        if (!primaryCat) {
          skippedOnlyInCategory += 1
          continue
        }

        const targetRoot = onlineSourceRoots[0]
        const catAbs = join(primaryCat.rootPath, primaryCat.relPath)
        const fileName = basename(primaryCat.relPath)
        let destPath: string | null = null
        for (let n = 1; n <= MAX_SUFFIX; n++) {
          const to = candidate(targetRoot.path, fileName, n)
          try {
            await publishExclusive(catAbs, to)
            await retryOnWinBusy(() => unlink(catAbs))
            destPath = to
            break
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          }
        }
        if (!destPath) {
          throw new BizError('CONFLICT', `源目录同名文件过多：${fileName}`)
        }

        relocatedFiles.push({
          fileId: primaryCat.fileId,
          rootId: targetRoot.id,
          relPath: relative(targetRoot.path, destPath)
        })
        movedToSource += 1

        for (const other of catFiles) {
          if (other.fileId === primaryCat.fileId) continue
          const trashed = await trashCategoryFile(join(other.rootPath, other.relPath), other.rootPath)
          retiredFileIds.push(other.fileId)
          if (trashed) removedCopies += 1
        }

        resetImageIds.push(imageId)
      }
    } finally {
      await commitDbChanges()
    }

    log.info(
      `归回源目录：重置 ${resetImageIds.length} 张，移回源目录 ${movedToSource} 张，清理副本 ${removedCopies} 份，跳过 ${skippedOnlyInCategory} 张`
    )
      return {
        resetImages: resetImageIds.length,
        removedCopies,
        movedToSource,
        skippedOnlyInCategory
      }
    })
  } finally {
    resettingOrganized = false
  }
}

// 模式 2：已整理图片携带已有信息上下文重新看图，结果进“AI 建议”
export async function startReorganizeRelook(): Promise<ReorganizeRelookResultVO> {
  if (!readCloudCredentials().dashscopeApiKey) {
    throw new BizError('DEPENDENCY_FAILED', LOOK_KEY_HINT)
  }
  await assertIdleForReorganize()
  if (isRatingBusy()) {
    throw new BizError('CONFLICT', '本地分级还在进行，判完才能重新整理')
  }

  const { db } = getDatabase()
  const enqueued = await db.transaction(async (tx) => {
    const {
      rows: [ratingRow]
    } = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ${image} where ${organizedWhereSql} and ${ratingCandidateSql}`
    )
    const ratingLeft = Number(ratingRow?.n ?? 0)
    if (ratingLeft > 0) {
      throw new BizError('CONFLICT', `本地分级还剩 ${ratingLeft.toLocaleString('zh-CN')} 张，判完才能重新整理`)
    }

    const candidatesRes = await tx.execute<{ id: number }>(
      sql`select ${col(image.id)} as id from ${image}
          where ${organizedWhereSql} and ${cloudAllowedSql} and not ${hasOpenLookSql}
          order by ${col(image.id)} asc`
    )
    const ids = candidatesRes.rows.map((r) => Number(r.id))
    if (ids.length === 0) {
      return 0
    }

    for (let i = 0; i < ids.length; i += DB_CHUNK) {
      const chunk = ids.slice(i, i + DB_CHUNK)
      await tx
        .update(aiJob)
        .set({ status: 'CANCELLED', remoteId: null })
        .where(
          and(
            eq(aiJob.kind, 'LOOK'),
            eq(aiJob.status, 'FAILED'),
            inArray(aiJob.imageId, chunk),
            sql`${aiJob.error} is distinct from ${LOOK_CONTENT_REJECTED}`
          )
        )
    }

    for (let i = 0; i < ids.length; i += 500) {
      await tx.insert(aiJob).values(
        ids.slice(i, i + 500).map((imageId) => ({
          kind: 'LOOK' as const,
          imageId,
          priority: 0,
          payload: { reorganize: true }
        }))
      )
    }
    return ids.length
  })

  if (enqueued > 0) {
    log.info(`重新 AI 整理：排进 ${enqueued} 张参考上下文重看`)
    scheduleLook()
  }
  return { enqueued }
}
