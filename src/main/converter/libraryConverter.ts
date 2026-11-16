import type { LibraryRootVO, SidebarCountsVO, SourceRootVO } from '@shared/api'
import type { OverviewCounts } from '../repositories/libraryOverviewRepository'
import type { LibraryRootEntity } from '../repositories/libraryRootRepository'

// 图库目录实体转视图对象，只暴露界面需要的字段
export function toLibraryRootVO(entity: LibraryRootEntity): LibraryRootVO {
  return {
    id: entity.id,
    name: entity.name,
    path: entity.path,
    createTime: entity.createTime.toISOString()
  }
}

// 源目录实体加上图片数和是否有子文件夹，转成侧栏行
export function toSourceRootVO(entity: LibraryRootEntity, count: number, hasChildren: boolean): SourceRootVO {
  return { id: entity.id, name: entity.name, path: entity.path, count, hasChildren }
}

// 统计结果转侧栏计数：“还没打标签”= 全部 - 打过标签的
export function toSidebarCountsVO(counts: OverviewCounts): SidebarCountsVO {
  return { ...counts, untagged: counts.total - counts.tagged }
}
