import type { LibraryRootVO } from '@shared/api'
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
