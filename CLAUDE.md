# LocalToolManage 项目约定

个人本地图库管理工具（Electron + Vue 3 + PGlite）。完整设计见 `docs/design.md`，全局规范见用户级 CLAUDE.md，本文件只写本项目特有的约定。

## 运行与验证

- 开发：`npm run dev`；类型检查：`npm run typecheck`；构建：`npm run build`；改了 `src/main/db/schema.ts` 后执行 `npm run db:generate` 生成新迁移（只往前加，不改历史迁移）。
- 数据目录：`%APPDATA%\LocalToolManage`（`pgdata`、`thumbs`、`models`）。PGlite 只有一条连接：应用运行时不要用脚本去开同一个 pgdata。
- 关闭应用要走正常退出（关窗口），确保数据库落盘；不要用 `taskkill /F` 杀进程。

## 本机资源（核显笔记本，曾整机卡死）

- 本地推理只用 CPU，`WdTagger.load` 默认限 2 线程；不要开 DirectML，不要并行跑多个推理进程。
- 跑批量推理时降低进程优先级，并给脚本设超时；先用 1 张试跑，确认内存和耗时后再批量。

## 测试图片

- 图片目录 `D:\二次元`（约 3700 张，平铺）。不要打开或查看里面的图片内容。
- 只有“按文件大小降序的最后 100 张”是用户确认可以上云的；即便如此，上云前仍必须通过本地分级闸门（`isCloudAllowed`）。
- 其余图片只允许在本地跑分级，结果只报统计和文件名。

## 云端

- 凭证只从用户环境变量读取：`DASHSCOPE_API_KEY`、`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`。不打印、不落库、不写日志。
- OSS：bucket `zlhimage`（`oss-cn-guangzhou`），临时前缀 `local_image_temp/`。`local_image_temp/` 这个 0 字节对象是控制台的目录占位，清理时不能删。临时对象私有 ACL 上传，用完在 `finally` 里删除。
- 百炼：OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，以图搜图用 Responses API + `image_search` 工具。模型用最新可用的 Qwen（以 `/v1/models` 实际返回为准）。客户端必须 `maxRetries: 0`。
- 以图搜图的出处只采用工具返回的结果，不采用模型自己写的链接。

## Codex CLI（生图、写代码）

- 在本项目目录下调用：`codex exec -C C:\JavaCode\items\local_tool_manage -s workspace-write "<任务>"`。会话按工作目录归类，本项目的会话都在这个目录名下。
- 同一主题继续对话用 `codex exec resume --last "<追加指令>"`（默认只在当前目录的会话里找）；开始无关的新任务就新开会话。
- 交给 Codex 的任务要写清：要改的文件、验收标准、不许动的东西。它的产出由我审查并跑类型检查和构建后才算数。
- 生成的图片放在 `src/renderer/src/assets/` 下合适的位置；临时产物放 `test-output/`。
