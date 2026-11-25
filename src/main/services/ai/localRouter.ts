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
  // 每组对应一个画面特征，组内可以使用同义词。
  keywordGroups: string[][]
  // 未收录为标签的角色、作品等明确条件，语义检索也要核对。
  requiredWords?: string[]
  // 通用 WD 视觉特征过滤标签（英文 Danbooru 标签）
  visualInclude?: string[]
  visualExclude?: string[]
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
  const spec: SearchSpec = { tagGroups: [], keywordGroups: [] }
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

// 明确指定标签时按完整名称或别名匹配。空组表示该条件在已确认的词表里不存在。
export function routeTagRequest(question: string, tags: DictTag[], dirs: DictDir[]): RoutedQuery | null {
  const command = /^(?:(?:请问|麻烦|请|帮我|给我|我想|只|仅|查找|搜索|检索|筛选|找找|看看|想看|找|搜|看|一下)\s*)+/u
  let text = question.trim().replace(/[。！？!?]+$/u, '').replace(command, '').trim()
  const resultKind = /的(图片|图像|插画|壁纸|照片|横图|竖图|方图|图)(?:有哪些)?$/u
  const kind = text.match(resultKind)?.[1]
  text = text.replace(resultKind, '').trim()
  const marked = /^(.*?)按标签\s*(?:查找|搜索|检索|筛选|查|找|搜|看|[：:])\s*(.+)$/u.exec(text)
    ?? /^(.*?)标签(?:名)?(?:为|是|叫做|叫|[：:]|\s+|(?=[「“"']))\s*(.+)$/u.exec(text)
    ?? /^(.*?)(?:带有|含有|包含|打了|带|有)(.+?)标签$/u.exec(text)
  const named = marked?.[2] ?? (kind && text.endsWith('标签') ? text.slice(0, -2) : '')
  if (!named.trim() || /^(?:什么|哪些|怎么|如何)/u.test(named.trim()) || (!marked && /(?:没|没有|还没|未)(?:打)?标签$/u.test(text))) return null
  const prefix = (marked?.[1] ?? '').trim().replace(/(?:查找|搜索|检索|筛选|找|搜|看)$/u, '').trim()
  const filters = [prefix, kind && ['横图', '竖图', '方图'].includes(kind) ? kind : ''].filter(Boolean).join(' ')
  const route: RoutedQuery | null = filters ? routeLocally(filters, [], dirs) : { spec: { tagGroups: [], keywordGroups: [] }, dirs: [], conds: [] }
  if (!route) return null

  const terms = new Map<string, DictTag[]>()
  for (const tag of tags) {
    for (const name of [tag.name, ...tag.aliases]) {
      const key = name.toLowerCase()
      terms.set(key, [...(terms.get(key) ?? []), tag])
    }
  }
  // 引号内的连接词属于标签名；有连接词的完整标签也优先按原名查找。
  const parts = terms.has(named.trim().toLowerCase()) ? [named] : named.split(/(「[^」]+」|“[^”]+”|"[^"]+"|'[^']+'|或者?|以及|并且|和|[、，,])/u)
  let ids = new Set<number>()
  let names = new Set<string>()
  const finishGroup = (): void => {
    route.spec.tagGroups.push([...ids])
    route.conds.push(['标签', [...names].join('或')])
    ids = new Set()
    names = new Set()
  }
  for (const part of parts) {
    const word = part.trim()
    if (!word || /^(或|或者)$/u.test(word)) continue
    if (/^(以及|并且|和|[、，,])$/u.test(word)) {
      finishGroup()
      continue
    }
    const name = word.replace(/^[「“"']|[」”"']$/gu, '')
    const matches = terms.get(name.toLowerCase()) ?? []
    for (const tag of matches) ids.add(tag.id)
    names.add(matches[0]?.name ?? name)
  }
  finishGroup()
  return route
}
