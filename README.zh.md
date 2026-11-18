# dsh-fork-graph

DeepSeek Harness 会话的 git 风格分叉图，内联在会话标题栏。

每个会话的标题栏都有一个按钮，打开后显示该会话所在整棵树的轨道图：彩色轨道、空心圆（会话头）、
实心小圆（分叉点）、底部虚拟 `root` 行。点击任意会话行——或轨道上该行高度处——即打开对应会话。
每行右侧还有重命名 / 分叉 / 归档三个动作。

[English](README.md) · [生命周期与刷新机制](docs/lifecycle.md)

## 功能

- **只画当前会话所在的树。** 单会话的树也会打开，画 `root` + 自己。
- **分叉点是"对话位置"。** 两个会话即使分叉时夹杂了不同的记账事件（`turn/*`、`job/*`、
  `delivery-*`），只要内容事件数相同就算同一个分叉点。
- **从分叉点分叉。** 分叉点行上的分叉动作会以精确的事件边界调用原生 fork，新会话从该点开始，
  而不是源会话当前的头部。
- **重命名 / 归档**用与侧边栏相同的原生调用。归档正在运行的会话会先弹出确认，确认后停止并归档。
- **已归档会话**可用面板右上角开关隐藏，可见时整行淡化到 55%。当前会话本身已归档时始终显示完整树，
  开关锁定为"含已归档"。
- **状态列**取自客户端自己的会话状态：运行中显示转圈、尚未查看的完成显示蓝点；客户端不提供状态
  接口时显示红色 ✕ 并说明原因。
- **中英双语**，随 DSH 语言设置切换（通过 `ctx.locale` 注册字典）。
- **浅色/深色**全部使用 `--dsw-alias-*` 设计令牌，两种主题都正常。

## 实现

浏览器拿不到事件内容，而血缘本质上是事件日志的性质（fork 会复制源日志的一段精确前缀），
所以插件分为两半：

| 半 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 读会话日志、算血缘与布局，通过 `/plugins/dsh-fork-graph/lineage.json` 发布 JSON（另有一条强制重建路由） |
| Client | `client.js` | 只负责绘制发布出来的布局、跳转与动作，不做任何分析 |

Host 按文件 `mtime + size` 在 `$DSH_HOME/storages/fork-graph-cache.json` 缓存解析结果，
重启后只解析变化过的日志。刷新时机与一次构建的完整步骤见 [docs/lifecycle.md](docs/lifecycle.md)。

## 安装

需要 DeepSeek Harness 0.2.x（桌面端或 Web 端）。

1. 把本目录作为 bundle 安装：**插件 → 添加插件 → 本地目录**，或用 `plugin_manager install_bundle`
   指定本仓库的绝对路径。
2. 重启一次 DSH，让 Host 半边注册路由。

它是本地 bundle（由插件管理器链接进 profile），不是发布到 npm 的库。

## 验证

- 每个会话都有标题栏按钮；单会话的树画出 `root` + 自己；
- 分叉点行是实心小圆，分叉动作生成的新会话从该点开始；
- 从面板或原生菜单归档，图应在一两秒内更新；
- 切换 DSH 语言，面板文字随之切换。

## 开发

工具用 DSH 自带的 Electron 可执行文件运行：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'

& $env:DSH_NODE_EXECUTABLE --check index.js
& $env:DSH_NODE_EXECUTABLE --check client.js

& $env:DSH_NODE_EXECUTABLE tools\check.mjs          # 路由 + 渲染冒烟测试 + 中英字典对齐
& $env:DSH_NODE_EXECUTABLE tools\check-archive.mjs  # 归档变更在热重建中生效
& $env:DSH_NODE_EXECUTABLE tools\timing.mjs         # 启动 / 首图 / 热重建耗时
& $env:DSH_NODE_EXECUTABLE tools\bench.mjs 2000     # 2000 份合成日志的扩展性测试
```

payload 级别的回归：对同一份输入前后各导出一次再比对。

```powershell
& $env:DSH_NODE_EXECUTABLE tools\snapshot.mjs before.json --home <fixture>
# 修改代码
& $env:DSH_NODE_EXECUTABLE tools\snapshot.mjs after.json --home <fixture>
& $env:DSH_NODE_EXECUTABLE tools\diff-payload.mjs before.json after.json
```

`DSH_FORK_GRAPH_DEBUG=1` 让 Host 打印分阶段耗时；`lib/assets/build-stats.json` 始终记录
"本进程首图"和最近 10 次构建（含触发来源与耗时）。

## 已知限制

- 血缘依赖会话日志的存档结构（`$DSH_HOME/sessions/*/*/session*.jsonl.zstd`）与归档集合
  （`$DSH_HOME/storages/workspace.json`），DSH 改版可能需要跟进。
- 冷启动（首次安装或日志大量变化）会全量解析一次，后台几秒完成，永远不会占用启动路径。
- 分叉点行与 `root` 行不可点击——它们没有独立会话。
- 轨道配色固定，保证跨主题时同一分支颜色不变。

## 许可

[MIT](LICENSE)
