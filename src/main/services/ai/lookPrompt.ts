// 诺诺看图的固定说明（第①层）和每张图附带的文字（第④层）
import { TAGS_PER_IMAGE } from '@shared/api'
import type { ExistingLookContext } from '../../repositories/aiResultRepository'
import type { LocalClues } from './localClues'

// 看图的固定说明：任务、要求、输出格式（不带时间和任何每张图都变的内容）
export const LOOK_RULES = [
  '你是“诺诺”，在帮用户整理本地图库。看这张图，补全它的名字、角色、作品、标签、出处和描述。',
  '',
  '## 要求',
  '- 只根据图片内容、附带的线索和联网搜索结果判断；不要编造不确定的信息。',
  '- 识别角色与作品时，先仔细核对画面中的关键外观特征：发色、发型、瞳色与瞳孔特征、发饰/头饰、角/耳/尾/翅膀、服装纹样与手持道具；如果附带线索中有“本地模型候选角色”“目录线索”或 Pixiv 作品号，请结合上述视觉特征通过联网搜索（web_search）交叉核实，确认对应的官方简体中文角色名与作品名；仅当画面特征和联网搜索都无法确认时，才将 character / work 留空（""）。',
  '- 仅当图明显是动漫/游戏人物且经过当前识别和搜网后仍无法确定具体角色或作品时，在 JSON 中额外附带 "needs_thinking": true；清晰可确认的人物、风景、物品、表情包和照片不要加或保持 false。',
  '- 名字、角色、作品、每个标签都不超过 15 个字。名字要像人起的：表情包直接用图里的那句话，风景照写地点加画面（如“岚山竹林”），人物图写角色加动作或场景。',
  '- 角色和作品用中文圈子里最常用的简体中文叫法；如果下面“图库里的标签”里有同一个意思的词，就用那个词。',
  `- 只写有辨识度的主题、风格和画面元素，最多 ${TAGS_PER_IMAGE} 个标签，不重复角色名和作品名。`,
  '- 出处只写联网搜索结果里确实对应这张图（或这张图原作）的链接；搜不到就写空字符串。不要自己编链接，不要写搜索页的链接。线索里已经给了出处链接时直接用它。',
  '- 描述用一句话；图里有文字（比如表情包）时把文字原样写进描述。',
  '- 用中文。只输出下面格式的一个 json 代码块，代码块前后不要写别的文字。',
  '',
  '## 输出格式',
  '```json',
  '{"name": "", "character": "", "work": "", "tags": [], "source": "", "description": ""}',
  '```'
].join('\n')

// 每张图附带的文字：本地线索（文件名、元信息）与可选的已有整理信息/深度核查提示
export function lookTail(
  clues: LocalClues,
  options?: { existingContext?: ExistingLookContext | null; thinkingRetry?: boolean }
): string {
  const lines = ['[软件附注] 这张图的本地线索：', ...clues.notes.map((n) => `- ${n}`)]
  if (clues.source) {
    lines.push(`- 出处链接：${clues.source}`)
  }
  if (clues.photo) {
    lines.push('- 这是相机拍的照片，不用查出处。')
  }
  const existing = options?.existingContext
  if (existing) {
    const contextLines: string[] = []
    if (existing.displayName) contextLines.push(`- 名字：${existing.displayName}`)
    if (existing.characters.length > 0) contextLines.push(`- 角色：${existing.characters.join('、')}`)
    if (existing.works.length > 0) contextLines.push(`- 作品：${existing.works.join('、')}`)
    if (existing.tags.length > 0) contextLines.push(`- 标签：${existing.tags.join('、')}`)
    if (existing.source) contextLines.push(`- 出处：${existing.source}`)
    if (existing.categoryDir) contextLines.push(`- 当前类目录：${existing.categoryDir}`)
    if (contextLines.length > 0) {
      lines.push('[已有整理信息（仅供参考，其中可能有误，请结合画面重新独立核实并纠正）]', ...contextLines)
    }
  }
  if (options?.thinkingRetry) {
    lines.push('[二次深度核查] 初步识别线索不足，请结合画面细节、本地候选线索与联网搜索深入推理确认，直接输出最终 JSON。')
  }
  return lines.join('\n')
}
