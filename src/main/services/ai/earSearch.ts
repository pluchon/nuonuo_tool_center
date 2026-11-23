import { searchImages } from '../../repositories/aiSearchRepository'
import { getVisualTagsForSearch } from '../rating/ratingService'

// 每种耳形分别对应 WD 的具体标签。「兽耳」不能确定是哪一种。
const earTypes = [
  { tag: 'cat_ears', words: ['猫耳', '猫娘', '猫咪耳', '貓耳', '貓娘'] },
  { tag: 'fox_ears', words: ['狐耳', '狐娘', '狐狸耳'] },
  { tag: 'rabbit_ears', words: ['兔耳', '兔娘', '兔子耳'] },
  { tag: 'wolf_ears', words: ['狼耳', '狼娘'] },
  { tag: 'dog_ears', words: ['犬耳', '犬娘', '狗耳'] }
]
type EarType = (typeof earTypes)[number]

// 只识别独立的正向条件，避免把「猫耳耳机」等配饰或否定用法解释成角色耳形。
function typeOfTerm(term: string): EarType | undefined {
  const word = term.trim().replace(/[。！？!?]+$/u, '').replace(/(?:的)?(?:女孩子|女孩|少女|少年|角色)$/u, '')
  return earTypes.find((type) => type.words.includes(word))
}

export function earConditions(query: string, keywordGroups: string[][]): EarType[][] {
  const explicit = typeOfTerm(query)
  if (explicit) return [[explicit]]
  const groups: EarType[][] = []
  for (const words of keywordGroups) {
    const types = words.map(typeOfTerm)
    if (types.length && types.every((type) => type !== undefined)) groups.push([...new Set(types)])
  }
  return groups
}

export function earWords(group: EarType[]): string[] {
  return group.flatMap((type) => type.words)
}

// 只复核已进入候选的普通图。文字能够确定耳形时优先采用，剩余候选逐张在本机复核。
export async function verifyEarTypes(ids: number[], groups: EarType[][]): Promise<number[]> {
  if (!ids.length || !groups.length) return ids
  const confirmed = await Promise.all(groups.map(async (group) => {
    const hit = await searchImages({ ids, tagGroups: [], keywordGroups: [earWords(group)], r18: 'exclude' })
    return new Set(hit.ids)
  }))
  const matches: number[] = []
  for (const id of ids) {
    const missing = groups.filter((_, index) => !confirmed[index].has(id))
    if (missing.length) {
      const visualTags = await getVisualTagsForSearch(id)
      if (!visualTags || !missing.every((group) => group.some((type) => visualTags.includes(type.tag)))) continue
    }
    matches.push(id)
  }
  return matches
}
