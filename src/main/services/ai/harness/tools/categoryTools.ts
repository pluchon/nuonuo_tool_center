import { describeProposal, getCategoryProposal, listCategoryPaths, prepareCategoryAction } from '../../categoryProposalService'
import { defineTool, isToolError, parseToolJson, truncateLabel } from '../toolRegistry'
import { directoryFeedback, type ToolEnv } from '../types'

export async function previousReceipt(env: Pick<ToolEnv, 'previousProposal'>): Promise<string> {
  const p = env.previousProposal
  return p ? describeProposal(await getCategoryProposal(p.id, p.messageId)) : '当前没有可以核对的目录提案。'
}

function formatCategoryPathsStart(args: Record<string, unknown>): string {
  const prefix = truncateLabel(args.prefix, 16)
  return prefix ? `核对类目录：${prefix}` : '核对类目录'
}

function formatProposeStart(args: Record<string, unknown>): string {
  const path = truncateLabel(args.path, 14)
  const scope = truncateLabel(args.scope, 14)
  switch (args.kind) {
    case 'analyze':
      return scope ? `规划类目录：${scope}` : '规划类目录'
    case 'create':
      return path ? `准备创建目录：${path}` : '准备创建目录'
    case 'move':
      return path ? `准备迁移目录：${path}` : '准备迁移目录'
    case 'file':
      return path ? `准备归档到：${path}` : '准备图片归档提案'
    case 'status':
      return '核对目录提案状态'
    case 'continue_chat':
      return '继续对话'
    default:
      return '处理类目录操作'
  }
}

export const listCategoryPathsTool = defineTool({
  name: 'list_category_paths',
  description: '读取图库已有类目录的相对路径，包括子目录，可用 prefix 限定父目录。',
  sideEffect: 'read',
  formatStart: formatCategoryPathsStart,
  formatDone(args, result) {
    const start = formatCategoryPathsStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 读取失败`
    if (typeof parsed?.total === 'number') return `${start} · ${parsed.total} 个目录`
    return start
  },
  parameters: {
    type: 'object',
    properties: {
      prefix: { type: 'string' }
    }
  },
  async execute(args, env) {
    const paths = await listCategoryPaths(typeof args.prefix === 'string' && args.prefix ? args.prefix : env.selectedCategory).catch(
      directoryFeedback
    )
    return {
      content: JSON.stringify(Array.isArray(paths) ? { total: paths.length, paths: paths.slice(0, 160) } : { error: paths.text }),
      outcome: { type: 'none' }
    }
  }
})

export const proposeCategoryChangeTool = defineTool({
  name: 'propose_category_change',
  description:
    '根据已确认标签规划类目录，或准备创建、迁移子目录。紧接提案的下一轮按用户本意选择：询问执行情况选 status，要求把图放入目录选 file，其他对话或其他工具请求选 continue_chat。file 操作为引用图片建立归档复制提案。用户在卡片中确认后执行。',
  sideEffect: 'proposal',
  formatStart: formatProposeStart,
  formatDone(args, result) {
    const start = formatProposeStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 未完成`
    if (args.kind === 'status') return '核对目录提案状态 · 已获取'
    if (args.kind === 'continue_chat') return '继续对话'
    if (result.outcome?.type === 'proposal') {
      return result.outcome.proposal.categoryProposalId ? `${start} · 已生成提案` : `${start} · 已核对`
    }
    return start
  },
  parameters: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['analyze', 'create', 'move', 'file', 'status', 'continue_chat'] },
      imageIds: {
        type: 'array',
        items: { type: 'integer' },
        description: 'file 操作中用户指定的引用图片编号。应先查询引用，多张引用时不得自行扩大范围。'
      },
      scope: { type: 'string', description: '只分析指定类目录中的图片时传入其相对路径，例如 A/B。' },
      path: {
        type: 'string',
        description: '要创建或迁移的类目录相对路径。file 时仅在用户指定目标时填写，省略则按已确认标签匹配现有目录。'
      },
      targetParent: { type: 'string', description: '迁移目标的父目录路径，迁移后保留原目录名。' }
    }
  },
  async execute(args, env) {
    if (args.kind === 'continue_chat') {
      return { content: '继续按用户本轮问题回答。', outcome: { type: 'none' } }
    }
    if (args.kind === 'status') {
      const proposal = { text: await previousReceipt(env) }
      return { content: JSON.stringify(proposal), outcome: { type: 'proposal', proposal } }
    }
    if (args.kind === 'file') {
      const refs = await env.readReferences()
      const ids = args.imageIds ?? (refs.length === 1 ? [refs[0].imageId] : [])
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        !ids.every((id) => refs.some((r) => r.imageId === id)) ||
        (args.path !== undefined && typeof args.path !== 'string')
      ) {
        const proposal = { text: '请选择要归档的图片。' }
        return { content: JSON.stringify(proposal), outcome: { type: 'proposal', proposal } }
      }
      const proposal = await prepareCategoryAction(
        { kind: 'file', ids: ids as number[], path: args.path as string | undefined },
        env.selectedCategory,
        env.userMessageId
      ).catch(directoryFeedback)
      return { content: JSON.stringify(proposal), outcome: { type: 'proposal', proposal } }
    }
    const { kind, scope, path, targetParent } = args
    const action =
      kind === 'analyze' && (scope === undefined || typeof scope === 'string')
        ? ({ kind, scope } as const)
        : kind === 'create' && typeof path === 'string'
          ? ({ kind, path } as const)
          : kind === 'move' && typeof path === 'string' && typeof targetParent === 'string'
            ? ({ kind, path, targetParent } as const)
            : null
    if (!action) {
      return { content: JSON.stringify({ error: '请提供操作所需的类目录相对路径。' }), outcome: { type: 'none' } }
    }
    const proposal = await prepareCategoryAction(action, env.selectedCategory, env.userMessageId).catch(directoryFeedback)
    return { content: JSON.stringify({ message: proposal.text }), outcome: { type: 'proposal', proposal } }
  }
})
