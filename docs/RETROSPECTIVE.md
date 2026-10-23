# `@local/obsidian-bridge` 开发复盘报告

> **文档性质**：面向公开仓库的开发复盘（Retrospective）。所有数字均标注来源，可逐条复核。
> **撰写日期**：2026-10-21 ｜ **1.0.1 同步**：2026-10-22 ｜ **复盘对象**：`@local/obsidian-bridge`（DSH 的 Cordis 插件）
> **运行环境**：DSH Desktop 2.0.18 / Cordis 4.0.5 / profile `desktop` / Vault `D:/MyVault`
> **验收基线**：PRD-WB-OBS-001 §9 —— **通过 14/14**（来源：`test/acceptance.mjs` 输出，`README.md:76`）
>
> ⚠️ **1.0.1 同步说明**：本文复盘的是 1.0.0 期间的开发过程。1.0.1 移除了 `webServer` 依赖与
> HTTP 状态路由（`STATUS_URL` / `STATUS_ROUTE` / `mountStatusRoute()`），并新增了自动知识整理。
> 凡涉及这些已删功能之处，本文都在原处标注 **【1.0.1 已移除】**，并**保留原文**——
> 「当时的判断」与「后来的修正」的差异本身就是复盘价值。
> 1.0.1 的完整变更见 [CHANGELOG.md](CHANGELOG.md)；**1.0.1 新增的第 8 个坑见 §4.8**。

## 目录

- [1. 项目概述](#1-项目概述)（产品定位 / 实测数据表 / 数据口径说明）
- [2. 技术选型依据](#2-技术选型依据)（5 个选型，每个含「为什么」与「备选为何被否」）
- [3. 核心功能实现亮点](#3-核心功能实现亮点)（4 个事件钩子 / 写路径绕沙箱 / 索引 TTL / 注入不可重复 / 快照兜底）
- [4. 问题与根因分析：7 个真实坑（+ §4.8 的 1.0.1 补记）](#4-问题与根因分析7-个真实坑)
- [5. 关键挑战与解决路径：Client↔Host 通道的 4 层递进排查](#5-关键挑战与解决路径clienthost-通道的-4-层递进排查)
- [6. 经验教训](#6-经验教训)（假阳性测试 / 弱证据判定成功 / 测量口径）
- [7. 改进建议（可执行）](#7-改进建议可执行)
- [附录 A. 证据索引](#附录-a-证据索引) ｜ [附录 B. 复现命令](#附录-b-复现命令)

---

## 1. 项目概述

### 1.1 产品定位

把 DSH 的对话 / 工具 / 回合 / 会话事件**自动留痕**到 Obsidian Vault，并在每轮用户 prompt 前**自动检索知识库注入上下文**。它取代 WorkBuddy 中国版不可靠的 Hook 自动触发（PRD §10.3 Q1/Q2 未解决），改为在 Cordis 插件基座上实现（`README.md:3-4`）。

| 半边 | 入口 | 职责 |
|---|---|---|
| Host | `index.js` | 4 类事件钩子 + 索引缓存 + 自动知识整理（1.0.1 新增） |
| Host（RPC 清单） | `typert.host.js` | 声明 `obsidianBridge/status` 与 `/refresh` 两个端点 |
| Client | `client.js` | Web GUI Settings 里的「Obsidian 桥接」面板 |

另有 `lib/` 8 个模块、`cordis.patch.yml`（Loader 配置）、`locale/` 双语文案，以及 `test/`（20 个脚本）与 `scripts/`（3 个守卫脚本）。

> **【1.0.1 已移除】** 1.0.0 的 Host 职责里还有一项「状态路由（`GET /obsidian-bridge/status`）」，
> 已于 1.0.1 连同 `webServer` 依赖一并删除（[CHANGELOG.md](CHANGELOG.md) R-04）。面板取数只走 Typert Remote。

### 1.2 实测数据表

#### 1.2.1 代码规模

**1.0.0 时期**（本文复盘的对象）：18 个 JS/MJS 文件 / 2643 行。
来源：`[System.IO.File]::ReadAllLines()` 对 `obsidian-bridge/` 下全部 `*.js`/`*.mjs` 逐行统计（不含 `locale/*.json`、`icon.svg`）。

| 文件 | 行数 | 职责 | 文件 | 行数 | 职责 |
|---|---:|---|---|---:|---|
| `test/e2e-verify.mjs` | 376 | 端到端验证 | `lib/writer.js` | 109 | 子进程执行器 |
| `index.js` | 322 | Host 主入口 | `lib/config.js` | 84 | 配置与默认值 |
| `client.js` | 300 | Client 面板 | `lib/message.js` | 78 | 注入消息构造 |
| `test/acceptance.mjs` | 262 | PRD §9 验收 | `typert.host.js` | 77 | Host Typert 清单 |
| `test/wiring.mjs` | 230 | 接线测试 | `lib/bridge-service.js` | 65 | 挂载 RPC 服务 |
| `test/run.mjs` | 181 | 单元测试 | `lib/status-store.js` | 58 | 快照共享存储 |
| `test/status-refresh.mjs` | 145 | 快照刷新自测 | `lib/status.js` | 54 | 运行计数 |
| `lib/query.js` | 128 | 关键词检索 | `test/sim-resolver.mjs` | 38 | 探针 |
| `lib/vault-index.js` | 126 | Vault 递归扫描 | `test/probe-import.mjs` | 10 | 探针 |

> 表中按行数降序排列，左右两栏拼接（左栏 376→126，右栏 109→10）。**合计 18 文件 / 2643 行。**

**1.0.1 时期**（当前，命令 `node scripts/check-line-counts.mjs`）：**48 个文件 / 12082 行**（2026-10-22 19:45 快照）。

| 分组 | 文件数 | 行数 | 说明 |
|---|---:|---:|---|
| 插件本体 | 11 | 1751 | `index.js` 489、`client.js` 345、`typert.host.js` 77、`lib/`×8 合计 840 |
| 测试 | 10 | 3669 | `test/`（仅 `.js`/`.mjs`），新增 `contract.mjs`、`run-all.mjs`、`knowledge-quality.mjs` 等 |
| 构建与守卫脚本 | 3 | 905 | `scripts/`（1.0.1 新增） |
| **本体小计** | **24** | **6325** | 实际维护面 |
| 发布暂存副本 | 24 | 5757 | `release-staging/`（脱敏副本，**不重复计入**维护面） |

> ⚠️ **代码规模是动态值**：`test/` 与 `scripts/` 在 1.0.1 期间持续演进，本表是 **2026-10-22 19:45 快照**
> （此后已再次变动过）。**权威来源永远是 `node scripts/check-line-counts.mjs` 的即时输出。**
>
> **增长的主因不是功能膨胀**：1.0.1 的插件本体从 1089 行增到 1751 行（+662），
> 而**测试与脚本从 1067 行增到 4574 行**（+3507）——增量几乎全在**验证与守卫**上。
> 这是 §6.1「假阳性测试」教训的直接后果：**先把「怎么证明它对」建起来，再改功能。**

#### 1.2.2 运行数据（事件计数）

来源：`D:/MyVault\00_InteractionLogs\hook-debug.log`，统计形如 `[2026-10-21T..Z] [事件名] Hook triggered` 的行（**该日志持续写入，以下为测量时点快照**）。

| 事件 | 次数 | 对应钩子 | 实现位置 |
|---|---:|---|---|
| `post-tool` | 1033 | `tools/result` | `index.js:286-312` |
| `stop` | 78 | `agent/turn-stopping` | `index.js:313-318` |
| `govern` | 48 | 治理扫描（Vault 侧脚本） | `90_Agent/hooks/bridge.js` |
| `user-prompt` | 28 | `agent/pre-step` | `index.js:222-277` |
| `diagnose` | 27 | `agent/pre-step` 诊断探针 | `index.js:233-241` |
| `session-start` | 24 | `agent/created` | `index.js:213-219` |

日志共 2648 行 / 164958 B（测量时点），首条时间戳 `2026-10-19T09:42:14.025Z`。

> ⚠️ 若按「包含事件名的任意行」统计，`post-tool` 会得到 2070 —— **该口径是错的**：它把 payload 与结果行也算进去了。本报告采用 `Hook triggered` 口径，这才是「插件真的调度了一次写入」的准确计数。

> **1.0.1 实测（2026-10-22T11:20Z，同一口径）**：`post-tool` 1211、`stop` 168、`diagnose` 152、
> `user-prompt` 103、`session-start` 86、`govern` 78、`route-mount` 8（死埋点）、`knowledge` 4、
> `verify` 1、`status-hit` 1（死埋点）、`harness-probe` 1。日志共 4049 行 / 274088 B。
> **注意 `diagnose` 的增速（27 → 152）远超其他事件**：它是每次 `agent/pre-step` 都写的诊断探针，
> 属调试残留（见 §7 I-9）。

#### 1.2.3 Vault 产物

来源：`Get-ChildItem D:/MyVault -Recurse` + `obsidian_get_stats`（MCP 实时返回）。

| 产物 | 大小 | 产物 | 大小 |
|---|---:|---|---:|
| `00_InteractionLogs/2026-10-21_thinking.md` | 257874 B | `00_InteractionLogs/2026-10-21_conversation.md` | 49077 B |
| `00_InteractionLogs/2026-10-21_memory-op.md` | 17616 B | `00_InteractionLogs/2026-10-21_project-op.md` | 15200 B |
| `90_Agent/audit/2026-10-21-integrity.json` | 501683 B | | |

Vault 实时规模（`obsidian_get_stats`，1.0.0 测量时点）：**147 篇笔记 / 282525 字 / 115745 行 / 23 个唯一标签**（`lastUpdated: 2026-10-21T02:58:52.595Z`）。

> **⚠️ 1.0.1 复核：147 → 450 篇，但这个增长是「污染」而非「产出」。**
> 1.0.1 实测 `totalNotes = 450`、`totalWords = 355490`。增量里 **291 条**是旧 CLI
> `knowledge-engine.js organize` **无去重**生成的垃圾知识条目（标题乱码、277/291 条正文夹带
> 下一条目的 frontmatter），落在 `30_Resources/experience/`（290）与 `project/`（1）。
> 剔除后实际策展内容约 **159 篇**。
> **教训：Vault 规模不是「产品产出」的合格度量**——它把「用户写的」与「机器乱写的」混在一起。
> 要衡量产出，应数**今天新增且通过质量门的**条目数（见 [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)）。
> 清理方案见 [KNOWLEDGE-PIPELINE.md §8](KNOWLEDGE-PIPELINE.md)（[CHANGELOG.md](CHANGELOG.md) K-11）。

#### 1.2.4 验收

PRD §9 验收 **通过 14/14**。来源：`test/acceptance.mjs` 的 14 个 `check()` 调用（`:55,67,78,84,94,110,124,141,151,159,172,187,216,226`），覆盖 FR-1 无感桥接（4）、FR-2 结构化知识条目（3）、FR-3 知识库查询（2）、FR-4 记忆治理（1）、FR-5 交叉认证（1）、FR-6 MCP 桥接（1）、FR-7 记忆同步（1）、PLUGIN 接线（1）。

> **注意**：这 14/14 **不能**证明 Client 面板取得到数据。见 §4.7 与 §6.1。

**1.0.1 的验收面**（4 个入口，全部退出码 0）：

| 入口 | 结果 | 判据 |
|---|---|---|
| `node test/acceptance.mjs` | 14/14 PASS | 真实 Vault + 真实 MCP 子进程 |
| `node test/e2e-verify.mjs` | 16 PASS / 0 FAIL / 3 MANUAL（19 项） | 断言外部产物 |
| `node test/wiring.mjs` | 12/12 PASS | 含 §4.8 的导出表守卫 |
| `node test/run-all.mjs` | 分层总览 | L1 契约 / L2 单元接线 / L3 端到端 |

> **「14/14 PASS」的教训在 1.0.1 被制度化了**：新增的 `scripts/check-line-counts.mjs` 与
> `check-doc-links.mjs` 把「文档声明」也变成可自动校验的断言（§7 I-10 已落地）。

### 1.3 数据口径说明（重要）

开发期曾用 Windows PowerShell 5.1 的 `Get-Content | Measure-Object -Line` 统计代码行数，得到 `index.js 250`、`typert.host.js 63`、`client.js 252`、`lib/*` 46/69/49/98/37/41/99/85、`test/*` 233/333/166/209/126 一组更小的数字。

**这组数字不是文件的真实行数。** 该 PowerShell 的 `[Text.Encoding]::Default` 在 zh-CN 环境是 `gb2312`，会把 UTF-8 中文注释按双字节字符解码，吞掉部分 `0x0A` 行边界：

```
index.js  真实 322 行（LF 计数 322 / ReadAllLines 322）
          Get-Content（gb2312 默认）        → 279 行
          Get-Content | Measure-Object -Line → 250 行
```

16 个文件逐一复核，**无一行被正确统计**（`lib/message.js` 真实 78 行 → 该口径 49 行；`lib/status-store.js` 真实 58 行 → 37 行）。因此**本文所有行数一律以 `[System.IO.File]::ReadAllLines()`（UTF-8）为准**，与编辑器及 `read` 工具显示一致。

> 这次口径错误本身是一次典型的「弱证据判定成功」，详见 §6.5。

---

## 2. 技术选型依据

| # | 选型 | 解决的问题 | 被否的备选方案 |
|---|---|---|---|
| 1 | Cordis 插件框架 | 接入 DSH 事件总线（`agent/*`、`tools/*`） | 动态包沙箱脚本 |
| 2 | Typert Remote 作 Client↔Host 通道 | Client 半边无网络能力 | HTTP 状态路由 / `host.call` |
| 3 | `ctx.subprocess` 写 Vault | 会话 fs 沙箱围栏写操作 | `ctx.fs.writeText` 直写 |
| 4 | `ctx.fs` 只读扫描索引 | 遍历 `D:/MyVault` 建索引 | 起子进程跑扫描脚本 |
| 5 | 复用 `obsidian-mcp-bridge`（15 工具） | 让模型能操作 Vault | 自研 MCP server |

**① Cordis 插件框架** — 需求核心是「无感」，不能改变用户对话流程。Cordis 提供 `agent/pre-step`（waterfall，可改写 decision）、`tools/result`（emit）、`agent/turn-stopping`（serial）、`agent/created`（serial），正好覆盖 PRD §5.1.2 的四个 Hook（映射见 `README.md:35-40`）。
*备选为何被否*：动态包沙箱需要 `harness` 服务，而 `harness` 只存在于沙箱上下文——普通 Cordis 插件注入会让插件永久 pending（§4.5 实测）；且沙箱路径下 `ctx.inject` 被 guard facade 拒绝（`CTX_VERBS` 白名单不含 `inject`，`dsh-cordis-client-runner/lib/client.js:205-216`）。

**② Typert Remote** — Client 半边**没有网络能力**。DSH 文档原文（`dsh-cordis-client-runner/README.zh.md`）：「浏览器半拿到一组固定的名字——`React`、`console`、`styles` 与 `host`——而 `fetch`、`setTimeout` 这类浏览器全局不可用」，`fetch` 的说明是 "network belongs to the HOST half"。因此面板取数必须走进程内 RPC。
*备选为何被否*：HTTP 状态路由 → Client 没有 `fetch`，永远不可达（`client.js:19` 的 `STATUS_URL` **【1.0.1 已移除】**，见 §7 I-1）；`host.call` → `host` 只注入给动态包，普通 bundle 拿不到（实测日志 `Host RPC 不可用（host 未注入）`，`test/lead-findings.md:14-16`）；轮询 `ctx` 服务 → Host 状态对象不在 Client 可见的服务图上。

**③ `ctx.subprocess` 写 Vault** — `@deepseek-ai/dsh-fs-sandbox` 按会话 sandbox 模式围栏 `ctx.fs` 的**写**操作（默认 `read-only`；`workspace-write` 只放行会话工作区 + 临时目录），直写 `D:/MyVault` 会被拒。**子进程缝不被 sandbox 消费层围栏**，这是唯一可靠的写路径（`README.md:28-31`、`lib/writer.js:11-13`）。
*备选为何被否*：`ctx.fs.writeText` → 被 sandbox 拒绝；裸 `node:fs` → 绕过所有审计且插件沙箱内拿不到绝对路径写权限；经 MCP 写 → MCP 是给**模型**用的工具，会引入「模型没调用就没写」的竞态。

**④ `ctx.fs` 只读扫描索引** — sandbox **放行读操作**，即使会话处于 `workspace-write` 模式也能扫描 `D:/MyVault`（`lib/vault-index.js:99-101`）。
*备选为何被否*：起子进程跑扫描 —— 每次 prompt 前 fork Node 扫描 147 篇笔记代价过高，且结果无法进程内复用，会破坏 §3.3 的 TTL 缓存。

**⑤ 复用 MCP** — 需求是「让模型能操作 Vault」，`obsidian-mcp-bridge` 已注册 15 个 `mcp__obsidian-local__*` 工具，直接复用（`cordis.patch.yml:19-29`）。实测 DSH 实时工具目录含 15 个工具（`test/e2e-verification.md:238-248`），`obsidian_get_stats` 真实返回 147 篇笔记。
*备选为何被否*：自研 MCP server —— 15 个工具需重新实现与测试，收益为零。

---

## 3. 核心功能实现亮点

### 3.1 四个事件钩子的设计

| PRD Hook | DSH 事件 | 模式 | 实现 | 关键设计 |
|---|---|---|---|---|
| `UserPromptSubmit` | `agent/pre-step` | waterfall | `index.js:222-277` | `await next()` 先放行，再改写 decision |
| `PostToolUse` | `tools/result` | emit | `index.js:286-312` | 两道闸门降噪 |
| `Stop` | `agent/turn-stopping` | serial | `index.js:313-318` | 双档取末条助手消息 |
| `SessionStart` | `agent/created` | serial | `index.js:213-219` | 子代理跳过 |

**`agent/pre-step`**：waterfall 必须先调 `next()` 拿下游决策（`index.js:225-226`），随后三重闸门：①只有每轮第一步才是用户 prompt（`step !== 1` → 返回，`:228`）；②末条必须是真实用户输入（`isRealUserMessage`，即 `role==='user' && source.kind==='user'`，`lib/message.js:65-67`）；③prompt 文本非空（`:246`）。闸门 ② 是**防无限注入**的关键：插件自己注入的消息 `source.kind` 是 `'runtime-context'`，不会被误判为用户输入（用例 `test/wiring.mjs:130-140`）。

**`tools/result`**：早期对**每一次**调用都留痕，导致 `thinking.md` 出现大量 `工具:  输入: {}` 空条目。修复后两道闸门（`index.js:298-307`）：先滤掉空参数（`{}` / `{"value":""}` / `{"value":null}`），再按关键词表过滤（`project/task/todo/plan/roadmap` + `memory/remember/recall/forget/knowledge/note`）。噪声比从 1617:135（≈12:1）降到当前 1033:28（≈37:1）。

**`agent/turn-stopping`**：该事件在回合关闭前触发，本轮消息可能未落盘，故第一档（从 `session.seq - 1` 向前找 `assistant/message`，遇 `turn/start` 停止，`index.js:52-63`）有时取不到；第二档用 `session.deriveMessages()` 从尾部找 `role==='assistant'`（`:68-77`）；两档都失败退化为空摘要，不抛错（`:81`）。

**`agent/created`**：`isSubagent(agent)` 判定 `header.origin==='subagent' || (header.delegationDepth ?? 0) > 0`（`lib/message.js:74-78`），子代理的 `agent/created` 与 `agent/turn-stopping` 都被跳过（`:214`、`:314`），避免与父会话重复留痕（用例 `test/wiring.mjs:193-199`）。

### 3.2 写路径绕沙箱：三层

```
第 1 层  Cordis 插件（DSH 主进程）  ctx.subprocess.spawn({ argv:[node, bridge.js, event],
                              stdio:{ stdin:{ data: JSON } }, graceMs:8000 })
             ↓ 子进程缝不被 dsh-fs-sandbox 围栏
第 2 层  Vault 侧脚本（90_Agent/hooks/bridge.js）  从 stdin 读 JSON → 写 Markdown / 更新 frontmatter
             ↓
第 3 层  审计（90_Agent/audit/*-integrity.json）  contentHash + schema + HMAC-SHA256 三重校验
```

四个设计要点：①**fire-and-forget 不阻断对话**（`lib/writer.js:72-94`，失败只记 debug 日志）；②**宽限期 8 秒**（`GRACE_MS = 8000`，`:4`）；③**输出上限 8 KiB**（`OUTPUT_MAX_BYTES = 8192`，`:6`）；④**失败不阻断**（解析不到 node 或启动抛错时 `spawn` 返回 `null`，事件处理器照常完成）。

### 3.3 索引 TTL 缓存

`index.js:34` 定义 `INDEX_TTL_MS = 5 * 60 * 1000`。`ensureIndex`（`:136-153`）做三件事：

1. **TTL 复用**：`Date.now() - indexBuiltAt < INDEX_TTL_MS && index.length > 0` 时直接返回内存索引，避免每次 prompt 都扫描 147 篇笔记。
2. **`indexPromise` 去重**：并发调用共享同一次构建，不会打出 N 个扫描进程。
3. **失败退化为空索引**：`.catch(() => [])` 保证检索失败时跳过注入、仍记录对话（`:255-257`），不让索引故障影响主链路。

扫描侧另有三道上限防失控（`lib/vault-index.js:4-9`）：单文件 `MAX_FILE_BYTES = 256 KiB`、递归深度 `MAX_DEPTH = 8`、条目总数 `MAX_ENTRIES = 5000`。

### 3.4 注入消息的不可重复设计

`createInjectedUserMessage()`（`lib/message.js:30-41`）构造一条**已深度冻结**的用户消息，`source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name, text, entryCount }] }`。两个细节：

- **`deepFreeze`** 等价于 `@deepseek-ai/dsh-llm` 的 `deepFreeze`。该包 npm 上只有过期的 `0.0.1-rc.1`，Harness 用 `0.2.1-rc.2`，故本地实现等价逻辑而不引入依赖（`lib/message.js:4-15`）。
- **`sections` 携带 `entryCount`**，审计时能知道本次注入了几条笔记。

### 3.5 快照兜底：永不返回 null

`lib/status-store.js:31-41` 的 `getSnapshot()` 在快照未写入时**现场构建一次**而非返回 null：

```js
if (snapshotValue !== null) return snapshotValue;
if (typeof snapshotBuilder === 'function') { try { snapshotValue = snapshotBuilder(); } catch {} }
return snapshotValue;
```

**为什么需要**：面板可能在插件激活完成前就发起首次取数。若此时返回 null，Client 侧会抛「Host 返回空结果」，把一个**时序问题**伪装成**通道故障**——§5 的排查就差点被这类噪声误导。

---

## 4. 问题与根因分析：7 个真实坑

### 4.1 坑 1：Host 清单 `service` 悬空

- **现象**：Client 面板注册成功，但取数报 `gateway/service-unavailable`；后端实测 `ctx.get('obsidianBridge')` 返回 `undefined`。
- **排查过程**：①怀疑清单缺 `execute` 字段 → 全仓库 grep `execute.call` 仅 6 处，全在 Cordis/pnpm，Typert 栈（loader/registry/protocol/gateway）**零命中** → 排除；②怀疑 contribution 结构非法 → 逐字段核对 loader 与 registry 校验规则，结构合法 → 排除；③用 DSH 安装内真实包跑脚本 → loader 接受清单、registry 接受贡献、`ctx.typert.local.get('obsidianBridge/status')` 能取到描述符，但 `ctx.get('obsidianBridge')` 是 `undefined`。
- **根因**：Typert 网关 strict 分发**不读 `descriptor.invoke`**，读的是 `ctx.get(descriptor.service)` 上的**真实 Cordis 方法**。清单写了 `service: 'obsidianBridge'`，但 Host 上下文里没有这个名字的 Service。
- **修法**：`lib/bridge-service.js:39-55` 新增 `class ObsidianBridgeService extends TypertRemoteService`，`super(context, 'obsidianBridge')`，`await ctx.plugin(ObsidianBridgeService)`。`super` 同时把 `namespace` 绑成 `'obsidianBridge'`，与清单对齐。
- **证据行号**：`dsh-api-gateway/lib/index.js:1191-1194`（`receiverContext.get(descriptor.service)` → `gateway/service-unavailable`）、`:1212-1214`（`Reflect.get(callReceiver, implementation)`）、`:1224-1229`（`resolveDescriptor` strict 命中）、`:1698-1709`（`validateBinding`/`readBinding` 要求 `typertRemote` 绑定）；`dsh-typert-protocol/lib/index.js:326-352`（`bindTypertRemote`/`TypertRemoteService`）；官方参照 `dsh-mcp-panel/lib/index.js:2399`（`class McpPanelService extends TypertRemoteService`）、`:2896`（`await ctx.plugin(McpPanelService, …)`）。
- **教训**：「清单通过 loader 校验」≠「运行时可用」。loader 只校验**形状**，网关运行时分发只认**真实 Service**。清单的 `input`/`invoke` 通过了校验，但**下游没有任何消费者**（`dsh-typert-loader/lib/index.js:208-212` 只做「两个都是函数」的校验）——它们是 `typert.remote-client.js` 生成物上的客户端辅助，不是 Host 清单的消费字段。

### 4.2 坑 2：Client 直读 `ctx.remote.<ns>` 静默返回 undefined

- **现象**：`cannot get property "remote.obsidianBridge" without inject`；面板渲染 `undefined`。
- **排查过程**：①日志显示 `Typert Remote 已挂载`（`$mount` 成功）→ 排除「Host 清单未注册」；②对照 4 个官方/参考实现，**全部**用 `ctx.inject`，无一直接读属性；③读 Cordis 源码定位点号转发机制。
- **根因**：`ctx.remote` 是 Cordis `createTraceable` 返回的代理，点号转发**只在 `props` 已声明时生效**（`cordis/lib/index.js:130`）：`if (tracker.associate && ctx.reflect.props[\`${tracker.associate}.${prop}\`])`。`tracker.associate` 对 `remote` 就是 `'remote'`；未声明时走 fallthrough，**静默返回 `undefined`，不抛错**——正好对应「面板注册成功但取不到数据」。`props['remote.<ns>']` 由 `$mount` 内部的 namespace fiber 写入（`dsh-api-gateway/lib/client.browser.js:2074-2076` 的 `remoteServiceKey(namespace) => \`remote.${namespace}\``）。
- **修法**：`client.js:266-269` 改用官方入口 `ctx.inject(['remote.obsidianBridge'], (scope) => { remoteService = scope.remote.obsidianBridge; })`。
- **证据行号**：`dsh-api-gateway/lib/client.browser.js:2074-2076`；`cordis/lib/index.js:130`（源码版 `cordis/src/utils.ts:180`）；`cordis/lib/index.js:676`（`cannot get property "${prop}" without inject`）；`dsh-api-gateway/README.zh.md:56`（官方文档明确「每个 namespace 都是可追踪的 `remote.<namespace>` 子 Service」）。
  4 个参考实现（**全部**使用 `ctx.inject`）：`dsh-mcp-panel/lib/client.js:7764-7772`；`dsh-api-remote-access/lib/client.js:665-666`；`dsh-experimental-client-ui-cot-translation/lib/client.js:1027-1028`；`dsh-experimental-client-ui-voice-input/lib/client.js:2944`。本插件曾是唯一直接读属性的。
- **教训**：注释里写「与 dsh-mcp-panel 同款用法」，但实际不是——**注释不能替代验证**（§6.3）。而且这类错误是**静默**的：不抛异常、不报警，只是渲染出 `undefined`，极易被误判为「后端没数据」。

### 4.3 坑 3：`ctx.effect(fiber)` 误用

- **现象**：每次 Client 激活都写一条 `TypeError: e.execute.call is not a function`；且 disposer 从未注册（卸载泄漏）。
- **排查过程**：①全仓库 grep `execute.call` → 6 处，只有 Cordis 的 `Fiber._execute` 是候选（其余在 pnpm 的 AsyncList，与 DSH 无关）；②从压缩产物 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 原样取出同段 `_execute(e){…n=e.execute.call(this);…}`，确认 `e` 就是 Cordis 的 `runner`；③读 runner 构造（`cordis/lib/index.js:1190-1199`）：`{ execute, epoch, collect, getOuterStack }`，其中 `execute` 就是 `ctx.effect()` 的**第一个实参**；④反推 `runner.execute` 不是函数 ⟺ **有人调用了 `ctx.effect(X)` 且 `X` 不是函数**。
- **根因**：`ctx.inject(...)` 返回值是 **fiber wrapper**，不是函数——`inject()` 返回 `this.plugin({ inject, apply: callback })`（`cordis/lib/index.js:1600-1606`），而 `plugin()` 返回 `Object.create(fiber)` 的 wrapper，只有 `.then` 与 `.dispose`（`:1635-1640`）。于是 `ctx.effect(follow)` 触发 `runner.execute.call(this)`（`:1142`）报错。
- **修法**：`client.js:270-272` 改为 `follow.then(() => { ctx.effect(() => follow.dispose()); })`（对齐 `dsh-api-remote-access/lib/client.js:666,674-675`）。
- **证据行号**：`cordis/lib/index.js:1142`（报错点）、`:1190-1199`（runner 构造）、`:1600-1606`（`inject()` 返回 `this.plugin(...)`）、`:1635-1640`（`Object.create(fiber)` wrapper）。
- **后果（三条且互相掩盖）**：①每次激活一条 error 噪声，会被误判为「通道仍断」；②`ctx.effect` 抛错 ⇒ **disposer 从未注册** ⇒ 插件卸载后命名空间绑定残留；③但回调**仍然执行**（`ctx.plugin` 已注册 callback），所以**数据通道其实是通的**——这就是「14/14 PASS」与「面板取不到数据」之外的第三种状态：**通道通但有残留错误**。
- **教训**：**报错信息里的变量名（`e`）指向 Cordis 内部的 runner，不是调用点。** 顺着 `e` 找定义一无所获；正确做法是顺着 `runner.execute` 的**赋值来源**反查——`execute` 就是 `ctx.effect` 的第一个实参。

### 4.4 坑 4：漏解包 `{ok, value}`

- **现象**：面板渲染 `undefined`（即使通道已通）。
- **根因**：Remote 方法**不返回原始值**，而是包装对象。`dsh-api-gateway/lib/client.browser.js:1829-1836`：`if (!result.ok) return { ok:false, error: rebuiltFailure(...) }; return { ok:true, value: … }`。
- **修法**：`client.js:108-119` 增加 `unwrap(result, method)`，在 `loadStatus()` 里调用（`:134`）。除解包外还做三件事：空结果抛可读错误、`ok===false` 时带上 `error.code` / `error.message`、保留 `result.ok === true ? result.value : result` 兼容分支。
- **证据行号**：`dsh-api-gateway/lib/client.browser.js:1829-1836`；官方参照 `dsh-mcp-panel/lib/client.js:7768-7772`（同款 `unwrap`）。
- **教训**：包装对象是**双刃剑**——让错误可携带 `code`/`message`，但也让「忘了解包」变成一个**静默的** `undefined`。

### 4.5 坑 5：注入 `harness` 导致插件永久 pending

- **现象**：`obsidian-bridge (@local/obsidian-bridge): pending (waiting for service: harness)` —— 整个插件停摆，所有事件钩子都不注册。
- **排查过程**：①实测 `cannot get property "harness" without inject`；②把 `harness` 加进 `inject` → 日志变成 `pending (waiting for service: harness)`，**永远不激活**。
- **根因**：`harness` 只存在于**动态包沙箱上下文**。本插件走静态 bundle 路径（workspace link + profile bundle），拿不到它。Cordis 依赖状态机遇到无法满足的注入依赖，fiber 停在 PENDING 且不会超时。
- **修法**：`index.js:31` 移除 `harness`，改为 `export const inject = ['agents', 'fs', 'subprocess']`；Host 调用改走 Typert Remote（§4.1）。
  > **【1.0.1 已移除】** 1.0.0 当时的修法是 `['agents', 'fs', 'subprocess', 'webServer']`——
  > 为了给 HTTP 状态路由续命而把 `webServer` 也声明成硬依赖。1.0.1 把 `webServer` 一并删除了
  > （路由本身是死路，§4.6）。**这是一次「用更硬的依赖去修一个本该删掉的功能」的教训。**
- **证据行号**：`index.js:25-27`（注释记录该坑与实测日志）、`:29`（修复后的 inject 列表）；历史日志 `%APPDATA%\DSH Desktop\logs\dsh-2026-10-21.error.log:32,38,44,52`（`test/e2e-verification.md:220-228`），当前 run 已不再出现。
- **教训**：「注入一个听起来很对的服务名」是**最危险的一类错误**——不报错、不警告，只是让插件**永远不激活**，且症状（面板无数据）与「通道故障」完全一样。
  > 同源问题：`webServer` 也差点踩同一个坑。早期用 `ctx.get('webServer')` 可选获取，激活时返回 `undefined`，状态路由从未注册，Client 拿到 404。当时的修复是把它**声明为硬依赖**（`index.js:21-23` 注释），插件会等它就绪再激活。
  >
  > **【1.0.1 已移除】** 1.0.1 复核发现：这个「硬依赖」是为一个**从未有真实消费者**的路由服务的
  > （累计 `status-hit` 仅 1 次，且是自测打的）。1.0.1 直接删掉了 `webServer` 依赖与整条路由，
  > 插件因此少一个硬依赖。**教训：修一个功能的「激活时序」，先问它是否该存在。**

### 4.6 坑 6：Client 半边无 `fetch` —— HTTP 状态路由是死路

- **现象**：`GET /obsidian-bridge/status` 在 Client 侧**永远不可达**。用 curl 探测时所有路径都返回 403（含 `/` 与随机路径），无法区分「路由已注册 200」与「路由未注册 404」。
- **根因**（两层）：①**Client 半边没有 `fetch`**——DSH 文档原文（`dsh-cordis-client-runner/README.zh.md`）：「浏览器半拿到一组固定的名字——`React`、`console`、`styles` 与 `host`——而 `fetch`、`setTimeout` 这类浏览器全局不可用」，`fetch` 的说明是 "network belongs to the HOST half"；②**HTTP 请求被 Origin 围栏拦截**——`dsh-client-connection/lib/index.js:742-743` 的 `admit(request)` 在 `!this.isTrusted(request)` 时直接返回 `{ rejection: 403 }`，脚本请求不带浏览器 Origin，一律被拦。
- **修法**：Client 半边改走 Typert Remote（§4.2）。
  > **【1.0.1 已移除】** 1.0.0 当时把 HTTP 路由「保留为外部监控用途」（`index.js:183-207`）。
  > 1.0.1 复核后**整体删除**：`mountStatusRoute()` 既无成功日志也无失败日志，外部 `curl` 被 403 拦死，
  > 累计 `status-hit` 仅 1 次（自测）。**「保留一个没人用的通道」本身就是技术债**——它会持续
  > 让后来者以为那是一条可用路径（§7 I-6 因此作废）。
- **证据行号**：`dsh-cordis-client-runner/README.zh.md`；`dsh-client-connection/lib/index.js:742-743`。
  > **【1.0.1 已移除】** 1.0.0 时期还有 `client.js:19` 的 `const STATUS_URL = '/obsidian-bridge/status';`
  > （死代码）与 `index.js:183-207` 的路由实现；两者均已在 1.0.1 删除。
- **教训**：「同源 HTTP 请求随浏览器会话携带鉴权」是一个**看起来合理但未经实测**的假设。DSH 的 Client 半边是**受限的浏览器模块运行时**，不是普通网页——它的全局对象集合是显式白名单。

### 4.7 坑 7：测试假阳性 —— 14/14 PASS 与「面板取不到数据」同时成立

- **现象**：`node test/acceptance.mjs` 输出 **14/14 PASS**；同一时刻 Client 面板取不到数据。
- **排查过程**：①逐行读 4 个测试文件的断言对象；②发现 `wiring.mjs` 与 `status-refresh.mjs` 都**桩掉了 `ctx.subprocess.spawn`**；③用 grep 验证测试套件对 Client↔Host 通道的覆盖率。
- **根因**：两个测试文件把**被测的那一层** mock 掉了：
  ```js
  // test/wiring.mjs:53-70（status-refresh.mjs:61-71 同款）
  spawn(spec) {
    calls.push({ kind: 'spawn', argv: spec.argv, stdin: spec.stdio?.stdin, env: spec.env });
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {} };
  }
  ```
  于是断言变成「插件**构造了**一个 spawn 请求」，而**子进程从未执行**：

  | 断言 | 位置 | 实际证明的东西 |
  |---|---|---|
  | `user-prompt` 事件写入 bridge.js stdin | `wiring.mjs:106-114` | 只检查 `argv[2]` 与 stdin JSON；`90_Agent/hooks/bridge.js` 从未运行 |
  | 非第一步不注入、不留痕 | `wiring.mjs:126` | 只证明没构造 spawn 请求 |
  | `tools/result` 触发 post-tool 留痕 | `wiring.mjs:160-166` | 只比对 argv |
  | `agent/turn-stopping` 触发 stop 留痕 | `wiring.mjs:174-177` | 同上 |
  | `agent/created` 触发 session-start 与记忆同步 | `wiring.mjs:185-190` | 记忆同步脚本同样没跑 |
  | 子代理的 agent/created 被跳过 | `wiring.mjs:197` | 只证明没有 spawn 请求 |
  | 状态路由注册并返回 JSON 快照 | `wiring.mjs:201-228` | 用**手写假 response** 断言 JSON 形状，完全绕过真实 HTTP 栈 |

  `status-refresh.mjs` 更弱：6 项断言全部针对**同进程内存里的计数器**，且 `:34` 的 `get: () => undefined` 让 `ctx.get('webServer')` 永远 undefined，当时的 `mountStatusRoute()` 直接 return —— **真实路由路径一次都没走**。
  > **【1.0.1 已移除】** `mountStatusRoute()` 与 `webServer` 依赖已删除，因此这段「路由路径没走」的
  > 批评在 1.0.1 已无对象。但**假阳性的模式依然存在**：`status-refresh.mjs` 仍然只断言进程内计数器。
- **决定性的覆盖率检查**：`grep -rn "remote\|obsidianBridge\|client" test/*.mjs` → **0 命中**（当时）。
- **修法**：新增 `test/e2e-verify.mjs`（376 行），分层判据，每条都明确「数据从 A 流到 B」且 **B 端必须是可观察的外部产物**：ENV（junction / profile bundles）｜E1-E5（事件 → 子进程 → Vault 日志配对）｜E4（注入路径真实存在）｜G1-G2（`totalScanned > 0`、`integrity.overall === true`）｜M1-M2（`tools/list` = 15、`get_stats` 返回真实笔记数）｜C1-C5（日志出现 `remote.obsidianBridge 已就绪`）｜P1-P2（HTTP 200 + 计数增长）。
- **证据行号**：`test/wiring.mjs:53-70`、`:106-114`、`:201-228`；`test/status-refresh.mjs:61-71`、`:34`；`test/acceptance.mjs:226-248`（PLUGIN 检查只是把前两个在 profile node_modules 下重跑一遍）；`test/e2e-verification.md:28-101`（假阳性清单与判定标准）。
- **教训**：这是本次开发**最贵的一个坑**——它让前 6 个坑的修复都没有被验证。详见 §6.1。

### 4.8 补记（1.0.1）：坑 8 —— 调用了未导出的方法

> 本节是 1.0.1 同步时补写的。它是**同一类问题**（静默失败）的第二个实例，
> 因此保留在这份复盘里而不是只写进 [CHANGELOG.md](CHANGELOG.md)。

- **现象**：**知识库不增长**。`30_Resources/` 下没有新条目；面板「知识整理」恒为 0；
  **DSH 日志里没有任何 organize 报错**。
- **排查过程**：①先确认上游留痕正常（`conversation.md` 在增长）→ 排除链路 1；
  ②检查 `organize.enabled` / `enabled.stop` / 节流 → 都正常；
  ③**决定性一步**：`Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"` → **`False`**。
  游标文件从未生成，说明脚本**从未被插件调用过**；
  ④用临时 Vault 隔离跑脚本本身 → `{"scanned":2,"created":1,"skipped":1}`，第 2 次 `created:0`
  （游标 + 去重生效）。**脚本是好的，责任在插件接线**；
  ⑤用桩 `ctx` 隔离跑 `createRunner()` → `runner 的键 = ["bridge","memorySync"]`，
  `typeof runner.spawn = undefined`，调用抛 `TypeError: runner.spawn is not a function`。
- **根因**：`index.js:472` 调用 `runner.spawn(...)`，但 `lib/writer.js` 的 `return` 块
  **只导出了 `bridge` 与 `memorySync`**（`spawn` 是 `:48` 的闭包内部函数，未暴露）。
  异常被 `index.js:484` 的 `.catch(() => {})` 吞掉。
- **修法**：`lib/writer.js:140-154` 的 return 块补 `spawn(args, stdinData)`；
  回归守卫 `test/wiring.mjs:246-263` **直接核对 `createRunner()` 的导出表**。
- **证据行号**：`index.js:463-485`（`maybeOrganize`）、`:472`（调用点）、`:484`（吞异常）；
  `lib/writer.js:48`（内部 `spawn`）、`:129-138`（修复前的 return 块）、`:140-154`（修复后）；
  `test/wiring.mjs:246-263`（守卫）。
- **三层不可见**（这是它比坑 7 更隐蔽的地方）：

  | 观测面 | 看到的 | 为什么看不出问题 |
  |---|---|---|
  | 日志 | 什么都没有 | 异常被 `.catch(() => {})` 吞掉，零输出 |
  | 计数器 | `organizeRuns: 0` / `organizeFailed: 0` | 「0 次」与「从未运行」**不可区分** |
  | 测试 | 全绿 | 没有任何断言涉及「知识库增长」 |

- **教训**：`runner.spawn` 与 `runner.bridge` 在**源码阅读上完全对称**——都是 `async function` 定义 + 被调用。
  区别只在 `return {...}` 那一块有没有把它列进去。**静态阅读无法发现这类缺陷。**
  唯一能证伪的是**产物**（游标文件是否存在）。
  这条教训把 §6.2 的「三层证据强度」推向了一个更强的版本：**当失败是静默的时候，
  「没有错误」本身就是最危险的信号——你必须主动去找一个「本该出现的产物」，而不是等一个错误出现。**

---

## 5. 关键挑战与解决路径：Client↔Host 通道的 4 层递进排查

Client 面板取不到数据是整个项目**唯一贯穿始终的阻塞项**。排查是典型的「假设 → 证伪 → 下一层」，共 4 层。

**第 1 层｜假设「清单缺字段」→ 证伪。** 错误信息 `e.execute.call is not a function` 疑似指向 invocation 缺 `execute`。全 `APP` 目录 grep `execute.call` 命中 6 处，Typert 栈（loader/registry/protocol/gateway）**零命中**。→ 排除，嫌疑范围收窄到 Cordis 运行时。

**第 2 层｜假设「contribution 结构非法」→ 证伪。** 逐字段核对 `BRIDGE_REMOTE`（`client.js:36-58`）与两侧校验规则：Gateway 侧 `validateContribution`（`dsh-api-gateway/lib/types/client/index.js:146-188`）与 `requireStrictInputs`（`:597-607`）；Typert registry 侧 `RemoteStore.register`（`dsh-typert-registry/lib/client.browser.js:147-162`）与 `validateInvocation`（`:583-622`）。→ 结构合法，无缺失必需字段。

**第 3 层｜定位「直读属性 vs `ctx.inject`」→ 命中。** 关键线索是日志里两条错误指向两个不同失败点：`Typert Remote 已挂载`（`$mount` 成功，说明 Host 清单已注册）+ `remote 服务读取失败: cannot get property "remote.obsidianBridge" without inject`（失败发生在**取命名空间**）。对照 4 个官方/参考实现全部用 `ctx.inject`（§4.2 表格），读 Cordis 源码 `createTraceable` get 陷阱（`cordis/lib/index.js:130`）确认机制。→ `client.js` 改用 `ctx.inject`，日志随即出现 `remote.obsidianBridge 已就绪`——**诊断得到验证**。

**第 4 层｜收尾「`ctx.effect` 误用」→ 次生错误。** 通道通了但 `e.execute.call` 仍在刷。**关键判断**：这不是第 3 层的残留，而是一个**独立的次生错误**——`ctx.plugin` 已注册 callback（通道通），只是 `ctx.effect(follow)` 抛错。→ `client.js:270-272` 改为 `follow.then(() => ctx.effect(() => follow.dispose()))`。

### 5.1 排查决策树（可复用）

```
面板取不到数据
├─ Client 半边 apply() 跑了吗？        没有 → 查 dsh.client.platform / dsh.bundle.patch（ENV 层）
├─ $mount 成功了吗？                    失败 → 查 contribution 形状 + dsh.client.inject 是否含 dsh-api-remotes
├─ 命名空间取到了吗？                   报 "without inject" / 静默 undefined → 必须用 ctx.inject，不能直读
├─ 解包了吗？                          渲染 undefined → 加 unwrap()（返回值是 {ok, value}）
└─ 还有 error 日志？                    查是否把 fiber wrapper 传给了 ctx.effect
```

**核心方法论**：**每一层都先确认「上一层真的成功了」，再进入下一层。** 跳过这一步，就会像初版排查那样，把 `e.execute.call` 误判成「通道仍断」的证据。

---

## 6. 经验教训

### 6.1 假阳性测试：断言对象必须是「最终产物」，不能是「中间调用」

本次开发**代价最大**的方法论问题。判定标准：

> 断言对象是「最终产物」还是「中间调用」？
> **最终产物** = Vault 文件 / HTTP 响应体 / MCP 返回值 / 日志配对行；**中间调用** = `calls` 数组元素 / 内存计数器 / 被 mock 的函数入参。

| 测试文件 | 断言强度 | 数量 |
|---|---|---|
| `acceptance.mjs` | 真断言为主（真起子进程、真读 Vault） | 13 真 / 2 弱 |
| `e2e-verify.mjs` | 真断言（分层 A→B 外部产物） | 16 PASS / 1 FAIL / 2 MANUAL（1.0.0）→ **16 PASS / 0 FAIL / 3 MANUAL**（1.0.1） |
| `wiring.mjs` | **全部是「部分连通」级假阳性** | 10/10 假阳性 |
| `status-refresh.mjs` | **全部是进程内假阳性** | 6/6 假阳性 |

**「反假阳性」编写规范**（已写入 `test/e2e-verification.md:166-174`，建议照抄）：①**先建基线**，断言前后比对增量；②**否定断言用严格不等** `after > before`，**禁止 `>=`**（反例：`acceptance.mjs:159-167` 的 `readdirSync(governance).length >= before` —— 治理零产出时仍 PASS，实测 `governance/2026-10-21-governance.json` 内容为 `[]`）；③**禁止 mock 掉被测的那一层**；④**因果绑定**（产物须带本次运行的时间戳/唯一 id，反例：`acceptance.mjs:78-82` 只断言当日 `conversation.md` 含「对话结束」，该文件可能由任何历史会话产生）；⑤**每条断言附产物路径**。

### 6.2 弱证据判定成功：三层证据强度

本次反复出现「看起来成功了」的陷阱。建议把证据分三层，**只有第三层才能判「成功」**：

| 层级 | 证据形态 | 能证明 | 不能证明 | 本次实例 |
|---|---|---|---|---|
| **L1 结构** | 清单通过 loader 校验；字段齐全 | 形状合法 | 运行时可用 | §4.1 假设 1/2 |
| **L2 调用** | 日志「已挂载」；`calls` 有元素；内存计数器 +1 | 代码执行到了某一行 | 数据真的流到终点 | §4.7 的假阳性 |
| **L3 产物** | Vault 文件 / HTTP 响应体 / MCP 返回值 / 日志配对行 | **A → B 真的闭合** | — | §4.7 的修法 |

**判定规则**：只有 L1 → 结论只能是「未发现结构问题」；只有 L2 → 结论只能是「调度链路通」，**不能说「功能可用」**；有 L3 → 才能说「功能可用」。本次最典型的误判风险：`wiring.mjs` 的 10 项全是 L2，却被写进 `acceptance.mjs` 的 PLUGIN 检查（`:226-248`），于是「14/14 PASS」实际只证明了 L2。

### 6.3 注释不能替代验证

`client.js` 的注释写着「与 dsh-mcp-panel 同款用法」，但实际不是——mcp-panel 走 `ctx.inject`。这条错误注释直接引导了 §4.2 的错误实现。**规则**：注释里的「与 X 同款」「照抄 Y」必须附上 **X/Y 的文件路径 + 行号**，并在改动时复核该行号是否仍成立。没有行号的同款声明等于没有声明。

### 6.4 报错信息里的变量名会误导

`TypeError: e.execute.call is not a function` 里的 `e` 是 Cordis 内部的 `runner`，不是任何调用点的变量。**规则**：遇到压缩变量名（`e`/`t`/`n`）时，先在**压缩产物**里定位到对应源码段，再读源码段里**有意义的标识符**（`runner`、`execute`、`epoch`、`collect`），用后者反查。

### 6.5 测量口径本身也是证据

§1.3 的行数口径错误说明：**同一个文件可以有两个「实测」数字**，差别不在文件，在测量方法。**规则**：①任何统计脚本先**自校验**（用已知行数的文件验证口径——`Get-Content | Measure-Object -Line` 在中文文件上不可靠）；②报告里凡出现「行数/字符数/计数」都要写明**统计命令**；③数字增长时先区分「口径变化」与「真实增长」——本次 Vault 字数 279635 → 282525 是真实增长，而 `post-tool` 1033 → 2070 是**口径错误**。

### 6.6 「静默失败」比「报错失败」更贵

本次 7 个坑里有 4 个是**静默**的：§4.2 直读属性（返回 `undefined`，需读 Cordis 代理源码才定位）、§4.4 漏解包（渲染 `undefined`）、§4.7 假阳性测试（断言 PASS，**成本极高**——让 6 个坑的修复都未被验证）。**规则**：凡返回值会被直接渲染或序列化的地方，**必须显式校验结构**。`client.js:148-151` 的做法值得推广：

```js
if (data === null || typeof data !== 'object') throw new Error(`快照结构异常: ${JSON.stringify(data)}`);
```

把「静默的 undefined」变成「带数据的报错」，是成本最低的调试投资。

---

## 7. 改进建议（可执行）

| ID | 优先级 | 改进项 | 具体动作 | 依据 | 验收判据 |
|---|---|---|---|---|---|
| **I-1** | P0 | 删 Client 死代码 | 移除 `client.js:19` 的 `STATUS_URL`（已无引用） | §4.6 | ✅ **1.0.1 已完成**（随 R-04 一并删除） |
| **I-2** | P0 | 修正 README 通路描述 | `README.md:82-93` 仍写「数据取自 `GET /obsidian-bridge/status`」，但 Client 已改走 Typert Remote | §4.6 | 该节与 `client.js:129-135` 一致 |
| **I-3** | P1 | 测试补 Client↔Host 层 | 起真实 Host 服务 + 真实 Client 半边，断言面板拿到的快照非 null | §4.7 | `grep "remote.obsidianBridge" test/*.mjs` 有命中 |
| **I-4** | P1 | 降噪关键词单一事实源 | `index.js:303-306` 的关键词表与 `bridge.js` 的分类逻辑抽成共享模块 | §3.1 | 两处 `grep projectOps` 指向同一文件 |
| **I-5** | P1 | `govern` 补「应当触发」用例 | 构造违规笔记 → 断言治理**真的产出动作** | `e2e-verification.md:252-263` | 新用例断言 `details.length > 0` |
| **I-6** | P1 | ~~状态路由补埋点~~ | **作废**：`mountStatusRoute()` 已随 R-04 整体删除，无埋点可补 | §4.6 | — （改为：**已取消**） |
| **I-7** | P2 | 清 `desktopDeselectedBundles` 噪音 | 从 profile `package.json` 移除该条目（语义是纯 UI 台账，与实际状态矛盾） | `e2e-verification.md:200-218` | 插件管理页显示与实际一致 |
| **I-8** | P2 | `jsonCodec` 补真实 zod schema | `typert.host.js:21-28` 的 `create: () => ({})` 让类型投影为空 | `backend-findings.md:346-355` | `ctx.typert.toJSONSchema(...)` 返回非空对象 |
| **I-9** | P2 | `diagnose` 埋点降级 | `index.js:319-328` 每次 prompt 都写一条（1.0.0 已 27 次 → **1.0.1 已 152 次**，增速远超其他事件），属调试残留 | §1.2.2 | 加开关，默认关闭 |
| **I-10** | P3 | 统一行数统计口径文档 | 在 `CONTRIBUTING`/README 写明用 UTF-8 逐行统计并给出命令 | §1.3 | ✅ **1.0.1 已完成**（`scripts/check-line-counts.mjs` 可执行地固化了口径） |
| **I-11** | P3 | 坑沉淀为 checklist | §4 的「教训」整理成 PR 模板检查项（1.0.1 起为 **8 条**，含 §4.8） | 全文 | PR 模板含对应检查项 |
| **I-12** | P3 | fire-and-forget 加失败计数 | `status.counters.writeFailures` 已定义但从未 +1 | `lib/status.js:17` | ✅ **1.0.1 已完成**（`lib/writer.js:84-93` 四条分支统一上报） |
| **I-13** | P1 | **导出表守卫泛化** | §4.8 的坑说明「调用了未导出的方法」需要机械化防护 | §4.8 | ✅ **1.0.1 已完成**（`test/wiring.mjs:246-263` 核对 `createRunner()` 导出表） |
| **I-14** | P1 | **「本该出现的产物」断言** | 凡有「静默失败」风险的链路，都必须断言一个**本该存在的产物**（如游标文件），而不是等错误 | §4.8 / §6.2 | 每条静默链路都有一个产物断言 |

**最小闭环（建议立即执行）**：①I-1 + I-2（各 5 分钟，消除会误导下一个人的死代码与错误文档）；②I-3（半天，让测试第一次真正覆盖 Client↔Host 层）；③I-14（把「本该出现的产物」变成断言）。~~I-6~~ 已随路由删除而作废。完成这三步后，「面板取不到数据」与「知识库不增长」这类问题**第一次**具备可自动发现的手段。

**长期建议**：把 §6.1 的反假阳性规范写进 CI（新增测试文件时强制声明断言对象是最终产物还是中间调用）；把 §5.1 的排查决策树写进 `docs/`（Client↔Host 是 DSH 插件通用难点）；给 `lib/status-store.js` 的快照加版本号（Client/Host codec 形状不一致时，当前只能靠渲染 `undefined` 发现）。

---

## 附录 A. 证据索引

**A.1 本插件源码**（行号已按 **1.0.1** 校准；标 ~~删除线~~ 者为 1.0.1 已移除）

| 位置 | 内容 | 位置 | 内容 |
|---|---|---|---|
| `index.js:31` | `inject = ['agents','fs','subprocess']`（1.0.1 移除 `webServer`） | `client.js:108-119` | `unwrap` |
| `index.js:36` | `INDEX_TTL_MS = 5 * 60 * 1000` | `client.js:129-135` | `loadStatus` |
| `index.js:55-90` | `lastAssistantText` 双档取末条助手消息 | `client.js:194-286` | 面板渲染（8 计数 + 最近事件区） |
| `index.js:151-155` | `invalidateIndex`（1.0.1 起同时清 `indexPromise`） | `client.js:311-317` | `ctx.inject` + `follow.then` |
| `index.js:189-217` | `ensureIndex`：TTL + promise 去重 + `ok`/`indexFailed` | `client.js:341` | `exports.inject = ['slots','remote']` |
| `index.js:241-256` | `countMcpTools()`（1.0.1 新增） | ~~`client.js:19`~~ | ~~`STATUS_URL`~~ **已移除** |
| `index.js:291-299` | `agent/created` → session-start | `lib/bridge-service.js:31-65` | `mountBridgeService` + `ObsidianBridgeService` |
| `index.js:301-375` | `agent/pre-step` → 注入 + user-prompt | `lib/config.js:38-45` / `:92-96` | `organize` schema / 默认值（1.0.1 新增） |
| `index.js:397-444` | `tools/result` → 计数 + post-tool 留痕 | `lib/config.js:62` | `SCAN_ROOTS` |
| `index.js:445-454` | `agent/turn-stopping` → stop + `maybeOrganize()` | `lib/config.js:72-101` | `resolveConfig` |
| `index.js:463-485` | `maybeOrganize()`（1.0.1 新增） | `lib/status.js:25-46` | `COUNTER_KEYS` / `REMOVED_COUNTER_KEYS` |
| ~~`index.js:183-207`~~ | ~~`mountStatusRoute`~~ **已移除** | `lib/status-store.js:63-67` | `resetStore()`（1.0.1 新增） |
| `typert.host.js:34-45` / `:51-62` | `STATUS_INVOCATION` / `REFRESH_INVOCATION` | `lib/message.js:30-41` / `:65-67` / `:74-78` | 注入消息 / 真实用户判定 / 子代理判定 |
| `lib/query.js:19-34` / `:56-109` / `:116-128` | 关键词 / 检索 / 格式化 | `lib/status-store.js:31-41` | `getSnapshot` 兜底 |
| `lib/vault-index.js:5-9` / `:113-146` | 扫描三道上限 / `buildVaultIndex` | `lib/writer.js:4,6` | `GRACE_MS=8000` / `OUTPUT_MAX_BYTES=8192` |
| `lib/writer.js:48-67` | 内部 `spawn` | `lib/writer.js:84-93` | `reportFailure`（1.0.1 新增） |
| `lib/writer.js:100-124` | `fire`（fire-and-forget） | `lib/writer.js:140-154` | **导出的 `spawn`**（1.0.1 修复 §4.8） |

**A.1b 文档守卫脚本**（1.0.1 新增，`scripts/`）

| 位置 | 内容 |
|---|---|
| `scripts/check-line-counts.mjs:26-29` | 唯一正确口径：`split('\n').length - (endsWith('\n') ? 1 : 0)` |
| `scripts/check-line-counts.mjs:69-96` | 文档 `（NNN 行）` 声明与实测比对，不一致则退出码 1 |
| `scripts/check-doc-links.mjs` | 文件级链接有效性检查 |
| `scripts/prepare-github.mjs` | 生成 `release-staging/` 脱敏副本（见 K-12） |

**A.2 DSH 平台源码**（根路径 `<DSH_APP_DIR>\`）

| 位置 | 内容 | 位置 | 内容 |
|---|---|---|---|
| `dsh-api-gateway/lib/index.js:1191-1194` | `ctx.get(descriptor.service)` → `service-unavailable` | `dsh-typert-loader/lib/index.js:208-212` | `input`/`invoke` 仅校验，无消费者 |
| `dsh-api-gateway/lib/index.js:1212-1214` | `Reflect.get(callReceiver, implementation)` | `dsh-client-connection/lib/index.js:742-743` | Origin 围栏 → 403 |
| `dsh-api-gateway/lib/index.js:1224-1229` | `resolveDescriptor`（strict 命中） | `cordis/lib/index.js:130` | `createTraceable` 点号转发条件 |
| `dsh-api-gateway/lib/index.js:1698-1709` | `validateBinding` / `readBinding` | `cordis/lib/index.js:676` | `cannot get property … without inject` |
| `dsh-api-gateway/lib/client.browser.js:1829-1836` | `{ok, value}` 包装对象 | `cordis/lib/index.js:1142` | `runner.execute.call(this)` |
| `dsh-api-gateway/lib/client.browser.js:2074-2076` | `remoteServiceKey => remote.${namespace}` | `cordis/lib/index.js:1190-1199` | runner 构造 |
| `dsh-typert-protocol/lib/index.js:326-352` | `bindTypertRemote` / `TypertRemoteService` | `cordis/lib/index.js:1600-1606` / `:1635-1640` | `inject()` 返回值 / fiber wrapper |
| `dsh-mcp-panel/lib/client.js:7764-7772` | 参考：`$mount`+`ctx.inject`+`unwrap` | `dsh-mcp-panel/lib/index.js:2399,2896` | 参考：`McpPanelService` |
| `dsh-api-remote-access/lib/client.js:665-666,674-675` | 参考：`follow = ctx.inject(...)` | `dsh-experimental-client-ui-{cot-translation,voice-input}/lib/client.js:1027-1028,2944` | 参考实现 |

**A.3 运行日志与产物**：`D:/MyVault\00_InteractionLogs\hook-debug.log`（事件计数）、`2026-10-21_*.md` 与 `2026-10-22_*.md`（留痕产物）、`90_Agent\audit\*-integrity.json`（交叉认证）、`90_Agent\knowledge-organize-cursor.json`（**知识整理游标——1.0.1 前不存在，见 §4.8**）、`%APPDATA%\DSH Desktop\logs\dsh-2026-10-2{1,2}.log` 与 `.error.log`（运行/错误日志）。

---

## 附录 B. 复现命令

```bash
# ── 环境：DSH 版本 / profile junction ──────────────────
node -e "console.log(require('<DSH_APP_DIR>/package.json').version)"
Get-Item '<USER_HOME>\.dsh\profiles\desktop\node_modules\@local\obsidian-bridge' | Select LinkType,Target

# ── 代码行数（唯一正确口径；勿用 Measure-Object -Line）──
cd obsidian-bridge
node scripts/check-line-counts.mjs    # 插件 + 文档行数，并核对文档里的「（NNN 行）」声明
node scripts/check-doc-links.mjs      # 文件级链接有效性

# ── 事件计数（Hook triggered 口径）────────────────────
$log='D:/MyVault\00_InteractionLogs\hook-debug.log'
$rx=[regex]'^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[([a-z-]+)\] Hook triggered'; $c=@{}
foreach($l in [IO.File]::ReadAllLines($log)){ $m=$rx.Match($l)
  if($m.Success){ $k=$m.Groups[1].Value; if($c.ContainsKey($k)){$c[$k]++}else{$c[$k]=1} } }
$c.GetEnumerator() | Sort-Object Value -Descending | Format-Table -AutoSize

# ── Vault 规模（MCP 实时）：obsidian_get_stats → { totalNotes, totalWords, totalLines, uniqueTags }

# ── 测试（1.0.1 共 4 个入口）──────────────────────────
node test/acceptance.mjs     # 14 项：PRD §9 验收
node test/e2e-verify.mjs     # 19 项分层端到端（含 Client↔Host 层）
node test/wiring.mjs         # 12 项接线测试；第 12 项是 §4.8 的导出表守卫
node test/run-all.mjs        # 分层总览：L1 契约 / L2 单元接线 / L3 端到端

# ── §4.8（知识库不增长）的三分钟自检 ──────────────────
Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"   # False = 从未运行
node "D:/MyVault/90_Agent/knowledge-organize.js" '{"limit":20}'  # 脚本本身是否可用
Get-ChildItem "D:/MyVault/30_Resources" -Recurse -Filter 'KB-*' |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-1) } | Measure-Object

# ── 断点日志 ──────────────────────────────────────────
Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-$(Get-Date -f yyyy-MM-dd).log" `
  -Pattern 'client half apply|Typert Remote|remote.obsidianBridge|remote 服务读取失败|remote 注入失败' |
  Select-Object -Last 10

# ── 后端是否真的打通（Vault 侧）───────────────────────
Select-String -Path "D:/MyVault\00_InteractionLogs\$(Get-Date -f yyyy-MM-dd)_conversation.md" `
  -Pattern '会话开始|用户 prompt|对话结束' | Measure-Object
```

---

**报告结束。**

> 本报告遵循的证据标注约定：**【已验证】** = 直接读到源码/产物的字面内容，附文件路径 + 行号；**【推断】** = 由已验证事实推导，未在运行时观测到；**【证据不足】** = 静态证据无法判定，明确标注。
> 标注「死代码」「从未 +1」等否定性结论处均附 `grep`/`Select-String` 命令，可直接复核。
> **1.0.1 同步后**，本文中所有「已移除」的标注都可用 `grep -rn 'STATUS_URL\|mountStatusRoute\|webServer' .` 一次验证（期望：`docs/` 之外零命中）。
