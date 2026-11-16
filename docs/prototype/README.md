# 应用原型

这是“诺诺的图床”本地版（非 AI 部分）的界面原型，在 claude.ai 的设计画布上和用户一起定稿。**界面以它为准**：颜色、间距、圆角、文案、交互、各种状态都照它做。文字规则写在 [`../design.md`](../design.md)，两者冲突时问用户。

画布在线地址（用户自己能打开）：https://claude.ai/code/artifact/a1b392b6-52be-49f6-8a36-af23b3b747ec

## 文件

| 文件 | 内容 |
|---|---|
| `Main.dc.html` | 完整可交互原型（标题“应用原型”）。模板在 `<x-dc>` 里，全部交互逻辑在文件末尾 `class Component` 的 `renderVals()` 里 |
| `State-First.dc.html` | 第一次打开：还没有任何图片 |
| `State-Scanning.dc.html` | 导入后正在扫描 |
| `State-Offline.dc.html` | 源目录找不到（移动硬盘没接） |
| `State-Broken.dc.html` | 单张图异常：生成中 / 无法预览 / 文件不见了 |
| `State-NoResult.dc.html` | 搜索没有结果 |
| `State-OpFail.dc.html` | 操作失败提示 |
| `State-DbError.dc.html` | 图库数据打不开 |
| `canvas.json` | 画布布局（各画板的位置和标题） |
| `tools/render.cjs` | 本地渲染工具，见下 |

`State-*` 只是一层壳：用 `<dc-import name="Main" scene="…">` 引用 `Main.dc.html`，再用构造函数里的 `SC` 预设把状态设好。所以所有状态都和主原型同步。

## 怎么看

`.dc.html` 要靠设计画布的运行时才能直接打开。本地用渲染工具把它展开成静态 HTML 再看：

```bash
node docs/prototype/tools/render.cjs
```

它会把 24 个预设（浅色 / 深色、三个主题背景、多选、大图、设置各页、标签管理、导入对话框、7 种特殊状态）写到 `test-output/prototype/*.html`，用浏览器打开即可。也可以渲染任意状态：

```bash
node docs/prototype/tools/render.cjs my-case "{\"page\":\"tags\",\"set\":{\"theme\":\"dark\",\"accent\":\"#C25B85\"}}"
```

静态页没有交互（点击、悬停、动画都不会动）。要看交互细节，读 `Main.dc.html` 里的 `renderVals()`：

- 网格排版（固定行高、比例夹在 0.5–2.5、行末压窄或撑宽取变形小的）在 `gridGroups` 附近；
- 月份分组、筛选规则、多选、快捷键（`onRootKey`）、提示条和撤销（`toast`）、设置项（`SV` 默认值和 `groups`）、主题色派生色（`av`）、深色模式（`isDark`、`C`）都能在里面找到。

## 原型里的东西哪些不是真的

- 所有图片都是纯色占位块（`tint`），名字、尺寸、EXIF 都是假数据。
- 扫描进度、检查更新、上传自定义背景都是定时器模拟。
- 诺诺插画位置是虚线占位，等新角色画好再换。
- 主题背景（Halftone / Plotter / Paper）是从 Claude Code 官方 theme-examples 插件（Apache-2.0）生成的 SVG，以 base64 内嵌在 `Main.dc.html` 里。正式实现时按开发指南从源码移植，不要从原型里抠 base64。
