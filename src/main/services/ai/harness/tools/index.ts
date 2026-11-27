import { toOpenAiTools, type RegisteredTool } from '../toolRegistry'
import { listCategoryPathsTool, proposeCategoryChangeTool } from './categoryTools'
import { excludeImageTool, explainMatchTool, getImageTool, listTagsTool, readReferencedImagesTool } from './imageTools'
import { recallMemoriesTool, rememberTool, replyWithFollowupTool } from './memoryTools'
import { searchImagesTool } from './searchImagesTool'
import { webSearchTool } from './webSearchTool'

// 固定的一整套工具，顺序固定，用不用都带上（工具定义算在缓存前缀里）
export const ASSISTANT_TOOL_REGISTRY: readonly RegisteredTool[] = [
  replyWithFollowupTool,
  readReferencedImagesTool,
  listCategoryPathsTool,
  proposeCategoryChangeTool,
  searchImagesTool,
  getImageTool,
  listTagsTool,
  rememberTool,
  recallMemoriesTool,
  explainMatchTool,
  excludeImageTool,
  webSearchTool
]

export const ASSISTANT_TOOL_MAP: ReadonlyMap<string, RegisteredTool> = new Map(
  ASSISTANT_TOOL_REGISTRY.map((tool) => [tool.name, tool])
)

export const ASSISTANT_TOOLS = toOpenAiTools(ASSISTANT_TOOL_REGISTRY)
export const [SEARCH_IMAGES_TOOL] = toOpenAiTools([searchImagesTool])
