import {
  NAME_MAX,
  TAG_NAME_MAX,
  TAGS_PER_IMAGE,
  type AddTagDTO,
  type AddTagResultVO,
  type ImageTagVO,
  type TagCatalogVO
} from '@shared/api'
import { BizError } from '../common/bizError'
import { getDatabase } from '../db/client'
import { updateDisplayName, updateR18 } from '../repositories/imageRepository'
import {
  acceptImageTags,
  countAcceptedTags,
  findAliases,
  findCategories,
  findCategoryById,
  findExistingImageIds,
  findImageTagLinks,
  findTagByNameOrAlias,
  findTagsWithCount,
  findTagsOfImages,
  insertImageTags,
  insertTag,
  removeImageTags
} from '../repositories/tagRepository'

// 一次最多改多少张（和多选上限一致）
const MAX_BATCH = 200
// 新标签没指定分类时放进这个分类
const DEFAULT_CATEGORY = '主题'

// 字数：按字符算（一个中文、一个表情都算一个字）
export function charCount(s: string): number {
  return Array.from(s).length
}

// 校验图片 id 列表：整数、去重、不超过上限，且图都还在库里
async function checkImageIds(raw: unknown): Promise<number[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => !Number.isInteger(v))) {
    throw new BizError('BAD_REQUEST', '没有选中图片')
  }
  const ids = [...new Set(raw as number[])]
  if (ids.length > MAX_BATCH) {
    throw new BizError('BAD_REQUEST', `一次最多改 ${MAX_BATCH} 张`)
  }
  const existing = await findExistingImageIds(ids)
  if (existing.length === 0) {
    throw new BizError('NOT_FOUND', '这些图已经不在图库里了')
  }
  return existing
}

// 全部分类和标签（含别名、图片数）
export async function getTagCatalog(): Promise<TagCatalogVO> {
  const [categories, tags, aliases] = await Promise.all([findCategories(), findTagsWithCount(), findAliases()])
  const aliasMap = new Map<number, string[]>()
  for (const a of aliases) {
    aliasMap.set(a.tagId, [...(aliasMap.get(a.tagId) ?? []), a.name])
  }
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, colorIndex: c.colorIndex, sortOrder: c.sortOrder })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, categoryId: t.categoryId, aliases: aliasMap.get(t.id) ?? [], count: t.count }))
  }
}

// 改名字：去掉首尾空格；清空表示用回文件名；超过 15 个字拒绝（界面上计数变红、不让保存，这里是兜底）
export async function renameImage(imageId: number, raw: unknown): Promise<string | null> {
  const [id] = await checkImageIds([imageId])
  if (raw !== null && typeof raw !== 'string') {
    throw new BizError('BAD_REQUEST', '名字不对')
  }
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (charCount(name) > NAME_MAX) {
    throw new BizError('BAD_REQUEST', `名字最多 ${NAME_MAX} 个字`)
  }
  const value = name === '' ? null : name
  await updateDisplayName(id, value)
  return value
}

// 批量标记 / 取消 R-18
export async function setR18(imageIds: unknown, value: unknown): Promise<number> {
  if (typeof value !== 'boolean') {
    throw new BizError('BAD_REQUEST', 'R-18 开关的值不对')
  }
  const ids = await checkImageIds(imageIds)
  await updateR18(ids, value)
  return ids.length
}

// 给图加标签：名字或别名命中已有标签就用它（分类不变），否则在指定分类下新建；已有的不重复加，已满 5 个的跳过
export async function addTag(dto: AddTagDTO): Promise<AddTagResultVO> {
  if (!dto || typeof dto.name !== 'string') {
    throw new BizError('BAD_REQUEST', '标签名不对')
  }
  const name = dto.name.trim().replace(/\s+/g, ' ')
  if (name === '') {
    throw new BizError('BAD_REQUEST', '标签名不能是空的')
  }
  if (charCount(name) > TAG_NAME_MAX) {
    throw new BizError('BAD_REQUEST', `标签名最多 ${TAG_NAME_MAX} 个字`)
  }
  const ids = await checkImageIds(dto.imageIds)
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    let found = await findTagByNameOrAlias(tx, name)
    if (!found) {
      const categoryId = await categoryForNewTag(tx, dto.categoryId)
      found = await insertTag(tx, name, categoryId)
    }
    const links = await findImageTagLinks(tx, ids, found.id)
    const accepted = new Set(links.filter((l) => l.status === 'ACCEPTED').map((l) => l.imageId))
    const counts = await countAcceptedTags(tx, ids)
    const todo = ids.filter((id) => !accepted.has(id))
    const room = todo.filter((id) => (counts.get(id) ?? 0) < TAGS_PER_IMAGE)
    const pendingLinks = links.filter((l) => l.status !== 'ACCEPTED' && room.includes(l.imageId))
    const linked = new Set(pendingLinks.map((l) => l.imageId))
    await acceptImageTags(
      tx,
      pendingLinks.map((l) => l.id)
    )
    await insertImageTags(
      tx,
      room.filter((id) => !linked.has(id)),
      found.id
    )
    return {
      tag: { id: found.id, name: found.name, categoryId: found.categoryId },
      added: room.length,
      already: accepted.size,
      skipped: todo.length - room.length
    }
  })
}

// 新标签放进哪个分类：指定了就用指定的（必须存在），否则放进“主题”，没有“主题”就放第一个分类
async function categoryForNewTag(
  tx: Parameters<typeof findCategoryById>[0],
  categoryId: number | undefined
): Promise<number> {
  if (categoryId !== undefined) {
    if (!Number.isInteger(categoryId) || !(await findCategoryById(tx, categoryId))) {
      throw new BizError('BAD_REQUEST', '这个标签分类不存在')
    }
    return categoryId
  }
  const categories = await findCategories(tx)
  const fallback = categories.find((c) => c.name === DEFAULT_CATEGORY) ?? categories[0]
  if (!fallback) {
    throw new BizError('DEPENDENCY_FAILED', '还没有任何标签分类')
  }
  return fallback.id
}

// 从图上移除一个标签（标签本身留在字典里，在标签管理里删）
export async function removeTag(imageIds: unknown, tagId: unknown): Promise<number> {
  if (!Number.isInteger(tagId)) {
    throw new BizError('BAD_REQUEST', '标签 id 不对')
  }
  const ids = await checkImageIds(imageIds)
  return removeImageTags(ids, tagId as number)
}

// 多选时的共同标签：每张图上都有的标签，按第一张图上的顺序
export async function getCommonTags(imageIds: unknown): Promise<ImageTagVO[]> {
  const ids = await checkImageIds(imageIds)
  const rows = await findTagsOfImages(ids)
  const byImage = new Map<number, Set<number>>()
  for (const r of rows) {
    byImage.set(r.imageId, (byImage.get(r.imageId) ?? new Set()).add(r.id))
  }
  const seen = new Set<number>()
  return rows
    .filter((r) => {
      if (seen.has(r.id) || !ids.every((id) => byImage.get(id)?.has(r.id))) {
        return false
      }
      seen.add(r.id)
      return true
    })
    .map((r) => ({ id: r.id, name: r.name, categoryId: r.categoryId }))
}
