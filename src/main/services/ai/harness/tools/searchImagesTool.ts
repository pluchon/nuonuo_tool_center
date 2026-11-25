import { EMBEDDING_CONFIG } from '../../../../config/cloudConfig'
import { findTagNamesOf, hasSearchableImage } from '../../../../repositories/aiSearchRepository'
import { itemsOfImages } from '../../../galleryService'
import { contrastDescriptions, semanticVector } from '../../embeddingService'
import { ordinaryCardCaption, runSearch, specFromArgs } from '../../search/hybridSearch'
import { defineTool } from '../toolRegistry'

const BRIEF_MAX = 8

export const searchImagesTool = defineTool({
  name: 'search_images',
  description: '在本地图库里找图。范围和是否包含 R-18 由软件按用户的选择决定，不用你传。返回总数和前几张的编号、名字、标签。',
  parameters: {
    type: 'object',
    required: ['contrast'],
    // 兼容部分检索省略 contrast 的调用，缺失时由执行逻辑触发 awaitingContrast 补问或纯本地筛选
    runtimeRequired: [],
    properties: {
      character: { type: 'string', description: '角色名' },
      work: { type: 'string', description: '作品名（游戏、动画、漫画等）' },
      place: { type: 'string', description: '地点' },
      tags: { type: 'array', items: { type: 'string' }, description: '其他标签，如主题、风格' },
      keywordGroups: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description: '每一组都是必须满足的画面特征，组内只填写意思相同的表述'
      },
      visualInclude: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' },
        description: '可选。需要画面中必须具备的英文 Danbooru 视觉特征标签，如 ["blue_hair","1girl"]、["cat_ears"]、["glasses"]'
      },
      visualExclude: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' },
        description: '可选。需要从画面中排除的英文 Danbooru 视觉特征标签，如 ["fox_ears"]、["headphones"]'
      },
      orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: '竖图、横图、方图' },
      recent: { type: 'boolean', description: '只要最近 30 天导入的' },
      excludeShown: {
        type: 'boolean',
        description: '当用户说“还有其他的吗”“换几张”“看过了”“再找别的”等想看没展示过的图时设为 true，自动排除本段对话已经展示过的图片。'
      },
      excludeIds: {
        type: 'array',
        items: { type: 'integer' },
        maxItems: 50,
        description: '要额外排除的图片编号。'
      },
      answerFromResults: { type: 'boolean', description: '用户明确要求根据检索结果比较、解读或按指定格式回答时设为 true。只找图时省略。' },
      onMatch: {
        type: 'string',
        description: '可选。确实找到图时随卡片说的一句简短回应，可以呼应用户语气、写个颜文字。不要提前描述图片、统计数量或复述条件。'
      },
      semantic: { type: 'string', description: '一句话的画面描述，按画面相似度再找一路' },
      contrast: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string' },
        description: '提供 semantic 时必填一至两个反例。优先同一类别内最易混淆的特征，不可重复正例或给出相距很远的场景。没有画面描述时填 []。'
      }
    }
  },
  async execute(rawArgs, env, state) {
    const pending = state.awaitingContrast
    const args = pending ? { ...pending, contrast: rawArgs.contrast } : rawArgs
    const { spec, conds } = specFromArgs(args, env.tags, env.query)
    const semanticText = typeof args.semantic === 'string' ? args.semantic.trim().slice(0, 100) : ''
    if (semanticText && !pending && !contrastDescriptions(semanticText, args.contrast).length) {
      return {
        content: JSON.stringify({ error: '画面检索缺少有效的 contrast。请重新调用 search_images，只补充一至两条最容易混淆的相似画面，保留原有条件。' }),
        outcome: { type: 'awaiting_contrast', args }
      }
    }
    const semantic = await semanticVector(semanticText, args.contrast)
    // 即使普通图可按向量检索，画面描述也要参与本地元数据匹配，覆盖无向量和 R-18 图片。
    if (semanticText && !spec.keywordGroups.length && !spec.visualInclude?.length) {
      spec.keywordGroups.push([semanticText.toLowerCase()])
      if (!semantic) conds.push(['关键词', semanticText])
    }
    const literal =
      spec.tagGroups.length > 0 ||
      spec.keywordGroups.length > 0 ||
      !!spec.requiredWords?.length ||
      !!spec.visualInclude?.length ||
      !!spec.visualExclude?.length ||
      !!spec.orientation ||
      !!spec.recent ||
      !!spec.untagged
    if (!literal && !semantic) {
      return {
        content: JSON.stringify({ error: '没有可用的检索条件，请给出标签、关键词或画面描述' }),
        outcome: { type: 'none' }
      }
    }
    let candidates = env.candidateIds
    if (env.modelReferences) {
      const allowed = new Set(env.modelReferences.map((ref) => ref.imageId))
      candidates = candidates ? candidates.filter((id) => allowed.has(id)) : [...allowed]
    }
    const outcome = await runSearch(spec, env.dirs, env.includeR18 && !env.modelReferences, env.tags, semantic, candidates)
    if (semanticText && !semantic && (await hasSearchableImage(env.dirs, false))) {
      outcome.incomplete ??= '画面相似度检索暂不可用'
    }
    const excludeSet = new Set<number>()
    if (args.excludeShown === true && env.shownImages?.length) {
      for (const img of env.shownImages) {
        excludeSet.add(img.id)
      }
    }
    if (Array.isArray(args.excludeIds)) {
      for (const id of args.excludeIds) {
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
          excludeSet.add(id)
        }
      }
    }
    const beforeCount = outcome.imageIds.length
    if (excludeSet.size > 0 && beforeCount > 0) {
      outcome.imageIds = outcome.imageIds.filter((id) => !excludeSet.has(id))
      outcome.ordinaryIds = outcome.ordinaryIds.filter((id) => !excludeSet.has(id))
    }
    const alreadyShownCount = beforeCount - outcome.imageIds.length
    const allAlreadyShown = beforeCount > 0 && outcome.imageIds.length === 0
    if (alreadyShownCount > 0) {
      outcome.alreadyShownCount = alreadyShownCount
    }
    if (allAlreadyShown) {
      outcome.allAlreadyShown = true
    }
    // 语气属于当前对话，不随可复用的检索条件一起缓存。受保护的图片只使用本地卡片文案。
    const { onMatch, ...plan } = args
    const hasSessionDedup = args.excludeShown === true || (Array.isArray(args.excludeIds) && args.excludeIds.length > 0)
    const cacheablePlan = !hasSessionDedup && (!semanticText || semantic) ? plan : undefined
    const finalConds = semantic ? [...conds, ['画面', semanticText] as [string, string]] : conds
    const caption = ordinaryCardCaption(onMatch, outcome)
    const brief = outcome.ordinaryIds.slice(0, BRIEF_MAX)
    const tagNames = await findTagNamesOf(brief)
    const items = await itemsOfImages(brief, false, env.dirs)
    return {
      content: JSON.stringify({
        total: outcome.ordinaryIds.length,
        images: items.map((i) => ({ id: i.imageId, name: i.name, tags: tagNames.get(i.imageId) ?? [] })),
        ...(env.includeR18 ? { r18Total: outcome.imageIds.length - outcome.ordinaryIds.length } : {}),
        alreadyShownCount,
        allAlreadyShown
      }),
      outcome: {
        type: 'search',
        outcome,
        conds: finalConds,
        caption,
        needsDetails: args.answerFromResults === true || allAlreadyShown,
        cacheablePlan
      }
    }
  }
})
