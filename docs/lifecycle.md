# dsh-fork-graph 生命周期

两份代码：Host（`index.js`，会话日志 → 血缘 → payload）与 Client（`client.js`，payload → 面板）。
下面按"启动 → 刷新 → 重建 → 绘制 → 动作 → 卸载"走一遍。

## 0. 全景

```
                      ┌──────────────────────────── Host 进程 ────────────────────────────┐
 DSH 启动              │                                                                   │
   │                  │  apply(ctx)                                                       │
   ├─────────────────▶│   ├─ ensureRoutes()   注册 /lineage.json、/lineage-rebuild.json  │
   │                  │   └─ setTimeout(1200ms) ──┐                                        │
   │                  │                            ▼                                        │
   │                  │                     build()  ←── 30s 定时器（5min 内有读者时）      │
   │                  │                            │                                        │
   │                  │   latest = JSON  ◀─────────┘   （同时写 lib/assets/lineage.json）  │
   │                  │        ▲                                                          │
   │                  │        └── GET /lineage-rebuild.json  （动作后 / 打开面板）         │
   │                  └───────────┬───────────────────────────────────────────────────────┘
   │                              │ HTTP（同源）
   │                  ┌───────────┴──────────────── Client 进程（页面） ───────────────────┐
   └─────────────────▶│  apply(ctx)                                                       │
                      │   ├─ 注入样式表 .dfg__*                                           │
                      │   └─ 注册 conversation.session.header.actions 组件                  │
                      │                                                                   │
                      │  ForkGraph 组件                                                     │
                      │   ├─ 挂载：GET /lineage.json（15s 内存缓存）＋ 30s 轮询               │
                      │   ├─ 打开面板：GET /lineage-rebuild.json                            │
                      │   └─ 动作成功：GET /lineage-rebuild.json，每 700ms 重试至多 8 次      │
                      └───────────────────────────────────────────────────────────────────┘
```

## 1. 启动

| 时机 | 动作 | 成本 |
|---|---|---|
| Host 装配 | 注册两条精确路由（`webServer` 就绪后） | 0.1 ms |
| 启动 +1.2 s | 首次 `build()`，在后台分片跑 | 冷 6–9 s / 命中磁盘缓存 ~0.4 s |
| Client 装配 | 注入样式、注册 header action | 忽略不计 |
| 组件首次渲染 | `GET /lineage.json`（此时 `latest` 可能为空，等待首图） | 一次 HTTP |

首图未就绪时客户端拿不到数据，控件**不渲染**（避免闪出一个空按钮）。

## 2. 什么会触发刷新

| # | 触发 | 谁发起 | 通道 | 时机 |
|---|---|---|---|---|
| 1 | 启动后首图 | Host | `requestBuild(false,'kickoff')` | +1.2 s |
| 2 | 保活 | Host | `requestBuild(false,'timer')` | 每 30 s；且 5 min 内有人读过才跑；同时只允许一个构建 |
| 3 | 打开面板 | Client | `GET /lineage-rebuild.json` | 每次展开 |
| 4 | 动作成功（重命名/分叉/归档） | Client | 同上 | 立刻，然后每 700 ms 重试（≤8 次）直到 payload 变化 |
| 5 | **原生入口变更**（侧边栏分支、右键归档/重命名） | Client | 同上 | 每 1.5 s 比对"会话 id + 标题 + blank + 归档集合"签名，变化即重建 |
| 6 | **payload 里没有当前会话**（刚 fork 完跳到新会话） | Client | 同上 | 立即强制重建一次 |
| 7 | 组件挂载（切会话） | Client | `GET /lineage.json` | 每次头部渲染；15 s 内复用内存结果 |
| 8 | 轮询 | Client | `GET /lineage.json` | 每 30 s（拿 Host 定时重建出的新计数） |

两条路由的区别只有一点：`/lineage.json` **直接返回内存快照**（`latest` 为空时才会等待一次构建）；`/lineage-rebuild.json` **先重建再返回**。

动作用"重试直到变化"，是因为写盘时机晚于 RPC 返回：子会话日志、标题事件、归档集合都要过一小会儿才可见。

## 3. 一次 Host 重建（`build()`）内部

```
1. archivedIds()      读 storages/workspace.json → 归档集合
2. sessionFiles()     枚举 sessions/<ws>/<session>/*.jsonl.zstd（当前 67 个 / 85 MB）
3. 逐文件（每 4 个 setImmediate 让出事件循环）
     stat ─┬─ 命中内存缓存（同一进程再次刷新）→ 直接用
           ├─ 命中磁盘缓存（mtime+size 一致）→ revive，不解析
           └─ 未命中 → 解 zstd 多帧 → 逐行 JSON.parse → 丢弃 subagent/空会话
                         → 取最后一个 session/title → 每个事件算指纹
4. resolveLineage()   按 createdAt 排序；两两求公共前缀；回看 24 条找 session/end-seed
                      → forkDepth（分叉点在自己日志里的位置）与 source（复制自哪个会话）
5. measureSessions()  内容事件前缀和 countBefore、countTotal、headTime、prefixEndTime
6. groupFamilies()    并查集：共享任意前缀即同族
7. 逐家族（≥2 个成员才布局）
     findForkPoints()  按"第几条内容事件"归并分叉点；取 owner（被复制方）；算 atSeq
     buildRows()       头部正好停在分叉点 → 合并成 fork+head；时间倒序编号；末尾追加 root
     assignLanes()     从 root 向下走，每个分叉点交出一条轨道给一个分支，其余开新轨道
     assignDeltas()    同一轨道上，本节点 = 累计 − 上一个节点累计
     serializeRow()    输出客户端直接绘制的行（kind/lane/prefix/total/delta/time/…）
8. JSON.stringify → 内存 latest ＋ 调试副本 lib/assets/lineage.json
9. 磁盘缓存：有文件被重新解析且距上次写入 >5 min 才写（约 8 MB）
```

family 的 `size` 只在第 7 步排序与建索引时使用，不进入 payload。

## 4. 一次 Client 刷新内部

```
loadLineage(rebuild)
  ├─ 非强制且 15 s 内取过 → 直接返回内存数据
  └─ fetch(URL + ?t=时间戳) → data
       └─ setData(data)
            ├─ pickLayout()：index[sessionId] → 家族 → 选 all / active 变体
            │    └─ 家族不足 2 个会话 → 返回 undefined → 整个控件不渲染
            ├─ desiredWidth：轨道数 × 20 + 最长标题宽度（CJK 12px / 拉丁 7px）+ 268，夹在 420–760
            └─ 渲染：SVG 轨道（rails → 曲线 → 标记）+ 行（状态/标题/事件/时间/三个按钮）
```

- 状态列来自 `useSessionStatus`：`running` → 转圈，`completionUnread` → 蓝点。
- 客户端**不提供**这个 hook 时，状态列显示红色 ✕，悬停提示"无法读取会话状态：当前客户端未提供会话状态接口（useSessionStatus）…"。
- 拉取失败 → 面板底部"无法读取分叉数据"。
- 鼠标悬停任意一行：高亮带横跨整行（含左侧轨道）；轨道区域按纵坐标换算行号，悬停高亮、点击等于点击该行。

每次构建把分阶段耗时写入 `lib/assets/build-stats.json`（`first` 是本进程首图，`recent` 是最近 10 次，含 `trigger`：`kickoff`/`timer`/`route`/`first-request`）。

## 5. 动作

```
点击图标（stopPropagation，不触发行跳转）
  └─ run(id, work)：置 busy、清 error
       └─ work 走原生 API
            fork   : sessions.fork({ sessionId, atSeq, increaseTitle, onCreated → open })
            rename : sessions.using(id, {source:'workspaceOperation'}).binding.session.rename(title)
            archive: uiWorkspace.archiveSession(id) / unarchiveSession(id)
       ├─ 成功 → refreshAfterAction()（重建直到 payload 变化）
       ├─ workspace/session-active → 面板底部确认条 → archive(id, { stopActivity: true })
       └─ 其他错误 → 面板底部红字
```

`atSeq` 是"共享前缀最后一条内容事件"的序号，因此 fork 点行分叉出来的新会话正好落在该点，而不是源会话当前的头部。

## 6. 卸载

`apply()` 返回 disposer：清掉首图定时器与保活定时器、注销两条路由；样式表随 `ctx.effect` 卸载。
Client 的组件随槽位注销卸载，无额外清理。
