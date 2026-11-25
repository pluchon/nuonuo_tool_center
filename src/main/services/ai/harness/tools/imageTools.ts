import { addImageExclusion } from '../../../../repositories/aiMemoryRepository'
import { findImageBrief, findTagNamesOf, visibleResultIds } from '../../../../repositories/aiSearchRepository'
import { scopeDirs } from '../../assistantReferences'
import { defineTool } from '../toolRegistry'
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
  const checkDirs = current ? env.dirs : await scopeDirs(env.previousResults?.scope ?? null)
  const visible = await visibleResultIds([targetId], checkIncludeR18, checkDirs)
  if (!visible.has(targetId)) {
    return { sourceIds, error: '这张图已不在原检索范围内' }
  }
  return { id: targetId, sourceIds, evidence, incomplete }
}

export const readReferencedImagesTool = defineTool({
  name: 'read_referenced_images',
  description: '按当前或最近引用的图片编号读取名称和已确认标签，保持引用顺序。',
  parameters: { type: 'object', properties: {} },
  async execute(_args, env) {
    return { content: JSON.stringify(await env.readReferences()), outcome: { type: 'metadata' } }
  }
})

export const getImageTool = defineTool({
  name: 'get_image',
  description: '查一张图的名字、文件名、尺寸、标签和描述。',
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
      const visible = await visibleResultIds([id], previous.includeR18 && env.includeR18, await scopeDirs(previous.scope))
      if (!visible.has(id)) {
        return { content: JSON.stringify({ error: '这张图已不在原检索范围内' }), outcome: { type: 'metadata' } }
      }
    }
    const brief = Number.isInteger(id) ? await findImageBrief(id, { dirs: env.dirs }) : undefined
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
        description: brief.description ?? ''
      }),
      outcome: { type: 'metadata' }
    }
  }
})

export const listTagsTool = defineTool({
  name: 'list_tags',
  description: '列出图库里的标签和别名，可以只看一个分类。',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '分类名，如角色、作品、主题、地点' }
    }
  },
  execute(args, env) {
    const category = typeof args.category === 'string' ? args.category.trim() : ''
    const list = env.tags.filter((t) => t.general && (!category || t.category === category)).slice(0, 200)
    return {
      content: JSON.stringify(list.map((t) => ({ name: t.name, category: t.category, aliases: t.aliases }))),
      outcome: { type: 'metadata' }
    }
  }
})

export const explainMatchTool = defineTool({
  name: 'explain_match',
  description: '解释检索结果中某一张图片为什么会命中当前或上一轮搜索条件。',
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
    const checkDirs = current ? env.dirs : await scopeDirs(env.previousResults?.scope ?? null)
    const visible = await visibleResultIds(resolved.sourceIds, checkIncludeR18, checkDirs)
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
