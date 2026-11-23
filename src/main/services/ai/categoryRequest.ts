import { categoryRel } from '../fileOps/categoryPaths'

type DirectoryRequest = { kind: 'analyze'; scope?: string } | { kind: 'create'; path: string } | { kind: 'move'; from: string; parent: string }

function readPath(text: string): string {
  const path = text.trim()
    .replace(/[「」『』“”"\x60]/gu, '')
    .replace(/(?:下面的?|里面的?|中的|下的?|内的?|的)\s*(?:子类目录|子目录|子文件夹)/gu, '\\')
    .replace(/^(?:类目录|目录|文件夹)\s*/u, '')
    .replace(/(?:里面|下面|之下)$/u, '')
    .split(/[/\\]/u).map((part) => part.trim()).join('\\')
  return categoryRel(path)
}

export function parseCategoryRequest(raw: string): DirectoryRequest | null {
  const text = raw.trim().replace(/[。！!]+$/u, '').replace(/^(?:请)?(?:帮我|帮我们)?/u, '').trim()
  if (/[？?]/u.test(text)) return null
  if (!/(?:类目录|子目录|文件夹|目录结构|分类目录)/u.test(text)) return null
  const move = text.match(/^(?:把|将)\s*(.+?)\s*(?:迁移|移动|挪|搬)(?:到|至|入|进)\s*(.+)$/u)
  if (move) return { kind: 'move', from: readPath(move[1]), parent: readPath(move[2]) }
  if (/标签|分析|规划|建议|自动分类/u.test(text) && /分析|建|规划|推荐|建议|整理|分类/u.test(text)) {
    const scope = text.match(/^(?:只按|仅按|根据|分析|只看|按)\s*(?:类目录|子目录|文件夹)?\s*([^，。；、]+?)\s*(?:下的?|中的?|里的?)\s*(?:图片|插画)?的?标签(?:来|并)?(?:规划|创建|整理)(?:类目录|分类目录|目录结构)$/u)
    if (scope && !/[和与及、]/u.test(scope[1])) return { kind: 'analyze', scope: readPath(scope[1]) }
    // 只在整句均为普通规划用语时使用默认范围。未识别的目录名、限定条件或多个范围交给模型澄清。
    const generic = /^(?:请)?(?:帮我|帮我们)?(?:根据|基于|按照|按|分析)?(?:已有|现有|新增|全部|所有|已复核|已标注)?的?(?:图片|插画)?的?标签(?:来|并)?(?:规划|创建|生成|整理|推荐)(?:一下)?(?:类目录|分类目录|目录结构)$/u
    return generic.test(text.replaceAll(' ', '')) ? { kind: 'analyze' } : null
  }
  const sub = text.match(/^在\s*(.+?)\s*(?:下面|里面|下|中|内)\s*(?:新建|创建|建立|添加)\s*(?:一个|名为|叫做|叫)?\s*(?:子类目录|子目录|子文件夹)\s*(.+)$/u)
  if (sub) return { kind: 'create', path: categoryRel(readPath(sub[1]) + '\\' + readPath(sub[2])) }
  const create = text.match(/^(?:新建|创建|建立|添加)\s*(?:一个)?\s*(?:类目录|目录|文件夹)\s*(?:名为|叫做|叫|为)?\s*(.+)$/u)
    ?? text.match(/^(?:新建|创建|建立|添加)\s*(?:一个)?\s*(?:名为|叫做|叫)?\s*(.+?)(?:的)?(?:类目录|文件夹)$/u)
  if (create) return { kind: 'create', path: readPath(create[1]) }
  return null
}
