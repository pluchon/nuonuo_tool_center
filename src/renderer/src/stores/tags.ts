import { defineStore } from 'pinia'
import type { TagCategoryVO, TagVO } from '@shared/api'
import { fetchTagCatalog } from '@/api/edit'
import { tagColor, type TagColor } from '@/theme/tagPalette'

// 新标签默认放进的分类
const DEFAULT_CATEGORY = '主题'
// 加标签时最多列几个候选
const SUGGEST_MAX = 5

// 加标签的一个候选：命中名字或别名
export interface TagSuggestion {
  tag: TagVO
  // 命中的是别名时显示“别名 X”
  alias: string
}

// 标签字典：分类和标签（加标签候选、筛选下拉、标签颜色都从这里取）
export const useTagsStore = defineStore('tags', {
  state: () => ({
    categories: [] as TagCategoryVO[],
    tags: [] as TagVO[],
    loaded: false
  }),
  getters: {
    categoryById: (s) => (id: number): TagCategoryVO | undefined => s.categories.find((c) => c.id === id),
    // 分类的颜色；分类找不到时用灰蓝
    colorOf(): (categoryId: number) => TagColor {
      return (categoryId: number) => tagColor(this.categoryById(categoryId)?.colorIndex ?? 9)
    },
    // 新标签默认分类：“主题”，没有就第一个
    defaultCategoryId: (s): number | undefined => (s.categories.find((c) => c.name === DEFAULT_CATEGORY) ?? s.categories[0])?.id,
    // 按名字或别名精确找（不区分大小写）
    findExact: (s) => (name: string): TagVO | undefined => {
      const lower = name.trim().toLowerCase()
      if (!lower) {
        return undefined
      }
      return s.tags.find((t) => t.name.toLowerCase() === lower) ?? s.tags.find((t) => t.aliases.some((a) => a.toLowerCase() === lower))
    }
  },
  actions: {
    async load(): Promise<void> {
      const catalog = await fetchTagCatalog()
      this.categories = catalog.categories
      this.tags = catalog.tags
      this.loaded = true
    },
    // 加标签候选：名字或别名包含关键字，前缀匹配优先，其次按图片数；已经在图上的不列；最多 5 个
    suggest(query: string, excludeIds: number[]): TagSuggestion[] {
      const q = query.trim().toLowerCase()
      if (!q) {
        return []
      }
      return this.tags
        .filter((t) => !excludeIds.includes(t.id))
        .map((t) => {
          const nameHit = t.name.toLowerCase().includes(q)
          const alias = nameHit ? '' : (t.aliases.find((a) => a.toLowerCase().includes(q)) ?? '')
          if (!nameHit && !alias) {
            return null
          }
          const starts = (alias || t.name).toLowerCase().startsWith(q) ? 1 : 0
          return { tag: t, alias, starts }
        })
        .filter((x): x is TagSuggestion & { starts: number } => x !== null)
        .sort((a, b) => b.starts - a.starts || b.tag.count - a.tag.count)
        .slice(0, SUGGEST_MAX)
        .map(({ tag, alias }) => ({ tag, alias }))
    }
  }
})
