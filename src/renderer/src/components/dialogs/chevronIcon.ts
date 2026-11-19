import { defineComponent, h, markRaw } from 'vue'
import type { FolderNodeVO } from '@shared/api'

// el-tree 懒加载节点里我们用到的部分
export interface TreeNode {
  level: number
  data: FolderNodeVO | FolderNodeVO[]
  expanded: boolean
  expand: () => void
  collapse: () => void
}

// 文件夹树的展开箭头：照原型的细线 “›”，展开时由 el-tree 转 90°
export const ChevronIcon = markRaw(
  defineComponent({
    name: 'ChevronIcon',
    render: () =>
      h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': 'true'
        },
        [h('path', { d: 'M9 6l6 6-6 6' })]
      )
  })
)
