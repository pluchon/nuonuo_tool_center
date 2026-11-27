import { addImageExclusion } from '../../../../repositories/aiMemoryRepository'
import { findImageBrief, findTagNamesOf, findVocabulary, visibleResultIds } from '../../../../repositories/aiSearchRepository'
import { findCategories } from '../../../../repositories/tagRepository'
import { scopeQuery } from '../../assistantReferences'
import { defineTool, isToolError, parseToolJson, truncateLabel } from '../toolRegistry'
import type { HarnessState, ToolEnv } from '../types'

const METHOD_EXPLANATION: Record<string, string> = {
  tag: '它在当次检索中符合已确认的标签条件',
  metadata: '它的本地文字记录符合当时的关键词条件',
  vector: '它在当次检索中达到了画面向量相似度要求',
  feature: '当时的本地图片识别记录符合所选画面特征',
  filter: '它符合当时选定的图库范围和筛选条件'
}

async function resolveResultImage(
  args: Record<string, unknown>,
  env: ToolEnv,
  state: HarnessState
): Promise<{ id?: number; sourceIds: number[]; evidence?: ToolEnv['previousResults'] extends infer _ ? NonNullable<ToolEnv['previousResults']>['evidence'] : never; incomplete?: string; error?: string }> {
  const current = state.lastSearch?.outcome
  const sourceIds = current?.imageIds ?? env.previousResults?.ids ?? []
  const evidence = current?.evidence ?? env.previousResults?.evidence
  const incomplete = current?.incomplete ?? env.previousResults?.incomplete
  if (!sourceIds.length) {
    return { sourceIds, error: '当前没有可操作的检索结果' }
  }
  let targetId = typeof args.id === 'number' ? args.id : undefined
  if (args.position !== undefined) {
    const pos = Number(args.position)
    if (!Number.isSafeInteger(pos) || pos < 1 || pos > sourceIds.length) {
      return { sourceIds, error: '没有这张图' }
    }
    targetId = sourceIds[pos - 1]
  }
  if (!targetId || !sourceIds.includes(targetId)) {
    return { sourceIds, error: '请指定当前结果中有效的图片序号或编号' }
  }
  const checkIncludeR18 = current ? env.includeR18 : Boolean(env.previousResults?.includeR18 && env.includeR18)
  const prevScope = current ? undefined : await scopeQuery(env.previousResults?.scope ?? null)
  const checkDirs = current ? env.dirs : prevScope!.dirs
  const checkIncludeOrganized = current ? env.includeOrganized : prevScope!.includeOrganized
  const visible = await visibleResultIds([targetId], checkIncludeR18, checkDirs, checkIncludeOrganized)
  if (!visible.has(targetId)) {
    return { sourceIds, error: '这张图已不在原检索范围内' }
  }
  return { id: targetId, sourceIds, evidence, incomplete }
}

function formatGetImageStart(args: Record<string, unknown>): string {
  if (args.position !== undefined) return `查看第 ${args.position} 张图`
  if (args.id !== undefined) return `查看图片 #${args.id}`
  return '查看图片详情'
}

function formatListTagsStart(args: Record<string, unknown>): string {
  const category = truncateLabel(args.category, 14)
  return category ? `查看${category}标签` : '查看标签词表'
}

function formatExplainMatchStart(args: Record<string, unknown>): string {
  if (args.position !== undefined) return `核对第 ${args.position} 张命中原因`
  if (args.id !== undefined) return `核对图片 #${args.id} 命中原因`
  return '核对命中原因'
}

function formatExcludeImageStart(args: Record<string, unknown>): string {
  const target = args.position !== undefined ? `第 ${args.position} 张` : args.id !== undefined ? `#${args.id}` : '结果图'
  return args.permanent === true ? `永久排除${target}` : `本轮排除${target}`
}

export const readReferencedImagesTool = defineTool({
  name: 'read_referenced_images',
  description: '按当前或最近引用的图片编号读取名称和已确认标签，保持引用顺序。',
  sideEffect: 'read',
  formatStart: () => '读取引用图片',
  formatDone(_args, result) {
    const parsed = parseToolJson(result.content)
    return Array.isArray(parsed) ? `读取引用图片 · ${parsed.length} 张` : '读取引用图片'
  },
  parameters: { type: 'object', properties: {} },
  async execute(_args, env) {
    return { content: JSON.stringify(await env.readReferences()), outcome: { type: 'metadata' } }
  }
})

export const getImageTool = defineTool({
  name: 'get_image',
  description: '查一张图的名字、文件名、尺寸、标签和描述。',
  sideEffect: 'read',
  formatStart: formatGetImageStart,
  formatDone(args, result) {
    const start = formatGetImageStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 未找到`
    const name = truncateLabel(parsed?.name, 16)
    return name ? `查看图片：${name}` : start
  },
  parameters: {
    type: 'object',
    properties: {
      position: { type: 'integer', minimum: 1, description: '用户追问上次结果中的第几张图，从 1 开始' },
      id: { type: 'integer', description: '本轮工具已返回的图片编号。与 position 任选其一' }
    }
  },
  async execute(args, env) {
    let id = Number(args.id)
    if (env.modelReferences) {
      const targets = env.modelReferences.filter((r) =>
        args.position === undefined ? r.imageId === id : r.position === Number(args.position)
      )
      if (targets.length !== 1) return { content: JSON.stringify({ error: '请指定引用组及有效的图片编号' }), outcome: { type: 'metadata' } }
      id = targets[0].imageId
    } else if (args.position !== undefined) {
      const previous = env.previousResults
      const position = Number(args.position)
      if (!previous || !Number.isSafeInteger(position) || position < 1 || position > previous.ids.length) {
        return { content: JSON.stringify({ error: '没有这张图' }), outcome: { type: 'metadata' } }
      }
      id = previous.ids[position - 1]
      const prevScope = await scopeQuery(previous.scope)
      const visible = await visibleResultIds([id], previous.includeR18 && env.includeR18, prevScope.dirs, prevScope.includeOrganized)
      if (!visible.has(id)) {
        return { content: JSON.stringify({ error: '这张图已不在原检索范围内' }), outcome: { type: 'metadata' } }
      }
    }
    const brief = Number.isInteger(id)
      ? await findImageBrief(id, { dirs: env.dirs, includeR18: env.includeR18, includeOrganized: env.includeOrganized })
      : undefined
    if (!brief) {
      return { content: JSON.stringify({ error: '没有这张图' }), outcome: { type: 'metadata' } }
    }
    const tagNames = await findTagNamesOf([id])
    return {
      content: JSON.stringify({
        id,
        name: brief.displayName ?? brief.relPath?.split('\\').pop() ?? '',
        file: brief.relPath?.split('\\').pop() ?? '',
        size: brief.width && brief.height ? `${brief.width}×${brief.height}` : '',
        tags: tagNames.get(id) ?? [],
        ...(brief.isR18 ? { isR18: true, description: '' } : { description: brief.description ?? '' })
      }),
      outcome: { type: 'metadata' }
    }
  }
})

export const listTagsTool = defineTool({
  name: 'list_tags',
  description: '列出图库里的标签和别名，可以只看一个分类。',
  sideEffect: 'read',
  formatStart: formatListTagsStart,
  formatDone(args, result) {
    const start = formatListTagsStart(args)
    const parsed = parseToolJson(result.content)
    return Array.isArray(parsed) ? `${start} · ${parsed.length} 个` : start
  },
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '分类名，如角色、作品、主题、地点' }
    }
  },
  async execute(args, env) {
    const category = typeof args.category === 'string' ? args.category.trim() : ''
    let list: Array<{ name: string; category: string; aliases: string[] }>
    if (env.dirs?.length) {
      const [vocab, categories] = await Promise.all([findVocabulary(true, env.dirs, env.includeR18), findCategories()])
      const catName = new Map(categories.map((c) => [c.id, c.name]))
      list = vocab
        .map((t) => ({ name: t.name, category: catName.get(t.categoryId) ?? '标签', aliases: t.aliases }))
        .filter((t) => !category || t.category === category)
        .slice(0, 200)
    } else {
      list = env.tags
        .filter((t) => (env.includeR18 || t.general) && (!category || t.category === category))
        .slice(0, 200)
        .map((t) => ({ name: t.name, category: t.category, aliases: t.aliases }))
    }
    return {
      content: JSON.stringify(list),
      outcome: { type: 'metadata' }
    }
  }
})

export const explainMatchTool = defineTool({
  name: 'explain_match',
  description: '解释检索结果中某一张图片为什么会命中当前或上一轮搜索条件。',
  sideEffect: 'read',
  formatStart: formatExplainMatchStart,
  formatDone(args, result) {
    const start = formatExplainMatchStart(args)
    const parsed = parseToolJson(result.content)
    return isToolError(parsed) ? `${start} · 无记录` : `${start} · 已核对`
  },
  parameters: {
    type: 'object',
    properties: {
      position: { type: 'integer', minimum: 1, description: '结果中的第几张图，从 1 开始' },
      id: { type: 'integer', description: '图片编号，与 position 任选其一' }
    }
  },
  async execute(args, env, state) {
    const resolved = await resolveResultImage(args, env, state)
    if (!resolved.id) {
      return { content: JSON.stringify({ error: resolved.error }), outcome: { type: 'metadata' } }
    }
    const method = resolved.evidence?.methods[resolved.id]
    if (!method) {
      return { content: JSON.stringify({ error: '这张图没有保存对应检索的命中依据。' }), outcome: { type: 'metadata' } }
    }
    const tags = method === 'tag' ? resolved.evidence?.tagConditions?.join('、') : ''
    const reason = METHOD_EXPLANATION[method] + (tags ? `「${tags}」` : '') + '。'
    return {
      content: JSON.stringify({ imageId: resolved.id, method, reason }),
      outcome: { type: 'metadata' }
    }
  }
})

export const excludeImageTool = defineTool({
  name: 'exclude_image',
  description: '从当前或上一轮检索结果中排除某张图片；用户明确表示以后也不再展示时设置 permanent=true。',
  sideEffect: 'memory',
  formatStart: formatExcludeImageStart,
  formatDone(args, result) {
    const start = formatExcludeImageStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 未执行`
    return typeof parsed?.remaining === 'number' ? `${start} · 剩余 ${parsed.remaining} 张` : `${start} · 已排除`
  },
  parameters: {
    type: 'object',
    properties: {
      position: { type: 'integer', minimum: 1, description: '结果中的第几张图，从 1 开始' },
      id: { type: 'integer', description: '图片编号，与 position 任选其一' },
      permanent: { type: 'boolean', description: '是否记住并在以后所有检索中永久排除这张图' }
    }
  },
  async execute(args, env, state) {
    const resolved = await resolveResultImage(args, env, state)
    if (!resolved.id) {
      return { content: JSON.stringify({ error: resolved.error }), outcome: { type: 'metadata' } }
    }
    const permanent = args.permanent === true
    if (permanent) {
      await addImageExclusion(resolved.id, env.userMessageId)
    }
    const current = state.lastSearch?.outcome
    const checkIncludeR18 = current ? env.includeR18 : Boolean(env.previousResults?.includeR18 && env.includeR18)
    const prevScope = current ? undefined : await scopeQuery(env.previousResults?.scope ?? null)
    const checkDirs = current ? env.dirs : prevScope!.dirs
    const checkIncludeOrganized = current ? env.includeOrganized : prevScope!.includeOrganized
    const visible = await visibleResultIds(resolved.sourceIds, checkIncludeR18, checkDirs, checkIncludeOrganized)
    const imageIds = resolved.sourceIds.filter((item) => item !== resolved.id && visible.has(item))
    const text = permanent ? '记住了，以后检索时会排除这张图。' : '这次先把这张图收起来。'
    return {
      content: JSON.stringify({ ok: true, excludedImageId: resolved.id, remaining: imageIds.length, permanent }),
      outcome: {
        type: 'exclusion',
        imageIds,
        text,
        how: `本轮筛选，保留 ${imageIds.length} 张`,
        evidence: resolved.evidence,
        incomplete: resolved.incomplete
      }
    }
  }
})
