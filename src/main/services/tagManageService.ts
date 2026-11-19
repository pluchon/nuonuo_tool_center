import {
  CATEGORY_NAME_MAX,
  MERGE_MAX,
  TAG_NAME_MAX,
  type CreateTagDTO,
  type SaveTagDTO,
  type TagCategoryVO
} from '@shared/api'
import { BizError } from '../common/bizError'
import { getDatabase } from '../db/client'
import {
  countTagsInCategory,
  deleteAliases,
  deleteCategory,
  deleteTagsCascade,
  findAliasesOf,
  findCategories,
  findCategoryById,
  findNameClashes,
  findTagById,
  findTagsByIds,
  insertAliases,
  insertCategory,
  insertTag,
  moveImageTags,
  updateCategory,
  updateTag
} from '../repositories/tagRepository'
import { charCount } from './imageEditService'

// 调色板一共几种颜色
const PALETTE_SIZE = 12
// 新分类的默认名字
const NEW_CATEGORY_NAME = '新分类'

type Tx = Parameters<Parameters<ReturnType<typeof getDatabase>['db']['transaction']>[0]>[0]

// 标签名、别名的规整：去首尾空格，多个空格合成一个；空的报错，超长报错
export function normalizeTagWord(raw: unknown, what: string): string {
  if (typeof raw !== 'string') {
    throw new BizError('BAD_REQUEST', `${what}不对`)
  }
  const word = raw.trim().replace(/\s+/g, ' ')
  if (word === '') {
    throw new BizError('BAD_REQUEST', `${what}不能是空的`)
  }
  if (charCount(word) > TAG_NAME_MAX) {
    throw new BizError('BAD_REQUEST', `${what}最多 ${TAG_NAME_MAX} 个字`)
  }
  return word
}

// 别名列表：逐个规整，去掉和标签名相同的、互相重复的（不区分大小写）
function normalizeAliases(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw)) {
    throw new BizError('BAD_REQUEST', '别名不对')
  }
  const seen = new Set([name.toLowerCase()])
  const out: string[] = []
  for (const a of raw) {
    const word = normalizeTagWord(a, '别名')
    if (!seen.has(word.toLowerCase())) {
      seen.add(word.toLowerCase())
      out.push(word)
    }
  }
  return out
}

// 名字和别名不能和别的标签的名字或别名撞上
async function assertNoClash(tx: Tx, name: string, aliases: string[], excludeTagIds: number[]): Promise<void> {
  const clashes = await findNameClashes(tx, [name, ...aliases], excludeTagIds)
  if (clashes.length > 0) {
    const c = clashes[0]
    throw new BizError(
      'CONFLICT',
      c.word.toLowerCase() === c.owner.toLowerCase() ? `已经有标签「${c.owner}」了` : `「${c.word}」已经是标签「${c.owner}」的别名了`
    )
  }
}

// 分类必须存在
async function assertCategory(tx: Tx, categoryId: unknown): Promise<number> {
  if (!Number.isInteger(categoryId) || !(await findCategoryById(tx, categoryId as number))) {
    throw new BizError('BAD_REQUEST', '这个标签分类不存在')
  }
  return categoryId as number
}

// 把标签的别名整组换成 next：去掉不在里面的，补上新的
async function replaceAliases(tx: Tx, tagId: number, next: string[]): Promise<void> {
  const current = await findAliasesOf(tx, [tagId])
  const wanted = new Set(next.map((a) => a.toLowerCase()))
  const have = new Set(current.map((a) => a.name.toLowerCase()))
  await deleteAliases(
    tx,
    current.filter((a) => !wanted.has(a.name.toLowerCase())).map((a) => a.id)
  )
  await insertAliases(
    tx,
    tagId,
    next.filter((a) => !have.has(a.toLowerCase()))
  )
}

// 新建标签
export async function createTag(dto: CreateTagDTO): Promise<number> {
  const name = normalizeTagWord(dto?.name, '标签名')
  const aliases = normalizeAliases(dto.aliases ?? [], name)
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    const categoryId = await assertCategory(tx, dto.categoryId)
    await assertNoClash(tx, name, aliases, [])
    const created = await insertTag(tx, name, categoryId)
    await insertAliases(tx, created.id, aliases)
    return created.id
  })
}

// 保存标签：改名、换分类、别名整组替换；可同时合并。返回保存后要选中的标签 id
// 合并进来：来源标签的图改挂到这个标签上，来源的名字和别名变成这个标签的别名，来源标签删掉
// 并入其他标签：这个标签的图改挂到目标上，它的名字和别名变成目标的别名，这个标签删掉（改名和换分类不再有意义，忽略）
export async function saveTag(dto: SaveTagDTO): Promise<number> {
  if (!dto || !Number.isInteger(dto.id)) {
    throw new BizError('BAD_REQUEST', '标签 id 不对')
  }
  const mergeFrom = [...new Set(dto.mergeFrom ?? [])]
  if (mergeFrom.some((id) => !Number.isInteger(id) || id === dto.id)) {
    throw new BizError('BAD_REQUEST', '要合并的标签不对')
  }
  if (mergeFrom.length > MERGE_MAX) {
    throw new BizError('BAD_REQUEST', `一次最多合并 ${MERGE_MAX} 个标签`)
  }
  const mergeInto = dto.mergeInto ?? null
  if (mergeInto !== null && (!Number.isInteger(mergeInto) || mergeInto === dto.id || mergeFrom.length > 0)) {
    throw new BizError('BAD_REQUEST', '要并入的标签不对')
  }
  const name = normalizeTagWord(dto.name, '标签名')
  const aliases = normalizeAliases(dto.aliases ?? [], name)
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    const self = await findTagById(tx, dto.id)
    if (!self) {
      throw new BizError('NOT_FOUND', '这个标签已经不在了')
    }
    if (mergeInto !== null) {
      const target = await findTagById(tx, mergeInto)
      if (!target) {
        throw new BizError('NOT_FOUND', '要并入的标签已经不在了')
      }
      // 先删掉自己（释放名字和别名的唯一约束），再把它们挂到目标上
      await moveImageTags(tx, [self.id], target.id)
      await deleteTagsCascade(tx, [self.id])
      const targetAliases = (await findAliasesOf(tx, [target.id])).map((a) => a.name)
      const extra = await usableWords(tx, [self.name, ...aliases], target)
      await replaceAliases(tx, target.id, mergeWords(targetAliases, extra, target.name))
      return target.id
    }
    const categoryId = await assertCategory(tx, dto.categoryId)
    const sources = await findTagsByIds(tx, mergeFrom)
    if (sources.length !== mergeFrom.length) {
      throw new BizError('NOT_FOUND', '要合并的标签有的已经不在了')
    }
    const sourceAliases = (await findAliasesOf(tx, mergeFrom)).map((a) => a.name)
    await assertNoClash(tx, name, aliases, [self.id, ...mergeFrom])
    await moveImageTags(tx, mergeFrom, self.id)
    await deleteTagsCascade(tx, mergeFrom)
    await updateTag(tx, self.id, name, categoryId)
    const inherited = await usableWords(
      tx,
      [...sources.map((s) => s.name), ...sourceAliases],
      { id: self.id, name }
    )
    await replaceAliases(tx, self.id, mergeWords(aliases, inherited, name))
    return self.id
  })
}

// 合并时继承过来的名字和别名：和别的标签撞上的不要
async function usableWords(tx: Tx, words: string[], owner: { id: number; name: string }): Promise<string[]> {
  const clashes = new Set((await findNameClashes(tx, words, [owner.id])).map((c) => c.word.toLowerCase()))
  return words.filter((w) => !clashes.has(w.toLowerCase()))
}

// 两组别名合在一起：去重（不区分大小写），去掉和标签名相同的
function mergeWords(base: string[], extra: string[], name: string): string[] {
  const seen = new Set([name.toLowerCase()])
  const out: string[] = []
  for (const w of [...base, ...extra]) {
    if (!seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase())
      out.push(w)
    }
  }
  return out
}

// 删除标签：从所有图上去掉，连同别名；图片本身不动。返回受影响的图片张数
export async function deleteTag(id: unknown): Promise<number> {
  if (!Number.isInteger(id)) {
    throw new BizError('BAD_REQUEST', '标签 id 不对')
  }
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    if (!(await findTagById(tx, id as number))) {
      throw new BizError('NOT_FOUND', '这个标签已经不在了')
    }
    return deleteTagsCascade(tx, [id as number])
  })
}

// 分类名规整：去首尾空格，不能空、不能超长
function normalizeCategoryName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BizError('BAD_REQUEST', '分类名不对')
  }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name === '') {
    throw new BizError('BAD_REQUEST', '分类名不能是空的')
  }
  if (charCount(name) > CATEGORY_NAME_MAX) {
    throw new BizError('BAD_REQUEST', `分类名最多 ${CATEGORY_NAME_MAX} 个字`)
  }
  return name
}

// 新增分类：名字“新分类”（重名加编号），颜色随机取一个还没被占用的，排在最后
export async function createCategory(): Promise<TagCategoryVO> {
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    const all = await findCategories(tx)
    const names = new Set(all.map((c) => c.name.toLowerCase()))
    let name = NEW_CATEGORY_NAME
    for (let n = 2; names.has(name.toLowerCase()); n++) {
      name = `${NEW_CATEGORY_NAME} ${n}`
    }
    const used = new Set(all.map((c) => c.colorIndex))
    const free = Array.from({ length: PALETTE_SIZE }, (_, i) => i).filter((i) => !used.has(i))
    const pool = free.length > 0 ? free : Array.from({ length: PALETTE_SIZE }, (_, i) => i)
    const colorIndex = pool[Math.floor(Math.random() * pool.length)]
    const sortOrder = all.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 1
    const row = await insertCategory(tx, name, colorIndex, sortOrder)
    return { id: row.id, name: row.name, colorIndex: row.colorIndex, sortOrder: row.sortOrder }
  })
}

// 分类改名：不区分大小写不能重名
export async function renameCategory(id: unknown, raw: unknown): Promise<string> {
  const name = normalizeCategoryName(raw)
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    const categoryId = await assertCategory(tx, id)
    const all = await findCategories(tx)
    if (all.some((c) => c.id !== categoryId && c.name.toLowerCase() === name.toLowerCase())) {
      throw new BizError('CONFLICT', `已经有分类「${name}」了`)
    }
    await updateCategory(tx, categoryId, { name })
    return name
  })
}

// 换分类颜色（允许和别的分类撞色）
export async function setCategoryColor(id: unknown, colorIndex: unknown): Promise<void> {
  if (!Number.isInteger(colorIndex) || (colorIndex as number) < 0 || (colorIndex as number) >= PALETTE_SIZE) {
    throw new BizError('BAD_REQUEST', '颜色不对')
  }
  const { db } = getDatabase()
  await db.transaction(async (tx) => {
    const categoryId = await assertCategory(tx, id)
    await updateCategory(tx, categoryId, { colorIndex: colorIndex as number })
  })
}

// 删除分类：还有标签在用、或者只剩这一个分类时不能删
export async function removeCategory(id: unknown): Promise<void> {
  const { db } = getDatabase()
  await db.transaction(async (tx) => {
    const categoryId = await assertCategory(tx, id)
    if ((await countTagsInCategory(tx, categoryId)) > 0) {
      throw new BizError('CONFLICT', '还有标签在用，先把它们改到别的分类')
    }
    if ((await findCategories(tx)).length <= 1) {
      throw new BizError('CONFLICT', '至少要留一个分类')
    }
    await deleteCategory(tx, categoryId)
  })
}
