# Changelog

> 本文件记录 `@local/obsidian-bridge` 的**产品版本变更**。版本号规范见
> [RELEASE-1.0.md §1](RELEASE-1.0.md)；配置项见 [CONFIG.md](CONFIG.md)；故障排查见
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
>
> **本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式**（`Added` / `Changed` /
> `Fixed` / `Removed` / `Deprecated` / `Security` 六类，按需取用）。

## 目录

- [时间戳与统计口径（先读这一节）](#时间戳与统计口径先读这一节)
- [\[1.0.2\] - 2026-10-23](#102---2026-10-23)
  - [Added](#added-2) ｜ [Changed](#changed-2) ｜ [Fixed](#fixed-2) ｜ [Removed](#removed-2)
- [\[1.0.1\] - 2026-10-22](#101---2026-10-22)
  - [Added](#added-1) ｜ [Changed](#changed-1) ｜ [Fixed](#fixed-1) ｜ [Removed](#removed-1) ｜ [Known Issues](#known-issues-1)
- [\[1.0.0\] - 2026-10-21](#100---2026-10-21)
  - [Added](#added) ｜ [Changed](#changed) ｜ [Fixed](#fixed) ｜ [Removed](#removed) ｜ [Known Issues](#known-issues)
- [维护约定](#维护约定)

---

## [1.0.2] - 2026-10-23

> **本版主题：交叉评审缺陷清零 + 消除架构边界。**
> 两支交叉评审队伍（Host 半边 / 测试套件）共发现 **25 个缺陷**，本版修复 16 个，
> 并把「Client 半边 0% 覆盖」这个唯一的架构边界缺口补上。

### Added

- **A-26 `test/client-runtime.mjs`** —— Client 半边**运行时**测试。
  用 mock `window.__ModuleLoader__` + mock React 在 Node 里**真正执行** `client.js`
  （此前覆盖率 0%，Node 触不到浏览器模块）。11 条断言，覆盖 bundle 工厂、
  槽位注册、面板渲染、`{ok,value}` 解包、错误分支。
- **A-27 `test/config-consistency.mjs`** —— 配置一致性守卫（5 项）。
  把「两处独立声明必须一致」显式化：MCP server 名、脚本路径、文档 vs 实现、
  计数器声明 vs 使用。**让漂移变成测试失败，而不是用户困惑。**
- **A-28 启动自检** —— `index.js` 启动时集中打印 8 项关键前提
  （vaultPath / bridgeScript / organizeScript / 各开关 / inject.limit / hmacSecretEnv）。
  重启后一行日志即可确认配置正常。
- **A-29 `test/coverage.mjs`** —— 零依赖行覆盖率工具（用 Node 内置 `NODE_V8_COVERAGE`）。

### Changed

- **C-17 日志文件名改用本地时区** —— `bridge.js:52` 原用 `toISOString()` 取 **UTC** 日期，
  在 UTC+8 机器上「今天的日志」会写成昨天。改用本地日期后，「今天的日志」就是今天。
  （历史文件名仍是 UTC 日期，整理器不受影响 —— 游标用 `Date.parse`，文件过滤用后缀匹配。）
- **C-18 `OBSIDIAN_MCP_SERVER` 改为 export** —— 让测试能核对它与 patch 的 `serverName` 一致。
- **C-19 `scriptPath` 改为顶层静态导入** —— `await` 在非 async 函数里非法。

### Fixed

> 交叉评审发现的 14 个缺陷（D1–D14）+ 2 个测试假阳性。
> **每条都做了因果链追溯，根因可能在离报错很远的上游或下游。**

| ID | 缺陷 | 根因（追溯结果） |
|---|---|---|
| **D1** | 空 `summary:` 让笔记**静默消失** | `[] \|\| x` → `[]`（真值）→ `[].substring` 抛错 → 被 `walk()` catch 吞掉。**根因在 `parseFrontmatter`（上游），症状在索引结果（下游）** |
| **D2** | `maybeOrganize()` 三类失败零观测 | 失败上报是 `fire()` 私有能力，**没上移到 `spawn()`** |
| **D3** | HMAC 密钥未传子进程 | `cfg.hmacSecretEnv` **全仓零消费者** → 子进程静默回落**硬编码公开密钥** |
| **D4** | `source?.name` 死分支 | 键正则不允许前导空白 → 嵌套键被忽略 → `source` 恒为 `[]` |
| **D5** | 停用开关仍建索引 | 索引构建写在开关检查**之前** |
| **D6** | 空索引永不 fresh | fresh 判定含 `index.length > 0` → 空 Vault 每次全量重扫 |
| **D7** | `diagnose` 无界增长 | 无条件执行（实测 24 KB） |
| **D9** | 双层吞异常 | `.catch(() => {})` 是第二层 |
| **D10** | 过滤规则三处不一致 | 工具名拼进匹配串 / 完整序列化串 / 非对象包 `{value:...}` |
| **D11–D14** | 启动 finally / getSnapshot / refreshSnapshot / fire 的异常处理 | 各自留痕 |
| **FP-1** | `contract.mjs` 平台目录缺失时**静默变绿** | SKIP 是免费的 → 改为找不到声明即 exit 1 |
| **FN-1** | `run-all` 漏挂 `knowledge-quality.mjs` | 接入为第 9 个套件 |

### Removed

- **R-05 `thinking` 兜底类型** —— `bridge.js:630` 原把工具调用兜底写成 `thinking`，
  导致 `thinking.md` 965 条 section 中**真思考 0 条**（100% 是工具调用记录），
  进而被提炼成标题为 `Bash`/`pwsh` 的「知识条目」。
  改为独立类型 `tool-op`，**不在整理白名单内**（操作日志不产生知识条目）。

---

## [1.0.1] - 2026-10-22

## 时间戳与统计口径（先读这一节）

> ⚠️ **这一节是为避免重蹈 `1617` 那个坑而写的。** 历史上出现过三类「数字看起来不对」的事故，
> 全部源于**没写口径**：

| 事故 | 错误做法 | 正确做法 |
|---|---|---|
| 代码行数偏小 447 行 | PowerShell `Get-Content \| Measure-Object -Line` | `[System.IO.File]::ReadAllLines()`（UTF-8），或 `node` 读 UTF-8 后 `split('\n')` |
| 事件数翻倍（`post-tool` 得 2070） | `grep -c 'post-tool'`（同时命中 `triggered` 与 `completed` 两行） | 只数 `[<事件>] Hook triggered` 行 |
| 治理噪声比失真 | 直接引用半年前的快照 `1617:135` | 标注「修复前快照」，并给出当前实测值 `1033:28` |

**本文件所有数字的口径**（与 [RETROSPECTIVE.md §1.3](RETROSPECTIVE.md) 一致）：

- **代码行数**：`node` 读 UTF-8 后 `split('\n')`；等价于 `[System.IO.File]::ReadAllLines()`。**不使用**
  `Get-Content | Measure-Object -Line`——该命令在 zh-CN 环境下按 `gb2312` 解码 UTF-8，
  会吞掉部分 `0x0A` 行边界（`index.js` 真实 322 行，该口径只得 250 行）。
- **事件计数**：`D:/MyVault\00_InteractionLogs\hook-debug.log` 中形如
  `[2026-10-21T..Z] [<事件>] Hook triggered` 的行数。**只数 `triggered`，不数 `completed`。**
  该日志持续写入，因此每个数字都是**测量时点快照**，必须与时间戳同时出现。
- **Vault 规模**：`obsidian_get_stats`（MCP 实时返回）优先；本地 `*.md` 递归计数作交叉验证。
- **验收结果**：`node test/acceptance.mjs`（PRD §9，14 项）与 `node test/e2e-verify.mjs`（19 项检查），
  均需同时记录**退出码**与**运行日期**。

**锚点说明**：本文引用的 `RETROSPECTIVE.md` 小节锚点按 GitHub slug 规则生成，但 CJK 标题的锚点
**随渲染器而异**。若点击后未跳转，请在该文件内搜索 `### 4.x` 定位小节。

---

## [1.0.1] - 2026-10-22

> **PATCH 版**：缺陷修复 + 新增带默认值的配置项 + 死代码落地清理。`dsh.manifestVersion` 保持 `1`
> （清单形状未变，见 [RELEASE-1.0.md §1.2](RELEASE-1.0.md)）。
>
> **本版的重点是一个静默失败**：`maybeOrganize()` 调用了 `runner.spawn(...)`，但 `createRunner()`
> 的 return 块从未导出该方法，异常又被 `.catch(() => {})` 吞掉 —— 知识整理**从未运行过一次**，
> 且面板、日志、测试三层都看不到。详见 Fixed 的 **F-08**。

**发布实测数据**（2026-10-22，DSH Desktop 2.0.18 / Cordis 4.0.5 / Node v24.15.0 / profile `desktop`）：

| 指标 | 值 | 命令 | 口径 |
|---|---|---|---|
| 代码规模 | 48 个 JS/MJS 文件 / **12082 行** | `node scripts/check-line-counts.mjs` | UTF-8，末行换行不计 |
| ├ 插件本体 | 11 个文件 / 1751 行 | 同上 | `index.js` + `client.js` + `typert.host.js` + `lib/`×8 |
| ├ 测试 | 10 个文件 / 3669 行 | 同上 | `test/`（仅 `.js`/`.mjs`） |
| ├ 构建与守卫脚本 | 3 个文件 / 905 行 | 同上 | `scripts/` |
| └ 发布暂存副本 | 24 个文件 / 5757 行 | 同上 | `release-staging/`（脱敏副本，见 K-12） |
| PRD §9 验收 | **14/14 PASS**，退出码 0 | `node test/acceptance.mjs` | 真实 Vault + 真实 MCP 子进程 |
| 端到端验证 | **16 PASS / 0 FAIL / 3 MANUAL**，退出码 0 | `node test/e2e-verify.mjs` | 19 项检查；断言外部产物 |
| 分层测试总览 | **8 套件全部通过 / 0 失败** | `node test/run-all.mjs` | L1 契约 / L2 单元接线 / L3 端到端 |
| 接线测试 | **12/12 PASS** | `node test/wiring.mjs`（经 `run-all.mjs`） | 含 F-08 的导出表回归守卫 |
| MCP 工具 | **15 个** | `tools/list` | `mcp__obsidian-local__*` |
| Vault 规模 | **450 篇 / 355490 字** | `obsidian_get_stats` | 实时返回（含 K-11 的 291 条垃圾条目） |
| 文档行数守卫 | 9 份 / 3916 行，声明全部一致 | `node scripts/check-line-counts.mjs` | 见「维护约定」§8 |
| 文档链接守卫 | 10 份 / 87 条链接全部有效 | `node scripts/check-doc-links.mjs` | 文件级链接 |

> ⚠️ **代码规模是动态值**：`test/` 与 `scripts/` 在 1.0.1 期间持续演进，
> 本表是 **2026-10-22 19:45 的测量快照**（此后已再次变动过）。
> **权威来源永远是 `node scripts/check-line-counts.mjs` 的即时输出**，不要引用本表的数字做判断。
> 也不要手工 `Get-ChildItem` 统计（口径易错，且会漏掉 `release-staging/` 的区分）。

> **3 项 MANUAL 是什么**：`E4`（当日日志无注入块，需先发一条含知识库关键词的消息）、
> `P1` / `P2`（HTTP 状态路由需 `DSH_LAUNCH_TOKEN`）。属**设计上的待人工项**，非缺陷。

### Added

| 编号 | 条目 | 实现位置 |
|---|---|---|
| A-14 | **知识条目自动整理**：新增 `organize.{enabled,batchLimit,minIntervalMs}` 三个配置项，均带防御性默认值（`true` / `20` / `300000`） | `lib/config.js:38-45`、`:92-96`；`cordis.patch.yml` |
| A-15 | **`90_Agent/knowledge-organize.js`**（358 行）：游标（只处理新增 section）+ `contentHash` 去重 + 质量门（类型门 / 内容门 / system-prompt 泄漏门），补上旧 CLI `knowledge-engine.js organize` 缺失的三件事 | `D:/MyVault/90_Agent/knowledge-organize.js` |
| A-16 | **`maybeOrganize()` 接线**：`agent/turn-stopping` → 节流（`minIntervalMs`）→ 子进程整理 → 按退出码计数 | `index.js:445-485`（调用在 `:453`） |
| A-17 | 计数器 `organizeRuns` / `organizeFailed` | `lib/status.js:34-35` |
| A-18 | 面板「知识整理」行（有失败时附「失败 N」） | `client.js:261-267` |
| A-19 | **索引失败可观测**：快照新增 `index.ok`，计数器新增 `indexFailed` —— 区分「扫描失败」与「空 Vault」（此前都是 `size: 0`） | `index.js:198-211`、`:270`；`lib/status.js:33` |
| A-20 | **MCP 工具数真实统计** `countMcpTools()`：`ctx.tools.schemas(lastAgent)` + 按 `mcp__obsidian-local__` 前缀精确过滤。此前是写死的常量 | `index.js:241-256` |
| A-21 | `resetStore()`：清空跨 `apply()` 存活的模块级快照，修 HMR / 重新激活读到**上一个实例**快照的泄漏 | `lib/status-store.js:63-67`；`index.js:110` |
| A-22 | `COUNTER_KEYS` / `REMOVED_COUNTER_KEYS` 显式声明：计数器键集固定，不再靠 `record()` 的 `?? 0` 动态创建（此前启动 7 键、首次构建后 8 键） | `lib/status.js:25-46` |
| A-23 | 面板「最近一次事件」区：按事件名列出最后发生时间与关键上下文 | `client.js:269-282` |
| A-24 | **文档守卫脚本**：`check-line-counts.mjs`（行数口径 + 文档声明核对）、`check-doc-links.mjs`（文件级链接） | `scripts/` |
| A-25 | 测试套件扩展：`contract.mjs`、`run-all.mjs`、`audit-*.mjs`×12、`count-lines.mjs` | `test/` |

### Changed

| 编号 | 变更 | 前 → 后 |
|---|---|---|
| C-08 | `governance` 配置字段 | `everyStops: number`（**死配置**，插件侧从未读取）→ `documented: boolean`（仅用于面板展示治理配置区）。治理实际由 Vault 侧 `bridge.js` 的 `runGovernance()` 在 `stop` 时自行触发 |
| C-09 | **`enabled.prompt` 语义** | 只控制「留痕」→ **同时控制留痕、计数与注入**。此前关掉开关后面板显示「已停用」但知识仍被注入（开关欺骗用户）。现 `index.js:355` 在写留痕/计数**之前**拦截 |
| C-10 | `injections` 计数与 `entryCount` 语义 | `entryCount` 写的是配置上限 `inject.limit` → 写**实际注入条数**（`results.length`）；`injections` 明确为「产生注入的 prompt 次数」 |
| C-11 | `toolEvents` 计数口径 | 只统计「通过降噪闸门」的调用 → **每次工具调用都 +1**。降噪只影响 Vault 留痕，不影响计数（此前面板数字偏小是**双重降噪**造成的） |
| C-12 | `tools/result` 处理器签名 | `({ exec })` 解构（**恒为 undefined** → 整个处理器静默失效）→ 位置参数 `(exec, result)` + 防御性归一（兼容对象载荷）。证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502`、`dsh-tools/lib/types/index.js:1079`、`cordis/lib/index.js:281` |
| C-13 | `post-tool` 关键词判定 | 把工具名拼进匹配串、用完整序列化串 → 与 `bridge.js:618-627` 对齐：**只看 `tool_input`**、先 `substring(0, 300)` 截断。此前「工具名含 `note` 但输入不含关键词」的事件在两边判定相反 |
| C-14 | `buildVaultIndex` 返回形状 | `Entry[]` → `{ entries, ok, failedRoots }`。`ok=false` 表示一个根目录都没扫到（配置或权限问题） |
| C-15 | 索引失效与重建 | `invalidateIndex()` 只清 `index` / `indexBuiltAt`（扫描中调 `refresh()` 会返回在飞 Promise，**重建变空操作**）→ 同时清 `indexPromise`；`rebuildIndex()` 补调 `snapshot()`（否则 `refresh()` 返回的快照 `index.size` 是旧值，与已 +1 的 `indexBuilt` 自相矛盾） |
| C-16 | 面板计数区 | 5 项 → 8 项（+ 索引构建次数 / 索引构建失败 / 写入失败 / 知识整理）；事件开关 4 项 → 5 项（+ 知识注入） |

### Fixed

| 编号 | 一行摘要 | 根因与证据 |
|---|---|---|
| **F-08** | **`runner.spawn` 未导出 → 知识整理静默从未运行（本版最严重）** —— `index.js:472` 调用 `runner.spawn(...)`，但 `lib/writer.js` 的 `return` 块只导出 `bridge` / `memorySync`；调用抛 `TypeError: runner.spawn is not a function`，被 `index.js:484` 的 `.catch(() => {})` 吞掉。**三层都不可见**：日志无输出、`organizeRuns` 恒 0、测试未覆盖。实证：游标文件 `90_Agent/knowledge-organize-cursor.json` **始终不存在**，即该脚本从未被插件调用过 | 修法：`lib/writer.js:140-154` 的 return 块补 `spawn(args, stdinData)`。回归守卫：`test/wiring.mjs:246-263` 第 12 项**直接核对 `createRunner()` 的导出表**（`bridge` / `memorySync` / `spawn`） |
| **F-09** | **`writeFailures` 只计数不打日志** —— 四条失败分支里只有 `exit-N` 写了 warn，另三条（`spawn-unavailable` / `spawn-error` / `spawn-throw`）日志零输出 | 修法：抽 `reportFailure(reason, detail, args)`，**四条分支统一走它**（计数 + warn），`lib/writer.js:84-124` |
| **F-10** | **索引失败伪装成空 Vault** —— `buildVaultIndex` 吞掉扫描异常返回 `[]`，`ensureIndex` 照样记 `indexBuilt {size: 0}`，面板把「扫描失败」显示成「空 Vault」 | 修法：`ok=false` 时记 `indexFailed` 且**不**设 `indexBuiltAt`（快照 `index.ok: false`），`index.js:198-211`、`client.js:204-206` |
| **F-11** | **HMR 快照跨实例泄漏** —— `status-store` 的模块级变量跨 `apply()` 存活，重新激活时新实例在首次 `touch()` 前读到**上一个实例**的快照（实测泄漏 `sessionStarts: 1`） | 修法：`resetStore()` 在 `apply()` 开头调用，`lib/status-store.js:63-67`、`index.js:110` |
| **F-12** | **`decision.messages` 缺失会中断整个回合** —— `agent/pre-step` 是 waterfall 且**无异常兜底**；其他监听者返回的决策形状不受本插件控制，直接取 `messages[len-1]` 可能抛错 | 修法：`Array.isArray` + 长度 + 末元素三重防御，`index.js:312-317` |
| **F-13** | **`touch()` 位置错误使面板停在旧值** —— 原放在 `if (injectedText)` 内，「留痕了但没注入」时快照不刷新，面板的 `index.size` / `builtAt` / `mcpTools` 停在旧值 | 修法：`touch()` 移到条件之外，`index.js:360-363` |
| **K-06** | `governanceRuns` 计数器从未自增（死字段） | 已从 `COUNTER_KEYS` 移除，并记入 `REMOVED_COUNTER_KEYS` 保留可检索性（`lib/status.js:38-46`）；配套的 `cfg.governance.everyStops` 一并移除（C-08） |
| **K-07** | `route-mount` / `status-hit` 是死埋点，无法判断 HTTP 路由注册状态 | HTTP 状态路由整体移除（见 Removed），埋点问题随之消失 |
| **K-08** | `desktopDeselectedBundles` 让管理页显示与实际状态矛盾 | 已从 profile 的 `desktopDeselectedBundles` 移除本插件；实测现为 `["@perrylink/dsh-github"]`，不含本插件 |
| **K-02** | `post-tool` 计数只统计项目/记忆相关调用（标签易误解） | 计数与留痕解耦（C-11），面板「工具调用事件」现为全量计数，K-02 关闭 |

### Removed

| 编号 | 移除项 | 因果查询结论 | 影响 |
|---|---|---|---|
| **R-04** | `client.js` 的 `STATUS_URL`、`index.js` 的 `STATUS_ROUTE` + `mountStatusRoute()`、`inject` 中的 `webServer` | 与 1.0.0 段 R-01/R-02/R-03 的判定一致；**本次为代码侧实际落地** | 面板不受影响（走 Typert Remote）；插件少一个硬依赖 |

> **R-04 与 R-01..R-03 的关系**：1.0.0 的 Removed 段已记录这三项的**判定结论**，但代码侧移除在 1.0.1 才真正落地
> （2026-10-21 复核时 `client.js:19`、`index.js:183-207` 仍在）。此处只作落地确认，不重复展开理由。
> **教训：Changelog 的 Removed 段必须在代码合并后写，否则会出现「文档说删了、代码还在」的错配。**

### Known Issues

> 完整描述见 [RELEASE-1.0.md §6](RELEASE-1.0.md)。K-02 / K-06 / K-07 / K-08 已在本版修复，移入上方 Fixed。

| 编号 | 一句话 | 计划修复 |
|---|---|---|
| K-01 | 面板需手动打开设置页才刷新（轮询只在组件挂载期间运行） | 1.1.0 |
| K-03 | HTTP 状态路由需启动令牌，脚本请求一律 403 —— **路由已移除**，本条改为「外部监控通道已取消，如需请走 Typert Remote 或直读 Vault」 | 1.2.0 |
| K-04 | HMR 对 junction bundle 不生效，改代码必须重启 DSH | 不计划修复（平台限制） |
| K-05 | 治理 `flagged: 0` 从未触发实际动作（阈值逻辑在 Vault 侧，缺「应当触发」样本） | 1.2.0 |
| K-09 | `typert.host.js` 的 `input` / `invoke` 永不被调用（下游无消费者） | 1.1.0 |
| K-10 | `jsonCodec` 的 `create()` 返回空对象，类型投影为空 | 1.1.0 |
| **K-11** | **Vault 侧遗留 291 条垃圾知识条目**（`30_Resources/experience/`，旧 CLI 无去重地重复生成，标题为乱码） | 1.1.0（提供清理脚本） |
| **K-12** | **`release-staging/` 是插件本体的脱敏副本**（仅 `DEFAULT_VAULT_PATH` 不同：`D:/MyVault` vs `D:/MyVault`），存在双份代码漂移风险 | 1.1.0（改为构建期生成） |

---

## [1.0.0] - 2026-10-21

> 首个正式发布版。形态为**单 bundle + 双半边**：Host（`index.js`，注册四个 Cordis 事件处理器，
> 写操作经 `ctx.subprocess`）+ Client（`client.js`，在 DSH 设置页追加「Obsidian 桥接」面板，
> 经 Typert Remote 取数）。

**发布实测数据**（2026-10-21，DSH Desktop 2.0.18 / Cordis 4.0.5 / Node v24.15.0 / profile `desktop`）：

| 指标 | 值 | 命令 | 口径 |
|---|---|---|---|
| 代码规模 | 18 个 JS/MJS 文件 / **2643 行** | `node` 统计 | UTF-8 `split('\n')` |
| PRD §9 验收 | **14/14 PASS**，退出码 0 | `node test/acceptance.mjs` | 真实 Vault + 真实 MCP 子进程 |
| 端到端验证 | **17 PASS / 0 FAIL / 2 MANUAL**，退出码 0 | `node test/e2e-verify.mjs` | 断言外部产物 |
| MCP 工具 | **15 个** | `tools/list` | `mcp__obsidian-local__*` |
| Vault 规模 | 147 篇 / 282525 字 | `obsidian_get_stats` | 实时返回 |

> ⚠️ **上表是 1.0.0 发布时点的快照，不是当前值。** 当前值见 [1.0.1 段](#101---2026-10-22)顶部。
> 差异来源：① 代码规模 —— `test/` 与 `scripts/` 在 1.0.1 大幅扩展（18 → 57 文件），
> 且新增了 `release-staging/` 脱敏副本；② 端到端验证 —— 检查项从 19 项中的 2 项 MANUAL 变为 3 项
> （`E4` 在当次运行恰好无注入块）；③ Vault 规模 —— Vault 持续增长，且 1.0.1 期间旧 CLI 重复生成了
> 291 条垃圾知识条目（见 K-11）。**历史快照保留不改，以体现版本演进。**

### Added

| 编号 | 条目 | 实现位置 |
|---|---|---|
| A-01 | 四类事件自动留痕：`agent/created`→`session-start`、`agent/pre-step`→`user-prompt`、`tools/result`→`post-tool`、`agent/turn-stopping`→`stop` | `index.js:213-318` |
| A-02 | 知识库自动检索注入：关键词（前 5 个）→ 内存索引检索 → 注入 `runtime-context` 用户消息 | `lib/query.js:19-34`、`index.js:249-274` |
| A-03 | Vault 内存索引：扫描 4 个根目录，5 分钟 TTL，单文件 256 KiB / 深度 8 / 条目 5000 上限 | `lib/config.js:41`、`lib/vault-index.js:5-9`、`index.js:34` |
| A-04 | 置信度算法：关键词 +0.5、标签 +0.3、标题 +0.1、摘要 +0.1，上限 1.0 | `lib/query.js:85-91` |
| A-05 | Typert 状态面板：`settings.section` 槽位（`order: 90`），5 秒轮询，展示路径/索引/工具数/四开关/五计数 | `client.js:19-20,278-286` |
| A-06 | Typert 服务：`obsidianBridge.status` / `.refresh` 两个 invocation | `lib/bridge-service.js:24,39-53`、`typert.host.js:34-62` |
| A-07 | ~~HTTP 状态路由（备用通道）：`GET /obsidian-bridge/status`，命中写 `status-hit`~~ **发布前已移除**，见 Removed | ~~`index.js:36,183-207`~~ |
| A-08 | MCP 桥接：复用 `obsidian-mcp-bridge`，经 stdio 注册 15 个 `mcp__obsidian-local__*` 工具 | `cordis.patch.yml:19-29` |
| A-09 | 六项可配置项，均带防御性默认值 | `lib/config.js:9-36,51-74` |
| A-10 | 注入消息递归 `deepFreeze`，形状对齐 `createUserMessage`，`source.kind: 'runtime-context'` | `lib/message.js:10-41` |
| A-11 | 子代理过滤：`header.origin === 'subagent'` 或 `delegationDepth > 0` 不参与留痕与治理 | `lib/message.js:74-78` |
| A-12 | 对 Vault 既有资产的 10 项修复（见 Fixed 表末） | `90_Agent/*` |
| A-13 | 三层验证套件：`acceptance.mjs`（真实 Vault + 真实 MCP 子进程）、`e2e-verify.mjs`（断言外部产物）、`wiring.mjs` + `status-refresh.mjs`（mock 调试） | `test/` |

### Changed

| 编号 | 变更 | 前 → 后 |
|---|---|---|
| C-01 | 写操作通道 | 直写 `D:/MyVault`（被 fs-sandbox 围栏拒绝）→ 一律经 `ctx.subprocess` 交给 Vault 脚本（`lib/writer.js`） |
| C-02 | 事件来源 | WorkBuddy Hook（`UserPromptSubmit` 等）→ DSH Cordis 事件（`agent/pre-step` 等） |
| C-03 | Client 取数通道 | HTTP `GET /obsidian-bridge/status` → Typert Remote（Client 半边无 `fetch`，见 F-06） |
| C-04 | 注入消息来源标记 | 与普通用户消息同形 → `source.kind: 'runtime-context'` + `form: 'snapshot'` |
| C-05 | `post-tool` 留痕条件 | 每次 `tools/result` 无条件留痕（实测 1600+ 条 `工具:  输入: {}` 噪声）→ 先滤空参数，再按项目/记忆关键词过滤（`index.js:286-312`） |
| C-06 | 读写通道分离 | 读走 `ctx.fs`（sandbox 放行读），写走 `ctx.subprocess`（`lib/vault-index.js:106-126`） |
| C-07 | `writeFailures` 计数 | 定义但从未 `+1`（写入失败静默）→ 接入 `lib/writer.js` 四条失败分支（`spawn-unavailable` / `exit-N` / `spawn-error` / `spawn-throw`） |

### Removed

> 发布前的因果查询清理。判定标准：**代码内 0 个消费者 + 唯一潜在消费者不具备该能力**。

| 编号 | 移除项 | 因果查询结论 | 影响 |
|---|---|---|---|
| R-01 | `client.js` 的 `STATUS_URL` | 定义后 **0 处引用** | 无（纯死代码） |
| R-02 | `index.js` 的 `STATUS_ROUTE` + `mountStatusRoute()` | 代码内 0 消费者；Client 半边无 `fetch`；外部 curl 被启动令牌围栏挡在 403（`dsh-client-connection/lib/index.js:742-743`）；累计 `status-hit` 仅 1 次（自测） | 面板不受影响（走 Typert Remote） |
| R-03 | `inject` 中的 `webServer` | 随 R-02 一并失效；移除后插件少一个硬依赖 | 无（R-02 后无人使用） |

**回归**：移除后 `acceptance.mjs` 14/14、`e2e-verify.mjs` 17/0 全绿；`test/wiring.mjs` 第 10 项改为**锁定「移除是有意的」**，防止后续误加回。

### Fixed

#### 本版的 7 个真实修复

> 每条一行摘要 + 指向 `RETROSPECTIVE.md` 的章节锚点。**不在此重复根因分析**——完整证据链见链接。

| 编号 | 一行摘要 | 根因与证据 |
|---|---|---|
| **F-01** | **Host 清单 `service` 悬空** —— 清单声明了服务名，但 Cordis 上下文里没有对应 Service，网关 strict 分发抛 `gateway/service-unavailable`。修法：新增 `ObsidianBridgeService extends TypertRemoteService` 并 `ctx.plugin()` 挂载 | [RETROSPECTIVE.md §4.1](RETROSPECTIVE.md#41-坑-1host-清单-service-悬空)（搜 `### 4.1`） |
| **F-02** | **Client 直读 `ctx.remote.<ns>`** —— 点号转发只在 `props` 已声明时生效，未声明时**静默返回 `undefined`**。修法：改用官方入口 `ctx.inject(['remote.obsidianBridge'], cb)` | [RETROSPECTIVE.md §4.2](RETROSPECTIVE.md#42-坑-2client-直读-ctxremotens-静默返回-undefined)（搜 `### 4.2`） |
| **F-03** | **`ctx.effect(fiber)` 误用** —— `ctx.inject` 返回的是 fiber wrapper 而非函数，传给 `ctx.effect` 触发 `e.execute.call is not a function`，且 disposer 从未注册。修法：`ctx.effect(() => follow.dispose())` | [RETROSPECTIVE.md §4.3](RETROSPECTIVE.md#43-坑-3ctxeffectfiber-误用)（搜 `### 4.3`） |
| **F-04** | **漏解包 `{ok, value}`** —— Remote 方法返回包装对象，直接用导致面板渲染 `undefined`。修法：新增 `unwrap(result, method)` | [RETROSPECTIVE.md §4.4](RETROSPECTIVE.md#44-坑-4漏解包-ok-value)（搜 `### 4.4`） |
| **F-05** | **注入 `harness` 致插件永久 pending** —— `harness` 只存在于动态包沙箱上下文，静态 bundle 插件注入它会让 fiber 永远停在 PENDING。修法：移除，Host 调用改走 Typert Remote | [RETROSPECTIVE.md §4.5](RETROSPECTIVE.md#45-坑-5注入-harness-导致插件永久-pending)（搜 `### 4.5`） |
| **F-06** | **Client 半边无 `fetch`** —— HTTP 状态路由对面板是**不可达通道**（network belongs to the HOST half）。修法：Client 取数改走 Typert Remote，HTTP 路由降级为外部监控备用 | [RETROSPECTIVE.md §4.6](RETROSPECTIVE.md#46-坑-6client-半边无-fetch--http-状态路由是死路)（搜 `### 4.6`） |
| **F-07** | **测试假阳性** —— `wiring.mjs` / `status-refresh.mjs` 把被测层（`ctx.subprocess.spawn`）mock 掉，断言的是「构造了 spawn 请求」而非「字节写进 Vault」，导致 14/14 PASS 与「面板取不到数据」同时成立。修法：新增 `e2e-verify.mjs`，判据全部改为外部可观察产物 | [RETROSPECTIVE.md §4.7](RETROSPECTIVE.md#47-坑-7测试假阳性--1414-pass-与面板取不到数据同时成立)（搜 `### 4.7`） |

#### 对 Vault 既有资产的 10 项修复（A-12 展开）

| 文件 | 问题 → 修复 |
|---|---|
| `obsidian-mcp-bridge/src/server.js` | 响应缺 `jsonrpc:"2.0"` → `SdkError: Request timed out` ⇒ 补字段 |
| `90_Agent/hooks/bridge.js` | `logInteraction` 把嵌套对象写成 `[object Object]` ⇒ 改用 `frontmatterYaml` |
| `90_Agent/hooks/bridge.js` | frontmatter 解析不支持缩进嵌套 ⇒ 重写为缩进感知 |
| `90_Agent/hooks/bridge.js` | 交互日志缺知识条目字段（PRD Q4，schema 校验恒 false）⇒ 补全 9 个必需字段 |
| `90_Agent/hooks/bridge.js` | 治理只解析第一个 frontmatter 块 ⇒ 遍历全部块 |
| `90_Agent/hooks/bridge.js` | `knowledge` 命令提前 `return` 跳过输出 ⇒ 修正控制流 |
| `90_Agent/hooks/bridge.js` | HMAC 密钥硬编码（PRD Q5）⇒ 读 `OBSIDIAN_BRIDGE_HMAC_SECRET` |
| `90_Agent/auto-bridge.js` | `tags:/n` 语法错误（PRD §10.2）⇒ 修正 |
| `90_Agent/memory-sync/sync-workbuddy-memory.js` | 工作区记忆目录硬编码（PRD §10.2）⇒ 支持 `--workspace-memory-dir` / 环境变量 |
| `90_Agent/knowledge-engine.js` | 类型正则 `\w+` 不匹配 `project-op`/`memory-op`，`organize` 静默跳过 ⇒ 改为 `[\w-]+` |
| `90_Agent/knowledge-engine.js` | `body` 取 `slice(3)` 丢掉正文首行、标题全是乱码 ⇒ 改为 `slice(2)` |

### Known Issues

> 1.0.0 发布时**必须带上**的限制，完整描述（现象 / 影响范围 / 临时绕过 / 计划修复版本）见
> [RELEASE-1.0.md §6](RELEASE-1.0.md)。此处只列编号与一句话。

| 编号 | 一句话 | 计划修复 |
|---|---|---|
| K-01 | 面板需手动打开设置页才刷新（轮询只在组件挂载期间运行） | 1.1.0 |
| K-02 | `post-tool` 计数只统计项目/记忆相关调用（刻意降噪，但标签易误解） | 1.1.0 |
| K-03 | HTTP 状态路由需启动令牌；脚本请求一律 403，无法区分 200/404 | 1.2.0 |
| K-04 | HMR 对 junction bundle 不生效，改代码必须重启 DSH | 不计划修复（平台限制） |
| K-05 | 治理 `flagged: 0` 从未触发实际动作（阈值逻辑在 Vault 侧，缺「应当触发」样本） | 1.2.0 |
| K-06 | `governanceRuns` 计数器从未自增（死字段） | 1.0.1 |
| K-07 | `route-mount` / `status-hit` 是死埋点，无法判断 HTTP 路由注册状态 | 1.0.1 |
| K-08 | `desktopDeselectedBundles` 让管理页显示与实际状态矛盾 | 1.0.1 |
| K-09 | `typert.host.js` 的 `input`/`invoke` 永不被调用（下游无消费者） | 1.1.0 |
| K-10 | `jsonCodec` 的 `create()` 返回空对象，类型投影为空 | 1.1.0 |

---

## 维护约定

1. **新增版本时**，在**最新版本段之上**插入新的 `## [x.y.z] - YYYY-MM-DD` 段，并同步更新该段顶部的「发布实测数据」表。
2. **每条变更必须可溯源**：带上实现位置（`文件:行号`）或证据文件；无法溯源的条目不得写入。
3. **数字必须带口径与时间戳**：遵循本文「时间戳与统计口径」一节；**禁止**直接粘贴
   `Get-Content | Measure-Object -Line` 的结果。
4. **修复条目必须保留编号**（F-xx）并链接到根因分析所在文档，**不在本文件重复根因**。
5. **已知问题**用 `K-xx` 编号并给出计划修复版本；已修的问题从 `Known Issues` 移入对应版本的 `Fixed`。
   **编号只增不复用**——即使某条已修，其编号也不得回收给新问题（否则外部引用会指向错误条目）。
6. **破坏性变更**走 `Changed` 段并显式标注「⚠️ 破坏性」；版本号按 SemVer 升 MAJOR。
7. **前向引用**：本文件引用的 `docs/*.md` 必须已存在；新建文档后回来补链接。
8. **提交前跑两个守卫**（`scripts/` 下，均为只读）：
   ```bash
   node scripts/check-line-counts.mjs   # 行数口径 + 文档里的「（NNN 行）」声明核对
   node scripts/check-doc-links.mjs     # docs/ 与仓库根的文件级链接是否都存在
   ```
   `check-line-counts.mjs` 只认**括号声明形式** `（NNN 行）`，且只检查 `docs/*.md`。两条都必须退出码 0。

---

**上一版**：1.0.0（首个正式发布版）。
**下一版计划**：1.1.0（K-01 / K-09 / K-10 / K-11 / K-12）→ 1.2.0（K-03 / K-05）；K-04 为平台限制，仅文档说明。
