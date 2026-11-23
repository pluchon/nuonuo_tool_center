import { cachedFeatureMatches, searchImages, type AiSearchFilter } from '../../repositories/aiSearchRepository'
import { FEATURE_REVISION, getVisualTagsForSearch } from '../rating/ratingService'

const hairColors: Record<string, string> = {
  蓝: 'blue', 红: 'red', 白: 'white', 黑: 'black', 粉: 'pink', 绿: 'green',
  紫: 'purple', 金: 'blonde', 棕: 'brown', 灰: 'grey', 橙: 'orange'
}
const girls = ['1girl', '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple_girls']
const boys = ['1boy', '2boys', '3boys', '4boys', '5boys', '6+boys', 'multiple_boys']

// 可明确映射到本地分类器词表的条件，采用完整句匹配，保留否定、复合要求的原意。
export function hairQuery(query: string) {
  const color = /^([蓝红白黑粉绿紫金棕灰橙])色?(?:的)?(?:头发|发)(?:的)?(?:女孩子|女孩|少女)[！!？?。]?$/u.exec(query.trim())?.[1]
  if (!color) return
  return {
    tag: hairColors[color] + '_hair',
    text: color + '发少女',
    contrasts: [color === '红' ? '蓝发少女' : '红发少女', color === '金' ? '黑发少女' : '金发少女'],
    keywords: [[color + '发', color + '头发', color + '色头发', color + '色的头发'], ['女孩', '少女', '女孩子']]
  }
}

// 先复用本地分级特征，每次最多补识别八张。混合人物场景无法确定发色归属，仍需按完整描述检索。
export async function followupEvidence(tag: string, previousIds: number[], dirs: AiSearchFilter['dirs'], ids?: number[]) {
  const eligible = await searchImages({ ids, dirs, r18: 'exclude', tagGroups: [], keywordGroups: [] })
  const cached = await cachedFeatureMatches(eligible.ids, FEATURE_REVISION, tag, girls, boys)
  const known = new Map(cached.map((row) => [row.id, row.matches]))
  const previous = new Set(previousIds)
  const missing = eligible.ids.filter((id) => !known.has(id))
  const toInspect = missing.length <= 8 ? missing : missing.filter((id) => previous.has(id)).slice(0, 8)
  for (const id of toInspect) {
    const tags = await getVisualTagsForSearch(id)
    if (tags) {
      const match = tags.includes(tag) && girls.some((girl) => tags.includes(girl))
      known.set(id, match && boys.some((boy) => tags.includes(boy)) ? null : match)
    }
  }
  return {
    matches: eligible.ids.filter((id) => known.get(id) === true),
    unchecked: eligible.ids.filter((id) => known.get(id) == null)
  }
}
