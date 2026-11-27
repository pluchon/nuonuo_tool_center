// 动态角色导演注与去 AI 味节流器（零额外模型开销，仅注入第④层尾部，不破坏前缀缓存）

export type PersonaStance = 'focused' | 'flustered' | 'gentle' | 'pouting' | 'teasing'

export interface PersonaCueOptions {
  compacted?: boolean
  turnCount?: number
}

const HAS_KAOMOJI_RE = /(?:ฅ[^\s]{1,8}ฅ|[（(][^\u4e00-\u9fa5a-zA-Z0-9\n]{2,12}[）)]|[≧≦ωﻌ•ᴥ▽ﾉ]{2,}|\^•ﻌ•\^)/u
const FOCUSED_RE =
  /(?:写(?:一?[段个份])?(?:代码|函数|脚本|sql|正则)|markdown|json|yaml|表格|代码|报错|debug|调试|翻译成|按(?:下面|以下|指定)?格式|严肃(?:一点|语气)|别卖萌|不要卖萌|正经(?:回答|说)|分点总结|列出要点)/iu
const FLUSTERED_RE =
  /(?:最喜欢你|喜欢诺诺|好喜欢你|喜欢你|爱你|好可爱|超可爱|真可爱|好乖|贴贴|抱抱你|摸摸头|摸头|亲亲|夸夸|你真棒|你最好了|谢谢诺诺|诺诺最棒|可爱死)/iu
const GENTLE_RE =
  /(?:好累|累死了|好难过|难过|郁闷|烦死了|压力好?大|崩溃|失眠|心情不好|委屈|安慰|治愈|抱抱我|不想干了|好丧|emo)/iu
const POUTING_RE =
  /(?:杂鱼|臭杂鱼|雌小鬼|小鬼|小坏蛋|欠收拾|欠打|欠揍|笨蛋诺诺|小笨蛋|打你|捏脸|抓耳朵|揪耳朵|别嚣张|嚣张|嘴硬|傲娇|就这|得意什么|哼什么)/iu
const SEARCH_OR_TOOL_INTENT_RE =
  /(?:找|搜|翻|图|壁纸|头像|立绘|插画|猫娘|目录|标签|相似|换一批|还有|其他|记住|忘掉|偏好|代码|表格|翻译|看看|给我看|发几张|联网|查一下|搜一下|新闻|最新|是什么|是谁|百科|怎么用|为什么)/u
const IDENTITY_OR_LOOK_RE = /(?:是不是你|像不像你|长什么样|头发|发色|瞳色|眼睛|发夹|白毛|白发|粉毛|是谁|介绍.*自己|你的设定)/u
const OPENING_INTERJECTION_RE = /^(?:嘿嘿|哼|哈[？?！!、,，]|啊[？?这]|诶[—-]?|唔|喂喂|哎呀)/u

export function hasMiaoOrKaomoji(text: string): boolean {
  const trimmed = text.trim()
  return /喵/u.test(trimmed) || HAS_KAOMOJI_RE.test(trimmed)
}

/** 判定当前发言是否属于纯聊天/斗嘴，而非找图、联网查资料或办事请求 */
export function isPureBanter(userText: string): boolean {
  const text = userText.trim()
  if (!text) return false
  return !SEARCH_OR_TOOL_INTENT_RE.test(text)
}

/** 根据用户本轮话语判定诺诺当前的心境与反差切换方向 */
export function detectPersonaStance(userText: string): PersonaStance {
  const text = userText.trim()
  if (!text) return 'teasing'
  if (FOCUSED_RE.test(text)) return 'focused'
  if (FLUSTERED_RE.test(text)) return 'flustered'
  if (GENTLE_RE.test(text)) return 'gentle'
  if (POUTING_RE.test(text)) return 'pouting'
  return 'teasing'
}

const STANCE_DIRECTIONS: Record<PersonaStance, string> = {
  focused:
    '[角色状态：认真办事] 先干脆利落地把代码、格式或正事给准确答好，别乱塞调侃和颜文字影响阅读。',
  flustered:
    '[角色状态：被直球戳中] 突然被夸或示好有点接不住，像平时爱嘴硬的朋友那样愣一下、小声嗔怪“别突然搞这套”，再别扭但真诚地接住好意；禁说“陪你翻画册/把图理好”之类套话，说完就收。',
  gentle:
    '[角色状态：嘴硬心软] 对方累了或情绪低落，收起刺和说教，像熟人一样用短句实在安抚陪伴，别端着也别趁机拉回找图。',
  pouting:
    '[角色状态：互损斗嘴] 对方在故意逗你或反喊你外号，用熟人日常大白话直接怼回去（比如“啊？”“胆子肥了是吧”“别搞”），短促有活人感，绝不自称“本小姐”也绝不借机推销找图。',
  teasing:
    '[角色状态：日常小恶魔] 用轻松自然的大白话聊天，带点爱损人又靠谱的调皮劲儿，少用“……”和“～”；找图未拿到真实结果前绝不提前报喜。'
}

/** 生成第④层动态角色导演注，避免舞台腔、客服回拉、长程人设漂移与口癖复读 */
export function buildPersonaCue(
  userText: string,
  recentAssistantTexts: readonly string[] = [],
  opts?: PersonaCueOptions
): string {
  const stance = detectPersonaStance(userText)
  const notes: string[] = []
  if (opts?.compacted || (opts?.turnCount ?? 0) >= 6 || IDENTITY_OR_LOOK_RE.test(userText)) {
    notes.push(
      '[诺诺核心锚点] 你是白发紫瞳、右鬓别粉色五瓣花夹的毒舌可爱猫娘诺诺；无论聊了多少轮或刚压缩过上下文，都保持微信熟人短句大白话与高攻低防反差，绝不退回客服腔或舞台腔。'
    )
  }
  notes.push(STANCE_DIRECTIONS[stance])
  if (stance !== 'focused' && isPureBanter(userText)) {
    notes.push('[反回拉] 本轮只是随口聊天或斗嘴，说完当下这句就干脆结束，严禁在结尾把话题拉回找图、提问想看什么图或提及图库里的角色标签。')
  }
  const window = recentAssistantTexts.slice(-4)
  const lastTwo = window.slice(-2)
  const throttle: string[] = []

  if (stance !== 'focused' && lastTwo.some((t) => /杂鱼/u.test(t))) {
    throttle.push('前两轮刚叫过“杂鱼”，这轮改换“笨蛋”“你这家伙”或省去称呼，别连着复读')
  }
  if (lastTwo.length === 2 && lastTwo.every(hasMiaoOrKaomoji)) {
    throttle.push('最近两轮刚用过“喵”或颜文字，这轮改用纯文字自然收尾')
  }
  const lastReply = window.at(-1)?.trim() ?? ''
  const openingMatch = lastReply.match(OPENING_INTERJECTION_RE)
  if (openingMatch) {
    throttle.push(`上一轮刚用“${openingMatch[0]}”开头，这轮换个新鲜起手式`)
  }

  if (throttle.length > 0) {
    notes.push(`[表达避重] ${throttle.join('；')}。`)
  }
  return notes.join('\n')
}
