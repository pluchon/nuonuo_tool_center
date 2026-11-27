import type { AiTimelineBlock } from '@shared/api'

// 工具时间线动作的 24×24 几何线描图标（统一使用 currentColor）
export const ACTION_ICON = {
  command: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7.5 10l2.5 2-2.5 2M12.5 14h4',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM8 8h.01',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  memory: 'M6 4h12a1.5 1.5 0 0 1 1.5 1.5V21l-7.5-4.5L4.5 21V5.5A1.5 1.5 0 0 1 6 4z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.5h.01',
  eyeOff:
    'M3 3l18 18M10.6 10.6a2.75 2.75 0 0 0 3.8 3.8M9.9 5.3A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.8 16.8 0 0 1-3.1 4.1M6.5 6.9A16.5 16.5 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 3.3-.6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'
} as const

export function actionIconPath(tool: string): string {
  switch (tool) {
    case 'search_images':
      return ACTION_ICON.search
    case 'web_search':
      return ACTION_ICON.globe
    case 'get_image':
    case 'read_referenced_images':
    case 'search_similar_image':
      return ACTION_ICON.eye
    case 'list_tags':
      return ACTION_ICON.tag
    case 'list_category_paths':
      return ACTION_ICON.folder
    case 'remember':
    case 'recall_memories':
      return ACTION_ICON.memory
    case 'explain_match':
      return ACTION_ICON.info
    case 'exclude_image':
      return ACTION_ICON.eyeOff
    case 'propose_category_change':
    default:
      return ACTION_ICON.command
  }
}

// 拆分动作摘要与右侧结果尾标（例如 "检索图库：白露 · 1 张" -> label + meta）
export function splitActionSummary(summary: string): { label: string; meta: string } {
  const idx = summary.lastIndexOf(' · ')
  if (idx < 0) return { label: summary, meta: '' }
  return { label: summary.slice(0, idx), meta: summary.slice(idx + 3) }
}

// 过滤掉历史消息里误写入的静默内部工具步骤
export function visibleTimelineBlocks(blocks?: AiTimelineBlock[]): AiTimelineBlock[] {
  if (!blocks?.length) return []
  return blocks.filter((b) => !(b.type === 'action' && b.tool === 'reply_with_followup'))
}
