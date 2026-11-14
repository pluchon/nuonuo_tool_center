# 本地图库管理工具：设计方案（定稿草案）

> 状态：方案已确认，骨架已搭好，Phase 0 验证结果见第 8 节。标注【已核实】的结论有文档或实测依据；标注【待验证】的放到 Phase 0 去测，测完再回填。

## 1. 目标与边界

只给自己用的 Windows 桌面软件。导入几个图片目录（二次元图、表情包），可以管理、打标签、搜索。AI 只在需要时帮忙：查出处和角色、写描述、起名、整理目录。

- 打标签以手动为主，AI 是兜底：先自己填，填不出来再点“让 AI 看看”。
- 云端只接阿里百炼，凭证从用户环境变量读取（`DASHSCOPE_API_KEY`、`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`），不进代码、不进库、不写日志。
- 原目录允许改动（移动、改名、删除），但所有改动必须可追溯、可撤销。删除一律先进回收站。
- 敏感图片永远不上云。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron + TypeScript，用 electron-vite 构建 | |
| 界面 | Vue 3 + Pinia + Element Plus | 遵守全局前端规范：组件拆成 `.vue/.ts/.scss`，页面只通过 `src/api/` 调用，状态只通过 action 修改 |
| 数据库 | PGlite（内嵌 PostgreSQL）+ pgvector | 不用安装数据库服务。SQL 只写标准 PG 语法，以后换成真 Postgres 只改连接配置 |
| ORM / 迁移 | Drizzle ORM（有 pglite 驱动），迁移只往前加 | 用类型安全的列引用，不写字符串列名【已核实：支持 vector 列】 |
| 本地推理 | onnxruntime-node，只跑 WD tagger 做**内容分级** | 只用 CPU，限 2 线程【已核实：约 1 秒一张】 |
| 图片处理 | sharp | 生成缩略图、上传前缩图、去掉 EXIF |
| 云端 | 百炼 Responses API + 阿里云 OSS | 见第 6 节 |

全项目只有一种语言，不需要 Python。

## 3. 进程与分层

```
渲染进程 (Vue)
  views → stores(actions) → src/api/*  ──IPC──┐
                                             │  preload：只暴露带类型的 window.api
主进程                                        ▼
  ipc/*（只做参数校验和调用）→ services/*（业务、事务、状态流转）→ repositories/*（Drizzle）→ PGlite
  ├─ workers/rating      WD 分级（utilityProcess，不卡主进程）
  ├─ workers/thumbnail   sharp 生成缩略图
  ├─ services/fileOps    唯一允许写文件系统的地方，操作串行排队执行
  ├─ services/cloud      OSS 临时上传 + 百炼调用 + 额度控制
  └─ services/assistant  AI 助手（函数调用）+ 记忆
自定义协议 ltm://thumb/{hash}、ltm://file/{fileId}
  图片走协议直接加载，不经过 IPC 传 base64；只允许访问已登记目录里的文件
```

安全设置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并配置 CSP。渲染进程不能读任意路径。

## 4. 数据模型（PostgreSQL）

所有业务表都有 `id BIGINT GENERATED ALWAYS AS IDENTITY`、`create_time`、`update_time`、`delete_state`，默认逻辑删除。状态一律用枚举，不用魔法数字。

| 表 | 作用 | 关键字段 / 约束 |
|---|---|---|
| `library_root` | 导入的目录 | `path`（规范化后加唯一索引）、`name`、`trash_dir` |
| `image` | **按内容去重的图片**，标签和描述挂在这里 | `content_hash`（sha256，唯一）、宽高、格式、`display_name`（AI 或手动起的名字，只存在库里）、`description`、`rating`、`rating_source`（MODEL/MANUAL）、`rating_scores jsonb` |
| `image_file` | 图片在磁盘上的位置，同一内容可以有多个位置 | `image_id`、`root_id`、`rel_path`；`(root_id, rel_path)` 在未删除记录内唯一；`status`（NORMAL/MISSING/TRASHED） |
| `tag` | 标签字典 | `name`（去空格、统一大小写后唯一）、`category` |
| `image_tag` | 图片和标签的关联 | `source`（MANUAL/VLM）、`status`（ACCEPTED/SUGGESTED/REJECTED）；AI 给的标签先是 SUGGESTED，你确认后才生效 |
| `image_ai_result` | 每次云端分析的完整结果 | `kind`（IDENTIFY/DESCRIBE/NAME）、`model`、`result jsonb`（含出处链接、角色、作品）、`usage jsonb` |
| `image_embedding` | 语义向量 | `image_id`、`model`、`embedding vector(1024)` |
| `file_op_batch` | 一次整理操作 | `origin`（USER/AI）、`summary`、`status`（PLANNED/APPLYING/APPLIED/UNDONE/FAILED） |
| `file_op` | 整理操作里的每一步 | `op_type`（MOVE/RENAME/TRASH/RESTORE/PURGE）、`from_path`、`to_path`、`content_hash`、`status`、`error` |
| `api_usage` | 云端调用流水，用来卡额度 | `api`、`units`、`est_cost`、`image_id` |
| `ai_conversation` / `ai_message` | 助手对话 | |
| `ai_memory` | 助手的长期记忆 | `content`、`kind`、`embedding vector(1024)`、`source_message_id` |
| `app_setting` | 配置 | key/value，存 OSS bucket、region、每日额度等，不存密钥 |

规模估算：几千张图，向量直接暴力计算相似度，先不建 HNSW 索引。

## 5. 核心流程

### 5.1 导入与扫描
1. 选择目录，登记为 `library_root`。
2. 递归扫描支持的格式（jpg/png/webp/gif/bmp/avif），跳过回收站目录。
3. 用流式读取计算 sha256，按哈希建 `image` 和 `image_file`，再排队生成缩略图（webp，存在应用数据目录，按哈希命名）。
4. 每次启动时全量对账，运行期间用 chokidar 监听变化。文件被外部删除标为 MISSING；被移动或改名时按哈希自动接回，标签不丢。

### 5.2 内容分级闸门（本地）
- 每张新图入库后，本地跑 WD tagger（swinv2-v3）得到四个分级：general / sensitive / questionable / explicit。
- **只有 general 的图允许上云。** 判定偏保守：general 的分数必须超过阈值，否则视为敏感。
- 可以手动改分级（`rating_source = MANUAL`）。手动改成 general 相当于你明确放行。
- 有一个专门的视图列出所有敏感图。你可以手动移走，也可以让助手生成一份移动计划，确认后执行。
- WD 打出的内容标签**默认不用**（按“先手动”的原则）。可以在设置里打开“显示 WD 建议标签”。

### 5.3 让 AI 看看（按需、云端）
1. 检查闸门：不是 general 就直接拒绝，并告诉你原因。
2. 缩图（长边 ≤ 1536，JPEG，去 EXIF），上传到 OSS 的 `local_image_temp/{yyyyMMdd}/{uuid}.jpg`，生成有效期 10 分钟的签名 URL。
3. 调百炼 Responses API（qwen3.6-plus + `image_search` 工具），一次拿回：角色、作品、出处链接、描述（表情包要把图里的文字逐字写进去）、建议名字、建议标签。
4. 在 `finally` 里删掉 OSS 上的临时对象。另外建议在 OSS 控制台给 `local_image_temp/` 配一条 1 天过期的生命周期规则兜底。
5. 结果整体存进 `image_ai_result`，标签和名字作为建议展示，你确认后才写进 `image_tag` 和 `display_name`。

额度控制：`image_search` 每天调用上限在设置里配，默认 50 次，约 2.4 元【已核实：北京地域 48 元/千次】。上限在调用前用 `api_usage` 检查，由我们自己的代码卡死，不依赖模型侧的 `max_tool_calls`【已核实的坑：百炼 Responses 不遵守 max_tool_calls】。

### 5.4 搜索
- 一个搜索框，同时查三路：标签名、`display_name` 和 `description` 的模糊匹配，以及语义向量（只覆盖已经生成过向量的图）。结果按排名融合（RRF）合并。
- 可以按目录、分级、标签过滤。
- 语义向量用 qwen3-vl-embedding：图片向量在“让 AI 看看”时顺带生成，或者对 general 图批量生成；查询文本每次搜索实时转成向量。

### 5.5 文件整理与删除保护
- `fileOps` 是唯一允许写文件系统的服务，所有操作串行排队。
- 每个批次按 PLANNED → APPLYING → APPLIED 推进。日志**先写库，再动文件**。启动时把卡在 APPLYING 的批次逐条和磁盘对账，补完或回滚。
- **删除 = 移进回收站**：每个导入目录下有一个隐藏的 `.ltm-trash\{batchId}\`，同盘移动是毫秒级的改路径。扫描会跳过这个目录。默认永不自动清理，彻底删除只能在回收站里手动操作，并且要二次确认。
- 跨盘移动：先复制，校验哈希，确认一致后再删源文件。
- 目标路径已存在时自动加后缀，绝不覆盖。
- 撤销：任意已执行的批次都可以整批反向执行。
- AI 只能生成 PLANNED 状态的批次，界面预览后由你点确认才执行。AI 永远不能直接执行。

### 5.6 AI 助手
- 模型 qwen3.6-plus，带函数调用。只发文字，不发图片；需要它看图时，走 5.3 的闸门流程。
- 工具：`search_images`、`get_image`、`list_tags`、`propose_file_ops`（只生成计划）、`remember`、`recall`。
- 记忆：对话存在 `ai_message`；值得长期保留的事实（比如“我管这个角色叫 X”）由助手调 `remember` 写进 `ai_memory`，向量用百炼文本向量模型【待验证：模型名和维度】。每轮对话开始时按相似度和时间取 top-k 条记忆注入上下文。
- 查询失败和“没有结果”要分开报告，降级时不能冒充语义判断。

## 6. 云端与凭证

| 用途 | 服务 | 状态 |
|---|---|---|
| 以图搜图（出处、角色） | 百炼 Responses API `image_search`，推荐 Qwen3.6/3.7-Plus | 【已核实】文档要求传公网 URL，每次只搜一张图 |
| 描述、起名、标签 | 同一次调用的模型输出（qwen3.8-max） | 【已核实】成功的几次 JSON 都能正常解析；出处只用工具返回的结果 |
| 语义向量 | qwen3-vl-embedding（1024 维） | 【待验证】传图方式、中文查询效果 |
| 临时传图 | 阿里云 OSS，前缀 `local_image_temp/` | 需要配置 bucket 和 region（不是机密，存进 `app_setting`） |
| Responses 端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1/responses` | 【已核实】不需要 WorkspaceId |

OSS 用 bucket `zlhimage`（`oss-cn-guangzhou`），沿用现有 AccessKey，不另建子账号（用户决定）。临时对象一律私有 ACL 上传，用完即删。

## 7. 目录结构

```
local_tool_manage/
  src/main/      index.ts  ipc/  services/  repositories/  db/(schema, migrations)  workers/  protocol/
  src/preload/   index.ts
  src/renderer/  api/  stores/  views/  components/
  docs/          design.md
  test-output/   临时脚本和截图（加入 .gitignore）
```

模型文件（WD onnx，约 450MB）首次运行时下载到应用数据目录，不进仓库。数据库目录在 `%APPDATA%\local-tool-manage\pgdata`。

## 8. 范围与阶段

**Phase 0：技术验证**（2026-11-14 实测结果）
- V1 ✅ PGlite 0.5.16 + pgvector 0.8.7 在 Electron 45 主进程里正常：首次启动约 3 秒建好 14 张表，正常关窗后数据完整，`vector` 余弦距离可用，Drizzle 能定义 vector 列。PGlite 0.5 没有 pg_trgm，模糊搜索先用 `ILIKE`（几千行足够）。
- V2 ✅ WD swinv2-v3，CPU 2 线程：约 1 秒一张，进程内存峰值约 0.8GB。未测 DirectML（核显曾整机卡死，暂不碰）。
  - 用户确认安全的 100 张：85 张 general 放行，15 张判为 sensitive 被拦（其中约一半 general 和 sensitive 分数接近，属于偏保守误拦，可以手动改分级放行）。
  - 随机 40 张：21 张 general、16 张 sensitive、3 张 questionable、0 张 explicit，被拦 19 张。准确率需要用户抽查被拦的文件名。
- V3 ✅ OSS 私有 ACL 上传、签名 URL、删除、删除后 HEAD 404 自检，全部正常；单次上传约 0.3 秒。
- V4 ⚠️ `qwen3.8-max` + `image_search` 可用，`dashscope.aliyuncs.com` 端点不需要 WorkspaceId。
  - 准确度：5 张里成功的 3 张都认对了（Gawr Gura、甘雨、芙兰朵露），甘雨表情包的图中文字“好椰”也正确转写。
  - 耗时：一次调用 67~172 秒，大头在服务端以图搜图本身（单次约 2 分钟）；4 个并发时有 2 个超过 5 分钟超时。
  - 不守约束：有一次搜了两遍（按两次计费），提示词约束不住。
  - 出处链接：工具只返回“标题 + 图片地址”，模型写出的网页链接不在搜索结果里，不可信。已改为出处只用工具结果，不让模型写链接。
  - 单次用量约 5~10k token，其中图片约 2~4k。
- V5 ⏸ 语义向量还没测，放到 P1 再做。
- 不测“敏感图会不会被百炼拒绝”：拿真的敏感图去试，账号有风险。我们只靠本地闸门挡住。

**由 V4 带来的设计约束**：“让 AI 看看”必须是后台任务队列。并发上限 2，单次超时 5 分钟，客户端不自动重试（openai SDK 默认会重试 2 次，已关掉）。界面上显示“分析中”，完成后通知；超时由用户手动重试。超时那次服务端是否已经计费还不清楚，要对一下百炼账单。

**P0**：导入、扫描、缩略图、网格浏览；手动标签和名字；分级闸门；文件操作服务（日志、回收站、撤销）；关键词搜索。
**P1**：让 AI 看看（出处、角色、描述、起名）；语义搜索；额度控制。
**P2**：AI 助手和长期记忆；助手生成整理计划。
**暂缓**：手机访问、本地 OCR（表情包文字先靠 AI 描述）、SauceNAO（查敏感图出处）、Gemini、工具箱框架、打包分发。
