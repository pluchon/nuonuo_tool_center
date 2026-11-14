import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  vector
} from 'drizzle-orm/pg-core'

// 向量维度：图片语义向量与 AI 记忆向量共用
export const EMBEDDING_DIMENSIONS = 1024

// 内容分级：只有 GENERAL 允许上云
export const ratingEnum = pgEnum('rating', ['UNKNOWN', 'GENERAL', 'SENSITIVE', 'QUESTIONABLE', 'EXPLICIT'])
// 分级来源：模型判定或手动指定
export const ratingSourceEnum = pgEnum('rating_source', ['MODEL', 'MANUAL'])
// 文件位置状态
export const fileStatusEnum = pgEnum('file_status', ['NORMAL', 'MISSING', 'TRASHED'])
// 标签分类
export const tagCategoryEnum = pgEnum('tag_category', ['GENERAL', 'CHARACTER', 'SERIES', 'ARTIST', 'OTHER'])
// 标签来源：手动或云端视觉模型
export const tagSourceEnum = pgEnum('tag_source', ['MANUAL', 'VLM'])
// 标签状态：AI 给出的先是建议，确认后才生效
export const tagStatusEnum = pgEnum('tag_status', ['ACCEPTED', 'SUGGESTED', 'REJECTED'])
// 云端分析类型
export const aiResultKindEnum = pgEnum('ai_result_kind', ['IDENTIFY', 'DESCRIBE', 'NAME'])
// 文件整理批次来源
export const fileOpOriginEnum = pgEnum('file_op_origin', ['USER', 'AI'])
// 文件整理批次状态
export const fileOpBatchStatusEnum = pgEnum('file_op_batch_status', ['PLANNED', 'APPLYING', 'APPLIED', 'UNDONE', 'FAILED'])
// 文件操作类型
export const fileOpTypeEnum = pgEnum('file_op_type', ['MOVE', 'RENAME', 'TRASH', 'RESTORE', 'PURGE'])
// 单步文件操作状态
export const fileOpStatusEnum = pgEnum('file_op_status', ['PENDING', 'DONE', 'FAILED', 'REVERTED'])
// 助手消息角色
export const aiMessageRoleEnum = pgEnum('ai_message_role', ['USER', 'ASSISTANT', 'TOOL'])

// 业务表公共列：主键、创建/更新时间、逻辑删除标记（0 正常，1 删除）
function baseColumns() {
  return {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    createTime: timestamp('create_time', { withTimezone: true }).notNull().defaultNow(),
    updateTime: timestamp('update_time', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deleteState: smallint('delete_state').notNull().default(0)
  }
}

// 导入的图库目录
export const libraryRoot = pgTable(
  'library_root',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    trashDir: text('trash_dir').notNull()
  },
  (t) => [uniqueIndex('uk_library_root_path').on(t.path).where(sql`${t.deleteState} = 0`)]
)

// 按内容去重的图片，标签、描述、分级都挂在内容上
export const image = pgTable(
  'image',
  {
    ...baseColumns(),
    contentHash: text('content_hash').notNull(),
    format: text('format').notNull(),
    width: integer('width'),
    height: integer('height'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    displayName: text('display_name'),
    description: text('description'),
    rating: ratingEnum('rating').notNull().default('UNKNOWN'),
    ratingSource: ratingSourceEnum('rating_source'),
    ratingScores: jsonb('rating_scores'),
    thumbReady: smallint('thumb_ready').notNull().default(0)
  },
  (t) => [uniqueIndex('uk_image_content_hash').on(t.contentHash), index('idx_image_rating').on(t.rating)]
)

// 图片在磁盘上的位置，同一内容可有多个位置
export const imageFile = pgTable(
  'image_file',
  {
    ...baseColumns(),
    imageId: bigint('image_id', { mode: 'number' })
      .notNull()
      .references(() => image.id),
    rootId: bigint('root_id', { mode: 'number' })
      .notNull()
      .references(() => libraryRoot.id),
    relPath: text('rel_path').notNull(),
    mtime: timestamp('mtime', { withTimezone: true }).notNull(),
    status: fileStatusEnum('status').notNull().default('NORMAL')
  },
  (t) => [
    uniqueIndex('uk_image_file_location').on(t.rootId, t.relPath).where(sql`${t.deleteState} = 0`),
    index('idx_image_file_image').on(t.imageId)
  ]
)

// 标签字典，name 规范化（去空格、小写）后唯一
export const tag = pgTable(
  'tag',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    category: tagCategoryEnum('category').notNull().default('GENERAL')
  },
  (t) => [uniqueIndex('uk_tag_name').on(t.name).where(sql`${t.deleteState} = 0`)]
)

// 图片与标签关联
export const imageTag = pgTable(
  'image_tag',
  {
    ...baseColumns(),
    imageId: bigint('image_id', { mode: 'number' })
      .notNull()
      .references(() => image.id),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tag.id),
    source: tagSourceEnum('source').notNull(),
    status: tagStatusEnum('status').notNull(),
    score: real('score')
  },
  (t) => [uniqueIndex('uk_image_tag').on(t.imageId, t.tagId).where(sql`${t.deleteState} = 0`)]
)

// 每次云端分析的完整结果（出处、角色、描述、建议名等）
export const imageAiResult = pgTable(
  'image_ai_result',
  {
    ...baseColumns(),
    imageId: bigint('image_id', { mode: 'number' })
      .notNull()
      .references(() => image.id),
    kind: aiResultKindEnum('kind').notNull(),
    model: text('model').notNull(),
    result: jsonb('result').notNull(),
    usage: jsonb('usage')
  },
  (t) => [index('idx_image_ai_result_image').on(t.imageId)]
)

// 图片语义向量
export const imageEmbedding = pgTable(
  'image_embedding',
  {
    ...baseColumns(),
    imageId: bigint('image_id', { mode: 'number' })
      .notNull()
      .references(() => image.id),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull()
  },
  (t) => [uniqueIndex('uk_image_embedding').on(t.imageId, t.model).where(sql`${t.deleteState} = 0`)]
)

// 文件整理批次：先写计划，再执行，可整批撤销
export const fileOpBatch = pgTable('file_op_batch', {
  ...baseColumns(),
  origin: fileOpOriginEnum('origin').notNull(),
  summary: text('summary').notNull(),
  status: fileOpBatchStatusEnum('status').notNull().default('PLANNED')
})

// 批次内的单步文件操作
export const fileOp = pgTable(
  'file_op',
  {
    ...baseColumns(),
    batchId: bigint('batch_id', { mode: 'number' })
      .notNull()
      .references(() => fileOpBatch.id),
    seq: integer('seq').notNull(),
    opType: fileOpTypeEnum('op_type').notNull(),
    imageFileId: bigint('image_file_id', { mode: 'number' }).references(() => imageFile.id),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path'),
    contentHash: text('content_hash').notNull(),
    status: fileOpStatusEnum('status').notNull().default('PENDING'),
    error: text('error')
  },
  (t) => [index('idx_file_op_batch').on(t.batchId, t.seq)]
)

// 云端调用流水，用于额度控制
export const apiUsage = pgTable(
  'api_usage',
  {
    ...baseColumns(),
    api: text('api').notNull(),
    model: text('model'),
    units: integer('units').notNull().default(1),
    estCost: numeric('est_cost', { precision: 10, scale: 4 }),
    imageId: bigint('image_id', { mode: 'number' }).references(() => image.id)
  },
  (t) => [index('idx_api_usage_api_time').on(t.api, t.createTime)]
)

// 助手对话
export const aiConversation = pgTable('ai_conversation', {
  ...baseColumns(),
  title: text('title').notNull()
})

// 助手消息
export const aiMessage = pgTable(
  'ai_message',
  {
    ...baseColumns(),
    conversationId: bigint('conversation_id', { mode: 'number' })
      .notNull()
      .references(() => aiConversation.id),
    role: aiMessageRoleEnum('role').notNull(),
    content: jsonb('content').notNull()
  },
  (t) => [index('idx_ai_message_conversation').on(t.conversationId)]
)

// 助手长期记忆
export const aiMemory = pgTable('ai_memory', {
  ...baseColumns(),
  content: text('content').notNull(),
  kind: text('kind').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
  sourceMessageId: bigint('source_message_id', { mode: 'number' }).references(() => aiMessage.id)
})

// 应用设置（不存任何密钥）
export const appSetting = pgTable(
  'app_setting',
  {
    ...baseColumns(),
    key: text('key').notNull(),
    value: jsonb('value').notNull()
  },
  (t) => [uniqueIndex('uk_app_setting_key').on(t.key).where(sql`${t.deleteState} = 0`)]
)
