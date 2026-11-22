# LocalToolManage 项目约定

个人本地图库管理工具（Electron + Vue 3 + PGlite）。完整设计见 `docs/design.md`，全局规范见用户级 CLAUDE.md，本文件只写本项目特有的约定。

## 运行与验证

- 开发：`npm run dev`；类型检查：`npm run typecheck`；构建：`npm run build`；单元测试：`npm test`；端到端测试：先 `npm run build` 再 `npm run test:e2e`（截图和差异图在 `test-output/phase1/`）。改了 `src/main/db/schema.ts` 后执行 `npm run db:generate` 生成新迁移（只往前加，不改历史迁移；要手写数据转换时用 `--custom`，再把快照换成完整结构，`npm run db:generate` 报 “No schema changes” 才算对上）。
- 数据目录由环境变量决定：`LTM_DATA_DIR`（数据库、缩略图、模型、日志、锁文件）和 `LTM_CATEGORY_HOME`（类目录）。
  - `npm run dev` 默认用 `D:\ltm-dev\data` 和 `D:\ltm-dev\library`；端到端测试用 `D:\ltm-dev\e2e\<场景>`。
  - 不设 `LTM_DATA_DIR` 时（桌面快捷方式）固定为真实目录 `%APPDATA%\LocalToolManage`，不随 productName 变。开发和测试不要碰真实目录。
- 图库数据是否被占用看应用自己的锁文件 `ltm.lock`（记真实 PID 和进程名），不看 PGlite 的 `postmaster.pid`（永远是假 PID -42，崩溃会残留）。PGlite 只有一条连接：应用运行时不要用脚本去开同一个 pgdata。
- 日志在数据目录的 `logs\main.log`（5 MB 滚动，留 3 份）；开发模式记 info，快捷方式运行只记 warn 以上，`LTM_LOG_LEVEL` 可覆盖。
- 关闭应用要走正常退出（关窗口），确保数据库落盘、释放锁；不要用 `taskkill /F` 杀进程（不带 `/F` 的 `taskkill /PID` 是正常关窗口，可以用）。
- 桌面快捷方式 `LocalToolManage.lnk` 指向 `node_modules\electron\dist\electron.exe <项目目录>`，跑的是 `out/` 构建产物：改完代码要 `npm run build` 才生效。单实例锁按数据目录区分：开发模式（`D:\ltm-dev\data`）和快捷方式（真实目录）可以同时开。

## 本机资源（核显笔记本，曾整机卡死）

- 本地推理只用 CPU，`WdTagger.load` 默认限 2 线程；不要开 DirectML，不要并行跑多个推理进程。
- `services/cloud`、`services/rating` 是 Phase 0 验证过的代码，现在还没有地方调用，是 AI 阶段要接上的，不是死代码，不要删。
- 跑批量推理时降低进程优先级，并给脚本设超时；先用 1 张试跑，确认内存和耗时后再批量。

## 测试图片

- 图片目录 `D:\二次元`（约 3700 张，平铺）。不要打开或查看里面的图片内容。
- 只有“按文件大小降序的最后 100 张”是用户确认可以上云的；即便如此，上云前仍必须通过本地分级闸门（`isCloudAllowed`）。
- 其余图片只允许在本地跑分级，结果只报统计和文件名。

## 云端

- 凭证只从用户环境变量读取：`DASHSCOPE_API_KEY`、`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`。不打印、不落库、不写日志。
- OSS：bucket `zlhimage`（`oss-cn-guangzhou`），临时前缀 `local_image_temp/`。`local_image_temp/` 这个 0 字节对象是控制台的目录占位，清理时不能删。临时对象私有 ACL 上传，用完在 `finally` 里删除。
- 百炼：OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，以图搜图用 Responses API + `image_search` 工具。以图搜图用 `qwen3.8-flash`（用户指定，max 太慢）；其他场景用最新可用的 Qwen（以 `/v1/models` 实际返回为准）。客户端必须 `maxRetries: 0`。
- 以图搜图的出处只采用工具返回的结果，不采用模型自己写的链接。

## AI（诺诺）的成本与缓存

方案见 `docs/design.md` 第 6 节，写 AI 代码时每次都要守的规则：

- 本地能做完的不调大模型：找图先走本地路由，外部 AI 的结果在本地解析和对齐，偏好先用本地规则从事件统计里提炼。
- 所有调用共用同一个前缀：固定规则和全部工具定义 → 核心档案和标签词表 → 对话历史（只追加）→ 每次都变的内容（时间、检索到的记忆、这句话或图片）放最后。前缀里不放时间戳，序列化顺序固定，工具集固定不增减；对话锁定开始时的档案版本。
- 预计 5 分钟内还会再调用的（对话、看图队列）打显式缓存标记，只调一次的不打。不为续期缓存发空请求。能等的（做梦、补向量、一次排进 50 张以上的看图）走批量推理，平时零散的看图实时调用；一个批次里带图和纯文本不能混。调用百炼一律关思考（`enable_thinking: false` 放请求顶层，Node SDK 没有 `extra_body`）。
- 每次调用把输入、命中缓存、输出 token 记进 `api_usage`；对话和队列的命中率低于 95% 要查原因。
- R-18 图不上云、不进记忆和云端检索；AI 只给建议，改数据和动文件都要用户确认（本地模型判 R-18 除外）。

## Codex CLI（生图、写代码）

- 在本项目目录下调用：`codex exec -C C:\JavaCode\items\local_tool_manage -s workspace-write "<任务>"`。会话按工作目录归类，本项目的会话都在这个目录名下。
- 同一主题继续对话用 `codex exec resume --last "<追加指令>"`（默认只在当前目录的会话里找）；开始无关的新任务就新开会话。
- 交给 Codex 的任务要写清：要改的文件、验收标准、不许动的东西。它的产出由我审查并跑类型检查和构建后才算数。
- 生成的图片放在 `src/renderer/src/assets/` 下合适的位置；临时产物放 `test-output/`。
- 生图一律照 `docs/codex-imagegen.md`：`-m gpt-6.2-sol -c model_reasoning_effort="high"`，一个系列一个持久会话（首轮立底线，之后 `resume <会话 id>` 只写几行简报），中文提示词用 UTF-8 从标准输入喂；出图后放大到 100% 检查噪点和条纹，不满意在原会话里精准返工。
