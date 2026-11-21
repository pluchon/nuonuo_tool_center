# 应用原型

“诺诺的图床”的界面原型，在 claude.ai 的设计画布上和用户一起定稿。**界面以它为准**：颜色、间距、圆角、文案、交互、各种状态都照它做。文字规则写在 [`../design.md`](../design.md)，两者冲突时问用户。

画布在线地址（用户自己能打开）：https://claude.ai/code/artifact/a1b392b6-52be-49f6-8a36-af23b3b747ec ，这里存的是“图床_微调后AI”这一页：按现在的真实软件改过的本地功能，加上 AI 部分。画布上“图床_本地非AI”那一页是本地阶段的旧原型，已被这一页取代，仓库里不再保存。

## 文件

| 文件 | 内容 |
|---|---|
| `AiMain.dc.html` | 完整可交互原型。模板在 `<x-dc>` 里，全部交互逻辑在文件末尾 `class Component` 的 `renderVals()` 里 |
| `AiState-*.dc.html` | AI 相关的特殊和异常状态：新对话、诺诺在翻图库、没找到、网络异常、没连上云端、从对话里看大图、看图队列（有图 / 空）、AI 建议（逐条确认 / 都处理完） |
| `canvas.json` | 这一页的画布布局（各画板的位置、标题和便签） |
| `tools/render.cjs` | 本地渲染工具，见下 |

`AiState-*` 只是一层壳：用 `<dc-import name="AiMain" scene="…">` 引用 `AiMain.dc.html`，再用构造函数里的 `SC` 预设把状态设好，所以所有状态都和主原型同步。本地阶段的特殊状态（第一次打开、扫描中、源目录找不到、单张图异常、没有结果、操作失败、图库打不开）也还在 `SC` 里，渲染工具可以直接出图。

## 怎么看

`.dc.html` 要靠设计画布的运行时才能直接打开。本地用渲染工具把它展开成静态 HTML 再看：

```bash
node docs/prototype/tools/render.cjs
```

它会把全部预设（浅色 / 深色、三个主题背景、多选、大图、设置各页、标签管理、本地阶段的 7 种状态、AI 的 12 种状态）写到 `test-output/prototype/*.html`，用浏览器打开即可。也可以渲染任意状态：

```bash
node docs/prototype/tools/render.cjs my-case "{\"page\":\"assistant\",\"set\":{\"theme\":\"dark\"}}"
```

静态页没有交互（点击、悬停、动画都不会动）。要看交互细节，读 `AiMain.dc.html` 里的 `renderVals()`：

- 网格排版在 `gridGroups` 附近；月份分组、筛选、多选、快捷键（`onRootKey`）、提示条和撤销（`toast`）、设置项（`SV` 和 `groups`）、主题色派生色（`av`）、深色模式（`isDark`、`C`）都在里面；
- AI 部分：诺诺助手页在 `ai:`（对话、对话记录、目录选择、+ 菜单），底栏看图队列在 `aiBar:`，AI 建议在 `SUGG`、`suggLeft` 和 `sugg:`，其他 AI 辅助整理在 `assist:`。

## 原型里的东西哪些不是真的

- 所有图片都是纯色占位块（`tint`），名字、尺寸、EXIF 都是假数据。
- 扫描进度、检查更新、上传自定义背景、上传图片都是模拟。
- 诺诺找图是假的：问题里出现标签名或图片名就算命中；看图队列和 AI 建议是写死的示例数据。
- 导入源目录时真实软件弹的是 Windows 自己的选文件夹对话框，原型里仍用自己画的对话框代替演示。
- 主题背景（Halftone / Plotter / Paper）以 base64 内嵌在 `AiMain.dc.html` 里；正式实现已经移植成 `src/renderer/src/assets/scenes/*.svg`，不要从原型里抠 base64。
