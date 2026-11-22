// 本地找图路由：问题里的词全都能对上标签、别名、目录名和几个固定说法时，直接在本地查库，不调模型（设计 6.7）

// 词典里的一个标签
export interface DictTag {
  id: number
  name: string
  aliases: string[]
  // 所属分类名（角色、作品、主题……），用于“怎么找的”那行字
  category: string
}

// 词典里的一个目录
export interface DictDir {
  rootId: number
  kind: 'SOURCE' | 'CATEGORY'
  name: string
}

// 一次检索的条件
export interface SearchSpec {
  // 每组是一个条件的候选标签（组内任一），组与组之间都要满足
  tagGroups: number[][]
  // 关键词：任一个对上就算
  keywords: string[]
  orientation?: 'portrait' | 'landscape' | 'square'
  recent?: boolean
  untagged?: boolean
}

// 一条给人看的条件：如 ["角色", "甘雨"]、["方向", "竖图"]
export type CondLabel = [string, string]

// 本地路由的结果：检索条件、问题里点到的目录、给人看的条件
export interface RoutedQuery {
  spec: SearchSpec
  dirs: DictDir[]
  conds: CondLabel[]
}

// 固定说法（长的在前）
const PHRASES: Array<{ words: string[]; apply: (spec: SearchSpec) => CondLabel }> = [
  { words: ['还没打标签', '没打标签', '没有标签', '未打标签', '没标签'], apply: (s) => ((s.untagged = true), ['状态', '还没打标签']) },
  { words: ['最近新导入', '最近导入', '新导入'], apply: (s) => ((s.recent = true), ['时间', '最近导入']) },
  { words: ['竖图', '竖屏', '竖版', '竖的'], apply: (s) => ((s.orientation = 'portrait'), ['方向', '竖图']) },
  { words: ['横图', '横屏', '横版', '横的'], apply: (s) => ((s.orientation = 'landscape'), ['方向', '横图']) },
  { words: ['方图', '正方形'], apply: (s) => ((s.orientation = 'square'), ['方向', '方图']) }
]

// 不带意思的词：问句的壳子（长的在前）
const FILLERS = [
  '帮我找找',
  '帮我找',
  '帮我搜',
  '给我找',
  '找一下',
  '搜一下',
  '看一下',
  '都有哪些',
  '有哪些',
  '有没有',
  '所有的',
  '全部的',
  '图片',
  '照片',
  '一些',
  '几张',
  '一下',
  '看看',
  '里面'
]
// 单个字的壳子、标点和空白
const FILLER_CHARS = new Set('找搜的图张几些吗呢吧啊呀要想请和跟与还有里中在我给帮看下都个所全部了把也就是，,。.!！?？、;；:：~～ \t\n"“”\'‘’「」()（）0123456789')

// 在 text 里把 term 的每次出现标记掉（只标还没被别的词占用的位置）；返回第一次命中的位置，没命中返回 -1
function consume(text: string, used: boolean[], term: string): number {
  if (!term) {
    return -1
  }
  let first = -1
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at < 0) {
      return first
    }
    const free = used.slice(at, at + term.length).every((u) => !u)
    if (free) {
      for (let i = at; i < at + term.length; i++) {
        used[i] = true
      }
      if (first < 0) {
        first = at
      }
    }
    from = at + 1
  }
}

// 试着在本地完整理解这句话；有一个词对不上就返回 null，交给模型
export function routeLocally(question: string, tags: DictTag[], dirs: DictDir[]): RoutedQuery | null {
  const text = question.trim().toLowerCase()
  if (!text) {
    return null
  }
  const used = new Array<boolean>(text.length).fill(false)
  const spec: SearchSpec = { tagGroups: [], keywords: [] }
  // 命中的条件和它在问题里的位置：最后按位置排，标签组和“怎么找的”都跟着问题的顺序
  const hits: Array<{ at: number; cond: CondLabel; tagId?: number }> = []
  const pickedDirs: DictDir[] = []

  // 词典：标签名、别名、目录名，长的先匹配（“原神角色”不会被“原神”抢走）
  const terms: Array<{ term: string; tag?: DictTag; dir?: DictDir }> = []
  for (const t of tags) {
    for (const name of [t.name, ...t.aliases]) {
      terms.push({ term: name.toLowerCase(), tag: t })
    }
  }
  for (const d of dirs) {
    terms.push({ term: d.name.toLowerCase(), dir: d })
  }
  terms.sort((a, b) => b.term.length - a.term.length)

  // 固定说法先占位，避免“竖的”里的字被当成壳子以外的东西
  for (const p of PHRASES) {
    const at = Math.min(...p.words.map((w) => consume(text, used, w)).map((i) => (i < 0 ? Infinity : i)))
    if (at !== Infinity) {
      hits.push({ at, cond: p.apply(spec) })
    }
  }
  for (const t of terms) {
    const at = consume(text, used, t.term)
    if (at < 0) {
      continue
    }
    if (t.tag && !hits.some((h) => h.tagId === t.tag?.id)) {
      hits.push({ at, cond: [t.tag.category || '标签', t.tag.name], tagId: t.tag.id })
    } else if (t.dir && !pickedDirs.some((d) => d.rootId === t.dir?.rootId && d.name === t.dir?.name)) {
      pickedDirs.push(t.dir)
    }
  }
  for (const f of FILLERS) {
    consume(text, used, f)
  }
  // 按 UTF-16 码元逐个看，和 indexOf 的位置一致
  const rest = text.split('').filter((ch, i) => !used[i] && !FILLER_CHARS.has(ch))
  if (rest.length > 0 || (hits.length === 0 && pickedDirs.length === 0)) {
    return null
  }
  hits.sort((a, b) => a.at - b.at)
  spec.tagGroups = hits.filter((h) => h.tagId !== undefined).map((h) => [h.tagId as number])
  return { spec, dirs: pickedDirs, conds: [...pickedDirs.map((d): CondLabel => ['范围', d.name]), ...hits.map((h) => h.cond)] }
}
