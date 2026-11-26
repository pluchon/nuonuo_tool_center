import { sql } from 'drizzle-orm'
import { aiJob, image, imageFile, imageTag, libraryRoot } from '../db/schema'
import { col } from '../db/sqlUtil'

// 共享的图库核心过滤 SQL 谓词，避免多处仓储与服务各自维护导致漂移

export const hasNormalFileSql = sql`exists (
  select 1 from ${imageFile}
  join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
  where ${col(imageFile.imageId)} = ${col(image.id)}
    and ${col(imageFile.deleteState)} = 0
    and ${col(imageFile.status)} = 'NORMAL'
    and ${col(libraryRoot.deleteState)} = 0
)`

export const inCategorySql = sql`exists (
  select 1 from ${imageFile}
  join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
  where ${col(imageFile.imageId)} = ${col(image.id)}
    and ${col(imageFile.deleteState)} = 0
    and ${col(imageFile.status)} = 'NORMAL'
    and ${col(libraryRoot.deleteState)} = 0
    and ${col(libraryRoot.kind)} = 'CATEGORY'
)`

export const hasAcceptedTagSql = sql`exists (
  select 1 from ${imageTag}
  where ${col(imageTag.imageId)} = ${col(image.id)}
    and ${col(imageTag.deleteState)} = 0
    and ${col(imageTag.status)} = 'ACCEPTED'
)`

export const cloudAllowedSql = sql`(
  ${col(image.ratingSource)} = 'MANUAL'
  or (${col(image.ratingSource)} = 'MODEL' and ${col(image.rating)} in ('GENERAL', 'SENSITIVE'))
)`

export const hasOpenLookSql = sql`exists (
  select 1 from ${aiJob}
  where ${col(aiJob.imageId)} = ${col(image.id)}
    and ${col(aiJob.kind)} = 'LOOK'
    and ${col(aiJob.deleteState)} = 0
    and ${col(aiJob.status)} in ('QUEUED', 'RUNNING')
)`

export const ratingCandidateSql = sql`(
  ${col(image.ratingSource)} is null
  and ${col(image.thumbReady)} = 1
)`
