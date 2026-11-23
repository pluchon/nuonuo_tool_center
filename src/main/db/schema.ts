import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
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

// 只保存可由请求重建的检索计划和文本向量；图片和结果编号不进入缓存。
export const aiSearchCache = pgTable('ai_search_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, (t) => [index('ix_ai_search_cache_expiry').on(t.expiresAt)])

// 内容分级：只有 GENERAL 允许上云
export const ratingEnum = pgEnum('rating', ['UNKNOWN', 'GENERAL', 'SENSITIVE', 'QUESTIONABLE', 'EXPLICIT'])
// 分级来源：模型判定或手动指定
export const ratingSourceEnum = pgEnum('rating_source', ['MODEL', 'MANUAL'])
// 文件位置状态：DELETED 表示已删进系统回收站
export const fileStatusEnum = pgEnum('file_status', ['NORMAL', 'MISSING', 'DELETED'])
// 目录类型：源目录（导入的原始目录）或类目录（应用管理的图库文件夹，只有一条）
export const rootKindEnum = pgEnum('root_kind', ['SOURCE', 'CATEGORY'])
// 标签来源：手动或云端视觉模型
export const tagSourceEnum = pgEnum('tag_source', ['MANUAL', 'VLM'])
// 标签状态：AI 给出的先是建议，确认后才生效
export const tagStatusEnum = pgEnum('tag_status', ['ACCEPTED', 'SUGGESTED', 'REJECTED'])
// 云端分析类型
export const aiResultKindEnum = pgEnum('ai_result_kind', ['IDENTIFY', 'DESCRIBE', 'NAME', 'ORGANIZE'])
// 文件整理批次来源
export const fileOpOriginEnum = pgEnum('file_op_origin', ['USER', 'AI'])
// 文件整理批次状态
export const fileOpBatchStatusEnum = pgEnum('file_op_batch_status', ['PLANNED', 'APPLYING', 'APPLIED', 'UNDONE', 'FAILED'])
// 文件操作类型
export const fileOpTypeEnum = pgEnum('file_op_type', ['MOVE', 'COPY', 'RENAME', 'DELETE'])
// 单步文件操作状态
export const fileOpStatusEnum = pgEnum('file_op_status', ['PENDING', 'DONE', 'FAILED', 'REVERTED'])
// 助手消息角色
export const aiMessageRoleEnum = pgEnum('ai_message_role', ['USER', 'ASSISTANT', 'TOOL'])
// 诺诺后台任务类型：看图、做梦、补向量
export const aiJobKindEnum = pgEnum('ai_job_kind', ['LOOK', 'DREAM', 'EMBED'])
// 后台任务状态：排队、进行中（含已提交的批量推理）、完成、失败、取消
export const aiJobStatusEnum = pgEnum('ai_job_status', ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'])
// AI 建议的来源：诺诺看图，或用户贴回的外部 AI 结果
export const aiResultOriginEnum = pgEnum('ai_result_origin', ['NONO', 'EXTERNAL'])
// 对诺诺回复的反馈：赞或踩
export const aiVoteEnum = pgEnum('ai_vote', ['UP', 'DOWN'])

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

// 图库目录：导入的源目录，以及类目录所在的图库文件夹
export const libraryRoot = pgTable(
  'library_root',
  {
    ...baseColumns(),
    kind: rootKindEnum('kind').notNull().default('SOURCE'),
    name: text('name').notNull(),
    path: text('path').notNull(),
    // 最近一次完整扫描完成的时间；中途停止或目录找不到时不更新
    lastScanAt: timestamp('last_scan_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('uk_library_root_path').on(sql`lower(${t.path})`).where(sql`${t.deleteState} = 0`),
    uniqueIndex('uk_library_root_category').on(t.kind).where(sql`${t.deleteState} = 0 and ${t.kind} = 'CATEGORY'`)
  ]
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
    // 出处：采用了 AI 建议里的出处才写（只来自文件名线索或联网搜索返回的链接）
    source: text('source'),
    rating: ratingEnum('rating').notNull().default('UNKNOWN'),
    ratingSource: ratingSourceEnum('rating_source'),
    ratingScores: jsonb('rating_scores'),
    // 本地模型识别出的画面特征，仅用于检索校验，不计入用户标签。
    visualFeatures: jsonb('visual_features').$type<{ revision: string; tags: string[] }>(),
    // R-18 开关：用户手动标记，打开后网格里遮挡
    isR18: boolean('is_r18').notNull().default(false),
    // 拍摄时间与拍摄信息（机身、镜头、焦距、光圈、快门、ISO），没有 EXIF 时为空
    takenAt: timestamp('taken_at', { withTimezone: true }),
    exif: jsonb('exif'),
    thumbReady: smallint('thumb_ready').notNull().default(0)
  },
  (t) => [uniqueIndex('uk_image_content_hash').on(t.contentHash), index('idx_image_rating').on(t.rating)]
)

// 提案在用户确认前只保存在数据库中；按图片内容编号记录分析进度。
export const categoryProposal = pgTable('category_proposal', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  status: text('status').$type<'pending' | 'applied' | 'cancelled'>().notNull().default('pending'),
  home: text('home').notNull(),
  payload: jsonb('payload').notNull()
}, (t) => [check('category_proposal_status_check', sql`${t.status} IN ('pending', 'applied', 'cancelled')`)])

export const categoryAnalyzedImage = pgTable('category_analyzed_image', {
  imageId: bigint('image_id', { mode: 'number' }).primaryKey().references(() => image.id),
  proposalId: integer('proposal_id').notNull().references(() => categoryProposal.id)
})

// 同一份图片内容可对应多个磁盘位置。
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

// 标签分类：用户维护，colorIndex 是 12 色调色板的序号
export const tagCategory = pgTable(
  'tag_category',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    colorIndex: smallint('color_index').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  (t) => [uniqueIndex('uk_tag_category_name').on(sql`lower(${t.name})`).where(sql`${t.deleteState} = 0`)]
)

// 标签字典：保存时去掉首尾空格，按不区分大小写唯一
export const tag = pgTable(
  'tag',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    categoryId: bigint('category_id', { mode: 'number' })
      .notNull()
      .references(() => tagCategory.id)
  },
  (t) => [
    uniqueIndex('uk_tag_name').on(sql`lower(${t.name})`).where(sql`${t.deleteState} = 0`),
    index('idx_tag_category').on(t.categoryId)
  ]
)

// 标签别名：加标签时按名字和别名一起匹配，按不区分大小写唯一
export const tagAlias = pgTable(
  'tag_alias',
  {
    ...baseColumns(),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tag.id),
    name: text('name').notNull()
  },
  (t) => [
    uniqueIndex('uk_tag_alias_name').on(sql`lower(${t.name})`).where(sql`${t.deleteState} = 0`),
    index('idx_tag_alias_tag').on(t.tagId)
  ]
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
    origin: aiResultOriginEnum('origin').notNull().default('NONO'),
    model: text('model').notNull(),
    result: jsonb('result').notNull(),
    // 各字段的采用状态，如 {"name":"ACCEPTED","tags":"PENDING"}；全部处理完这张图就离开“AI 建议”
    fieldStatus: jsonb('field_status'),
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

// 云端调用流水：按调用类型记 token 和缓存命中，用于算命中率和对账
export const apiUsage = pgTable(
  'api_usage',
  {
    ...baseColumns(),
    // 调用类型，如 chat、look、dream、identify
    api: text('api').notNull(),
    model: text('model'),
    units: integer('units').notNull().default(1),
    estCost: numeric('est_cost', { precision: 10, scale: 4 }),
    imageId: bigint('image_id', { mode: 'number' }).references(() => image.id),
    // 输入 token（含命中缓存的部分）、其中命中缓存的、写入显式缓存的、图片的，以及输出 token
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    imageTokens: integer('image_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    // 联网搜索次数（按次另计费）
    searchCount: integer('search_count').notNull().default(0),
    // 是否走批量推理（半价）
    batch: boolean('batch').notNull().default(false),
    latencyMs: integer('latency_ms'),
    // 失败时的简短原因；成功为空
    error: text('error')
  },
  (t) => [index('idx_api_usage_api_time').on(t.api, t.createTime)]
)

// 助手对话
export const aiConversation = pgTable('ai_conversation', {
  ...baseColumns(),
  title: text('title').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  // 对话开始时锁定的核心档案版本，保证这段对话的缓存前缀不变；没有档案时为空
  profileVersion: integer('profile_version')
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
    content: jsonb('content').notNull(),
    // 用户对这条回复的赞或踩，只作弱参考
    vote: aiVoteEnum('vote')
  },
  (t) => [index('idx_ai_message_conversation').on(t.conversationId)]
)

// 助手事实记忆：一条条偏好和事实，旧的只标失效、不删
export const aiMemory = pgTable(
  'ai_memory',
  {
    ...baseColumns(),
    content: text('content').notNull(),
    kind: text('kind').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    sourceMessageId: bigint('source_message_id', { mode: 'number' }).references(() => aiMessage.id),
    sourceEventId: bigint('source_event_id', { mode: 'number' }).references(() => aiEvent.id),
    // 可信度 0 到 1：明说的偏好高，规则提炼的中，踩会往下调
    confidence: real('confidence').notNull().default(0.5),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    // 失效时间：被取代或判定不再成立时写入，为空表示仍然有效
    validTo: timestamp('valid_to', { withTimezone: true })
  },
  (t) => [index('idx_ai_memory_valid').on(t.validTo)]
)

// 核心档案：500 字以内的偏好摘要和标签词表快照，每次更新新增一个版本
export const aiProfile = pgTable(
  'ai_profile',
  {
    ...baseColumns(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    tagVocab: jsonb('tag_vocab').notNull()
  },
  (t) => [uniqueIndex('uk_ai_profile_version').on(t.version).where(sql`${t.deleteState} = 0`)]
)

// 事件流：软件里的操作，只追加，做梦时整理的原料；涉及 R-18 图的事件标记出来，不进整理材料
export const aiEvent = pgTable(
  'ai_event',
  {
    ...baseColumns(),
    kind: text('kind').notNull(),
    imageId: bigint('image_id', { mode: 'number' }).references(() => image.id),
    payload: jsonb('payload').notNull(),
    isR18: boolean('is_r18').notNull().default(false)
  },
  (t) => [index('idx_ai_event_kind_time').on(t.kind, t.createTime)]
)

// 诺诺的后台任务：看图队列、做梦的每一小步、补向量；remoteId 是已提交的批量推理任务号
export const aiJob = pgTable(
  'ai_job',
  {
    ...baseColumns(),
    kind: aiJobKindEnum('kind').notNull(),
    status: aiJobStatusEnum('status').notNull().default('QUEUED'),
    imageId: bigint('image_id', { mode: 'number' }).references(() => image.id),
    // 数字越大越先做；手动“现在就看”的排在最前
    priority: smallint('priority').notNull().default(0),
    payload: jsonb('payload'),
    remoteId: text('remote_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true })
  },
  (t) => [index('idx_ai_job_queue').on(t.kind, t.status, t.priority)]
)

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
