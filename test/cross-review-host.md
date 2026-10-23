# obsidian-bridge Host 半边 —— 逐行覆盖交叉评审

评审人：frontend-client（只读评审，**未修改任何插件源码**）
日期：2026-10-22
评审对象：`index.js`(489) / `lib/writer.js`(154) / `lib/status-store.js`(72) / `lib/vault-index.js`(146)
（附带核对了 `lib/bridge-service.js`、`lib/config.js`、`lib/status.js`、`lib/message.js`、`lib/query.js`，因为它们是上述四个文件的直接上下游）

---

## 0. 评审方法与知识库使用情况

### 0.1 动手前先读知识库（已完成）

| 来源 | 用途 | 对本次评审的直接作用 |
|---|---|---|
| `D:/MyVault/10_Projects/<项目目录>/<最佳实践文档>.md` | 8 条避坑 + 四阶段排查法 + 证据强度表 | 直接给出本次要查的两类目标：**静默失败**（坑 2/4/8）与**产物断言**（§三 坑 8） |
| `D:/MyVault/10_Projects/<项目目录>/<开发复盘文档>.md` | 8 个真实坑的根因链 | 坑 8 的「三层不可见」模型（日志无输出 / 计数恒 0 / 测试全绿）被用作本次的**检查清单** |
| `obsidian-bridge/docs/BEST-PRACTICES.md`、`docs/TROUBLESHOOTING.md` | 仓库版最佳实践 | 与 KB 一致，未引入新约束 |
| `obsidian-bridge/docs/CONFIG.md`、`docs/CHANGELOG.md` | 配置语义 | 用于判定 `hmacSecretEnv` / `governance.documented` 是否为死配置 |

### 0.2 交叉验证来源（三方独立取证，避免单点误判）

| 来源 | 内容 | 与本次评审的关系 |
|---|---|---|
| `test/evidence/backend-findings.md`（backend-typert） | Typert 清单字段要求、网关 strict 分发路径、`execute.call` 归属 | **已交叉验证**：其 §1.2 的字段表与我在 `dsh-typert-registry/lib/client.browser.js:583-636` 独立读到的完全一致；其 §2.1 的 `execute.call` 结论与我在 §5 独立得出的一致 |
| `test/evidence/lead-findings.md`（lead） | Client↔Host 四层通道排查 | **已交叉验证**：其「Client 无 fetch / host.call 不可用 / harness 永久 pending」三项在 DSH 源码中成立 |
| `test/evidence/frontend-findings.md`（本人上一轮） | Client 取数链路 | 本次 Host 评审的**下游契约来源**（面板渲染需要哪些字段） |
| `<DSH_APP_DIR>\` 源码 | Cordis / gateway / typert / subprocess | 全部结论的第一手依据 |

### 0.3 运行时证据（最强一级）

- `<USER_HOME>\AppData\Roaming\DSH Desktop\logs\dsh-2026-10-22.log`（127 KB，最后写入 2026-10-22 21:00:04）
  - `面板首次取数成功，vaultPath=D:/MyVault` —— 最近一次 `2026-10-22T13:00:04Z`（= 本地 21:00）
  - 结论：**面板取数链路当前是通的**，Host 侧服务已挂载、快照已返回真实 `vaultPath`
- `D:/MyVault/00_InteractionLogs/hook-debug.log`（308 KB，最后写入 21:03:42）
- `D:/MyVault/90_Agent/knowledge-organize-cursor.json`（7.4 KB，最后写入 20:29:47）→ **存在**，知识整理确实在跑
- `D:/MyVault/90_Agent/bridge-diagnostics.jsonl`（24 KB，最后写入 21:01:44）→ `diagnose` 事件在持续写入

> ⚠️ **口径提醒**（KB 已踩过的坑）：本次所有行数/时间均取自 `read` 工具与 `node` UTF-8 读取，**未使用 PowerShell 的 `Get-Content | Measure-Object`**（该组合在中文 UTF-8 文件上会误报，见 `<开发复盘文档>.md:59-70`）。

---

## 1. 逐函数覆盖视图

图例：✅ 已覆盖（有测试或有运行时产物证据）｜🟡 部分覆盖｜❌ 未覆盖｜☠ 静默失败风险

### 1.1 `index.js`

#### `lastAssistantText(session)` — `:55-90`

| 项 | 内容 |
|---|---|
| **输入契约** | `session`：需有 `seq`(number)、`eventAt(seq)`、`deriveMessages()` 三个成员；任一缺失应退化而不抛 |
| **输出契约** | `string`（可为 `''`） |
| **分支** | ① 第一档循环命中 `assistant/message` 且 `messageText` 非空 → 返回；② 循环遇 `turn/start` → break；③ `eventAt` 返回 falsy → continue；④ 第一档异常 → 落第二档；⑤ 第二档 `deriveMessages()` 非数组 → 跳过；⑥ 第二档命中 → 返回；⑦ 两档皆空 → `''` |
| **覆盖** | ❌ **0 个测试命中**（`grep lastAssistantText test/*.mjs` → 0）。🟡 运行时通过 `stop` 事件的 `response` 字段间接执行（`hook-debug.log` 有 stop 记录），但**无断言** |
| **静默失败** | ☠ `:72` `catch {}`、`:86` `catch {}` —— 两档都吞异常，最终返回 `''`。**后果**：`agent/turn-stopping` 的 `response` 变成空串，Vault 里 stop 小节没有摘要，而**计数 `stops` 仍 +1**（`:448`）——「有计数、无产物」的典型静默失败 |
| **边界风险** | `:60` `Number(session.seq) - 1`：`session.seq` 为 `undefined` → `NaN` → `NaN >= 0` 为 false → 循环体不执行（**不抛**，安全，但第一档被完全跳过） |

#### `apply(ctx, config)` — `:103-489`

**输入契约**：`ctx` 需含 `on` / `get` / `logger` / `plugin`；`config` 可空（`resolveConfig` 有防御回退）。
**输出契约**：无返回值；副作用 = 注册 4 个事件处理器 + 挂载 Typert 服务 + 启动时构建索引。

| 子块 | 行号 | 覆盖 | 静默失败 |
|---|---|---|---|
| `resetStore()` | `:110` | ✅ `test/run.mjs`、`audit-counters.mjs` | — |
| `createRunner(..., onWriteFailure)` | `:113-115` | ✅ `wiring.mjs:257` | — |
| `mountBridgeService(ctx)` | `:121-125` | 🟡 运行时成功（面板取到真数据） | ☠ **双层吞异常**，见 D9 |
| `invalidateIndex()` | `:151-155` | ✅ `audit-flow.mjs` | — |
| `rebuildIndex(signal)` | `:165-171` | ✅ `audit-counters.mjs:593` | — |
| `ensureIndex(signal)` | `:189-217` | 🟡 `run.mjs:173`、`audit-flow.mjs:508` | ☠ `:207-211` catch 吞错（**有** `indexFailed` 计数，属有意设计）；☠ `:198-201` `ok:false` 分支**不更新 `indexBuiltAt`**（设计如此，但意味着失败后每次调用都重扫） |
| `countMcpTools()` | `:241-256` | 🟡 `audit-counters.mjs:570`（仅 1 处） | ☠ `:253` `catch {}` → 返回 `null` → 面板显示「未知」。**无计数、无日志** |
| `snapshot()` | `:262-277` | ✅ 多处 | — |
| `touch()` | `:286-288` | ✅ | — |
| `agent/created` 处理器 | `:291-299` | 🟡 运行时（`sessionStarts` 有值） | — |
| `agent/pre-step` 处理器 | `:302-375` | 🟡 运行时（`prompts`/`injections` 有值） | ☠ `:347-349` catch 吞检索异常（**有意**，跳过注入但仍留痕）；☠ `diagnose` 不受开关控制，见 D7 |
| `tools/result` 处理器 | `:397-444` | 🟡 运行时（`toolEvents` 有值） | ☠ `:432` `JSON.stringify` 无 try/catch；☠ 计数先于校验，见 D8 |
| `agent/turn-stopping` 处理器 | `:445-454` | 🟡 运行时（`stops` 有值） | — |
| `maybeOrganize()` | `:463-485` | ✅ 游标文件存在 | ☠☠ **三类失败零观测**，见 D2（本次最高优先级发现） |
| 启动构建 | `:488` | ✅ | 🟡 见 D11 |

#### `countMcpTools()` 补充 — `:241-256`

- **输入契约**：`ctx.get('tools')` 需返回带 `schemas(scope)` 的服务；`lastAgent` 可为 `null`。
- **输出契约**：`number`（含 0）或 `null`。
- **未覆盖分支**：❌ `tools.schemas` 存在但**返回非数组**（`:247`）→ 无测试；❌ `lastAgent` 为 `null` 时 `schemas(undefined)` 的行为 → 无测试。
- **静默失败**：☠ `:253` `catch {}` 返回 `null` —— 与 `:244` 的 `return null` **不可区分**（「无法枚举」与「枚举抛错」在面板上都显示「未知」）。这正是 KB 坑 8 的「0 次与从未运行不可区分」同型问题。
- **测试空白**：`OBSIDIAN_MCP_SERVER`（`:48`）硬编码 `'obsidian-local'`，而 `cordis.patch.yml:31` 的 `serverName: obsidian-local` 是**另一处独立声明**。二者若漂移，`countMcpTools` 会**静默返回 0**，面板显示「obsidian-local（未加载）」而非报错。**当前无任何测试断言两者一致**（`grep -n "obsidian-local" test/*.mjs` 无命中）。

### 1.2 `lib/writer.js`

#### `createRunner(ctx, cfg, onWriteFailure)` — `:20-154`

| 子函数 | 行号 | 输入契约 | 输出契约 | 覆盖 | 静默失败 |
|---|---|---|---|---|---|
| `resolveNode()` | `:25-40` | `cfg.nodePath` 可空 | 绝对路径或 `null` | ❌ 无直接测试 | ☠ `:29`/`:34`/`:38` 三处 `catch` 全部返回 `null` —— **调用方若不检查就静默无操作** |
| `spawn(args, stdinData)` | `:48-67` | `args: string[]`，`stdinData: string` | `Promise<handle \| null>` | 🟡 `wiring.mjs:257` 只断言导出 | ☠ `:50` `if (!executable) return null`；☠ `:64-66` `catch` → `null`。**两条路径都不计数、不日志**（`fire()` 会补报，但 `maybeOrganize()` 不会 → D2） |
| `reportFailure(reason, detail, args)` | `:84-93` | — | `void` | ✅ `audit-counters.mjs:408-416` | — |
| `fire(args, stdinData)` | `:100-124` | — | `void` | ✅ `audit-counters.mjs:408-416`（四个分支中的三个） | 🟡 `:108` `void handle.done.then(...)` 的 `onFulfilled` 抛错会成为 unhandled rejection（见 D14） |
| `bridge(event, payload)` | `:131-133` | `payload` 可 `undefined` | `void` | ✅ | — |
| `memorySync()` | `:135-137` | — | `void` | 🟡 运行时（`sessionStarts` 有值） | — |
| `spawn(args, stdinData)`（导出） | `:150-152` | — | 同内部 `spawn` | ✅ `wiring.mjs:258` 断言导出 | — |

**关键契约**：`fire()` 是「上报完整」的路径，`spawn()` 是「上报不完整」的路径。二者**只差一个调用方**。`index.js` 的四个事件处理器全部走 `fire()`（经 `bridge()`/`memorySync()`），只有 `maybeOrganize()` 走 `spawn()`。**这是 D2 的结构性根因。**

### 1.3 `lib/status-store.js`

| 函数 | 行号 | 输入契约 | 输出契约 | 覆盖 | 静默失败 |
|---|---|---|---|---|---|
| `setSnapshot(value)` | `:22-24` | 任意可 JSON 序列化值 | `void` | ✅ `status-refresh.mjs:100` | — |
| `getSnapshot()` | `:31-41` | 无 | 快照或 `null` | ✅ 30 处命中 | ☠ `:36` `catch {}` —— `snapshotBuilder` 抛错时**静默保持 `null`**，见 D12 |
| `setRefreshHook(fn)` | `:43-45` | 函数或空 | `void` | ✅ | — |
| `setSnapshotBuilder(fn)` | `:51-53` | 函数或空 | `void` | ✅ | — |
| `resetStore()` | `:63-67` | 无 | `void` | ✅ | — |
| `refreshSnapshot()` | `:69-72` | 无 | `Promise<快照 \| null>` | ✅ 13 处命中 | ☠ `:70` `if (refreshHook) await refreshHook()` —— **若 `refreshHook` 抛错，`refreshSnapshot` 直接 reject**，且 `getSnapshot()` 不会被调用。`typert.host.js:60` 的 `invoke` 与 `bridge-service.js:51` 的 `refresh()` 都调它 → 见 D13 |

**注意**：`getSnapshot()` 的 `:32` `if (snapshotValue !== null) return snapshotValue;` —— 若 `setSnapshot(null)` 被调用过，会反复走 builder 分支。当前 `index.js:275` 传入的总是对象，**但该不变量无任何测试保护**。

### 1.4 `lib/vault-index.js`

#### `parseFrontmatter(content)` — `:19-39`

| 项 | 内容 |
|---|---|
| **输入契约** | `string`（文件全文） |
| **输出契约** | `{ data: Record<string, string \| string[]>, body: string }` |
| **分支** | ① 无 `---` 头 → `{data:{}, body:全文}`；② `key: value`；③ `key:`（空值）→ `[]`；④ 缩进 `- item` 列表项；⑤ 既非列表项也非 `key:` → 忽略 |
| **覆盖** | ✅ `run.mjs:19,93,97`、`knowledge-quality.mjs:119` |
| **静默失败** | ☠ `:31` 的正则 `/^(\w[\w-]*):/` **不匹配 CJK 键** → 整行被忽略（实测 `标题: T` → `data={}`） |
| **与 bridge.js 的一致性** | ❌ **实测不一致**，见 D4 |

#### `parseEntry(content, displayPath)` — `:47-61`

| 项 | 内容 |
|---|---|
| **输入契约** | `content: string`，`displayPath: string`（**不应为 `undefined`**） |
| **输出契约** | 索引条目对象 |
| **覆盖** | 🟡 `knowledge-quality.mjs:119,178` |
| **静默失败** | ☠☠ `:52` `(data.summary \|\| body.substring(0,150)).substring(0,200)` —— `data.summary` 为 `[]`（空值 frontmatter）时 `[].substring` 抛 TypeError，**被 `walk()` 的 `:89` catch 吞掉 → 笔记静默移出索引**，见 D1（**已实测复现**） |
| 其他 | ☠ `:51` `path.basename(displayPath, '.md')` 在 `displayPath === undefined` 时抛 TypeError → 同上静默丢弃（`:89` catch），见 D13 |
| 其他 | 🟡 `:57` `data.source?.name` —— **永远为 `undefined`**，因为 `parseFrontmatter` 不支持嵌套对象（D4） |

#### `walk(ctx, dirTarget, index, signal, depth)` — `:71-94`（模块私有）

| 项 | 内容 |
|---|---|
| **输入契约** | `dirTarget` 已解析；`index` 累积数组；`signal` 可空 |
| **输出契约** | `void`（原地追加 `index`） |
| **分支** | ① 超深度 / 超条目上限 / 已 abort → return；② `listDir` 抛错 → return；③ 条目名以 `.` 开头 → continue；④ 目录 → 递归；⑤ `.md` 且未超限 → 读+解析；⑥ 超大文件 → continue；⑦ 读/解析抛错 → continue |
| **覆盖** | 🟡 经 `buildVaultIndex` 间接覆盖 |
| **静默失败** | ☠ `:76` `catch { return; }` —— 单个目录列不出时**整个子树静默消失**，只体现在 `failedRoots`（且仅当**根目录**失败时才记录；子目录失败**不上报**） |
| 其他 | 🟡 `:72` `index.length >= MAX_ENTRIES` 的检查在**递归入口**，意味着超限时已读到的文件仍会被处理 —— 上限是「软」的 |

#### `buildVaultIndex(ctx, vaultPath, signal)` — `:113-146`

| 项 | 内容 |
|---|---|
| **输入契约** | `vaultPath: string`；`SCAN_ROOTS` 来自 `config.js:62` |
| **输出契约** | `{ entries: Entry[], ok: boolean, failedRoots: string[] }` |
| **分支** | ① `resolve` 失败 → `failedRoots.push` + continue；② `stat` 失败 → 同上；③ `stat.type !== 'directory'` → 同上；④ 成功 → `scannedRoots += 1` + `walk`；⑤ `signal.aborted` → break |
| **覆盖** | ✅ `run.mjs:173`、`audit-flow.mjs:508`、`audit-counters.mjs:587` |
| **静默失败** | ✅ 设计良好：`ok: scannedRoots > 0` 让「全部失败」可与「空 Vault」区分（`index.js:198-201` 正确消费） |
| 未覆盖 | ❌ `vaultPath` 为空串 / 相对路径；❌ `SCAN_ROOTS` 某项是文件而非目录（`:133` 分支） |

---

## 2. 已确认缺陷（按优先级）

> 每条含：现象 → 直接原因 → 中间环节 → 根因 → 最小复现 → 反证。

### D1【P0｜已验证 + 实测复现】`summary:` 空值让笔记被静默移出索引

- **现象**：某篇笔记在面板「知识索引」里不计入，且**日志、计数器、面板全部无异常**。
- **直接原因**：`lib/vault-index.js:52`
  ```js
  summary: (data.summary || body.substring(0, 150)).substring(0, 200),
  ```
  `parseFrontmatter:35` 把空值键解析成 `[]`；`[] || x` → `[]`（数组是 truthy）；`[].substring` → **TypeError**。
- **中间环节**：`walk()` 的 `:86-91`
  ```js
  try { const content = await ctx.fs.readText(...); index.push(parseEntry(content, entry.target.displayPath)); }
  catch { /* 读不到的笔记直接跳过，不影响整体扫描 */ }
  ```
  → 异常被吞，该笔记不进 `index`。
- **根因**：**「解析失败」与「读取失败」被合并进同一个 `catch`**，注释只描述了后者。
- **最小复现**（已执行，非推断）：
  ```
  import { parseFrontmatter, parseEntry } from './lib/vault-index.js';
  parseEntry('---\ntitle: T\nsummary:\n---\nbody', 'D:/v/a.md')
  → TypeError: (data.summary || body.substring(...)).substring is not a function
  ```
- **触发条件（实测矩阵）**：

  | frontmatter | `data` | `parseEntry` |
  |---|---|---|
  | `summary:` 空 | `summary: []` | **THREW TypeError** |
  | `title:` 空 | `title: []` | 不抛，但 `title` 变成数组 `[]` → `queryIndex:89 if (entry.title)` 仍 +0.1 置信度（语义错误） |
  | `category:` 空 | `category: []` | 不抛，`category` 为数组 → `queryIndex:76` 比较永假 |
  | 正常 | 正常 | 正常 |
  | 无 frontmatter | `{}` | 正常（`title` 取文件名） |
  | `标题: T` | `{}` | 正常但 **CJK 键被丢弃** |
- **反证**：若 `parseFrontmatter` 对空值键返回 `''` 而非 `[]`，则 `:52` 会走 `body.substring` 分支，不抛。→ 说明根因也可定位在 `:35` 的 `val === '' ? [] : ...`（**两处任一改动都能修**，需产品决策：空值键到底该是「空列表」还是「空串」）。
- **为何现有测试没拦住**：`test/run.mjs:93,97` 的 `parseFrontmatter` 用例只覆盖正常与无 frontmatter；`knowledge-quality.mjs:119` 的 `parseEntry` 用例用的是完整字段。**没有一条用例用过「空值键」**。

### D2【P0｜已验证】`maybeOrganize()` 的三类 spawn 失败零观测

- **现象**：知识整理静默不执行时，`organizeRuns` / `organizeFailed` / `writeFailures` **三个计数器全是 0**，日志无输出。
- **直接原因**：`index.js:472-484` 直接调用 `runner.spawn()`，而**没有走 `runner` 的失败上报路径**：
  ```js
  const handle = await runner.spawn([script, JSON.stringify({ limit: cfg.organize.batchLimit })], '');
  if (!handle) return;                     // :476  ← spawn 失败：无计数、无日志
  const outcome = await handle.done;        // :477  ← done reject 时抛
  ...
  })().catch(() => {});                     // :484  ← 吞掉，无计数、无日志
  ```
- **中间环节**：`lib/writer.js:48-67` 的 `spawn()` 有三条失败出口，全部 `return null`：
  | 出口 | 行号 | 触发条件 |
  |---|---|---|
  | `!executable` | `:50` | `cfg.nodePath` 不可解析（如 node 被卸载、路径写错） |
  | `catch` | `:64-66` | `ctx.subprocess.spawn` 抛错（权限、Job 对象失败） |
  | — | — | `handle.done` reject（进程被强杀、句柄异常） |
- **根因**：**`fire()`（`:100-124`）与 `spawn()`（`:48-67`）的失败上报能力不对称**。`fire()` 覆盖全部四个分支（`spawn-unavailable` / `exit-N` / `spawn-error` / `spawn-throw`），`spawn()` 一个都不覆盖。而 `index.js` 的四个事件处理器走 `fire()`，唯独 `maybeOrganize()` 走 `spawn()`。
- **与 KB 坑 8 的同型性**：完全符合「三层不可见」——日志无输出（`:484` 吞掉）／计数器恒 0（三个计数器都不 +1）／测试全绿（`wiring.mjs:258` 只断言 `spawn` **被导出**，不断言它的失败被上报）。
- **反证**：`organizeFailed` 只在 `handle.done` **resolve 且 `exitCode !== 0`** 时 +1（`:481`）。若把「spawn 拿不到句柄」也算作一次失败并 `status.record('organizeFailed', { exit: -1 })`，则该盲区消失。→ 说明修法存在且不改变现有语义。
- **为何现有测试没拦住**：`test/wiring.mjs:250-268` 的守卫**只核对导出表**（`typeof runner.spawn === 'function'`），正是 KB 坑 8 的教训「`runner.spawn` 与 `runner.bridge` 在源码阅读上完全对称，静态阅读无法发现」——这条守卫挡住了「未导出」，但没挡住「导出了却不上报失败」。

### D3【P1｜已验证】HMAC 密钥未传给子进程，静默回落到硬编码默认值

- **现象**：用户在 `cordis.patch.yml:7` 配置的 `hmacSecretEnv: OBSIDIAN_BRIDGE_HMAC_SECRET` **完全无效**；`bridge.js` 实际用的是硬编码的 `'workbuddy-obsidian-bridge'`。
- **直接原因**：`lib/writer.js:62`
  ```js
  env: { OBSIDIAN_VAULT_PATH: cfg.vaultPath },
  ```
  只传了 vault 路径。`cfg.hmacSecretEnv` **从未被读取**（`grep -n "hmacSecretEnv" obsidian-bridge` 只命中 `lib/config.js:15`（schema）、`:80`（resolveConfig）、`cordis.patch.yml:7`（配置）——**零消费者**）。
- **中间环节**：`D:/MyVault/90_Agent/hooks/bridge.js:63-67`
  ```js
  function hmacSign(data, secret) {
    // 密钥优先取显式参数，其次环境变量（PRD Q5），最后才是兼容用默认值
    const key = secret || process.env.OBSIDIAN_BRIDGE_HMAC_SECRET || 'workbuddy-obsidian-bridge';
  ```
  → 环境变量缺失时**静默**使用公开默认密钥。
- **根因**：**配置项与实际生效路径脱节** —— `hmacSecretEnv` 在 schema 里声明、在 resolveConfig 里解析、在 patch 里配置，但运行时从未被消费；真正的密钥来源是子进程环境变量，而插件没有传。
- **影响**：`bridge.js:216-220` 用它做调用链签名（`HMAC-SHA256`），签名强度退化为「公开已知密钥」。`docs/CONFIG.md:54` 声称「只提供环境变量名，插件本身不读密钥」——**文档描述了意图，但代码没有把这个名字对应的值传下去**。
- **反证**：若 `spawn()` 的 `env` 写成 `{ OBSIDIAN_VAULT_PATH: cfg.vaultPath, [cfg.hmacSecretEnv]: process.env[cfg.hmacSecretEnv] }`，则 `bridge.js:65` 会读到用户配置的密钥，默认值不再触发。→ 修法存在。
- **注**：`dsh-subprocess-local` 的 `env` **是合并而非替换**（`lib/runner-launch-*.js:687-697`：`const env = scrubbedParentEnv(); ...{...env, ...callerEntries}`），所以补传不会破坏子进程的 PATH 等变量。**该前提已验证。**

### D4【P1｜已验证 + 实测】`parseFrontmatter` 与 `bridge.js` 并不「保持一致」

- **现象**：注释声称一致，实测不一致。
- **直接原因**：`lib/vault-index.js:14-16` 的注释
  > 与 `bridge.js` 的 `parseFrontmatter` 保持一致：支持 `key: value` 与 `key:` 后跟 `- item` 的列表写法

  但 `bridge.js:107-138` 的 `parseFrontmatterBlock` **还支持嵌套对象**（`:119-131`：缩进的 `key: value` 会变成 `data[currentKey][key]`），而 `vault-index.js:31` 的正则 `/^(\w[\w-]*):/` **要求行首就是键名**（不允许前导缩进）→ 嵌套键被整行忽略。
- **中间环节**：`lib/vault-index.js:57`
  ```js
  project: data.project || data.source?.name || '',
  ```
  `data.source` 永远是 `[]`（`:35` 的空值分支）或字符串，**永远不会是对象** → `data.source?.name` **恒为 `undefined`**，这个兜底分支是死代码。
- **实测**（已执行）：
  ```
  parseEntry('---\nproject: P\nsource:\n  name: ProjX\n---\nbody', ...)
  → fm={"project":"P","source":[]}   project="P"   ← 嵌套的 name 被丢弃
  ```
  `bridge.js` 对同一段会解析出 `source.name === 'ProjX'`。
- **影响（当前为潜伏）**：`query.js:81` 的 `project` 过滤**在 `index.js:341` 从未被传入**（`queryIndex(entries, { keywords, limit })`），所以今天不影响功能。但**一旦将来启用 project 维度过滤，嵌套 frontmatter 的笔记会全部落空**。
- **反证**：若把 `:31` 的正则改为 `/^(\s*)(\w[\w-]*):\s*(.*)$/` 并像 `bridge.js:126-131` 那样按缩进建嵌套对象，则 `data.source.name` 可解析。→ 修法存在（约 10 行）。

### D5【P2｜已验证】`enabled.prompt = false` 时仍构建索引并计入 `indexBuilt`

- **现象**：面板显示「用户 prompt 已停用」，但「索引构建次数」仍在增长。
- **直接原因**：`index.js:337-355` 的顺序
  ```js
  if (cfg.inject.enabled) {
    try { const entries = await ensureIndex(signal); ... } catch {}   // :339 ← 仍会执行
  }
  if (!cfg.enabled.prompt) return decision;                            // :355 ← 才返回
  ```
  `ensureIndex`（`:204`）在成功时执行 `status.record('indexBuilt', ...)`。
- **中间环节**：`:352-354` 的注释声称「留痕、计数、注入三者必须一起受它控制」——**注入确实被挡住了**（`:355` 在 `return` 之前不追加消息），但 **`indexBuilt` 计数与 `ensureIndex` 的副作用没有被挡住**。
- **根因**：注释承诺的「三件事一起受控」与实际代码的「两件事受控 + 一件副作用不受控」不符。
- **反证**：把 `if (!cfg.enabled.prompt) return decision;` 提到 `if (cfg.inject.enabled)` **之前**，则 `indexBuilt` 不再增长；代价是 `prompt` 关闭时连索引都不构建（面板 `index.size` 变 0）。→ 这是产品语义选择，需决策。
- **注**：KB 的 `<最佳实践文档>.md:225` 检查清单写着「`enabled.*` 的语义与文档一致（`enabled.prompt` 在 1.0.1 起同时控制注入）」——**只提到控制注入，没提到不控制 `indexBuilt`**。

### D6【P2｜已验证】空索引永不 fresh，导致重复全量扫描

- **现象**：Vault 中笔记数为 0（或全部被 D1 过滤掉）时，每次用户 prompt 都触发一次完整 Vault 扫描。
- **直接原因**：`index.js:190`
  ```js
  const fresh = indexBuiltAt !== null && Date.now() - indexBuiltAt < INDEX_TTL_MS && index.length > 0;
  ```
  `index.length > 0` 让「扫描成功但结果为空」永远不满足 fresh。
- **中间环节**：`agent/pre-step:339` 每次真实用户 prompt 都调 `ensureIndex`。
- **根因**：freshness 判据混用了两个正交概念 —— 「缓存是否在有效期内」与「缓存是否非空」。空结果被误判为「无缓存」。
- **反证**：若改为 `indexBuiltAt !== null && Date.now() - indexBuiltAt < INDEX_TTL_MS`（去掉 `index.length > 0`），空 Vault 就只扫一次。→ 修法存在。
- **注**：`indexBuiltAt` 在扫描失败时**不更新**（`:198-201`、`:207-211`），所以「失败重试」的行为是对的；只有「成功但为空」这一种情况被误伤。

### D7【P2｜已验证】`diagnose` 事件不受任何开关控制

- **现象**：`bridge-diagnostics.jsonl` 持续增长（实测 24 KB，最后写入 21:01:44）。
- **直接原因**：`index.js:320-328` 的 `runner.bridge('diagnose', {...})` 位于 `if (!cfg.enabled.prompt) return decision;`（`:355`）**之前**，且不在 `cfg.inject.enabled` 块内 → **四个开关全关也照写**。
- **中间环节**：`bridge.js` 的 `diagnose` 分支把内容写进 `bridge-diagnostics.jsonl`。
- **根因**：诊断探针被放进了生产路径且没有独立开关，也没有轮转/上限。
- **反证**：若给它加 `cfg.enabled.prompt && cfg.inject.enabled` 之类的门，或加行数上限，则不再无界增长。→ 修法存在。

### D8【P2｜已验证】`toolEvents` 计数先于参数校验

- **现象**：一次畸形派发（`exec` 为 `undefined`）也会让「工具调用事件」+1，且 `tool` 字段为空串。
- **直接原因**：`index.js:408-412`
  ```js
  const toolName = exec?.name ?? '';
  status.record('toolEvents', { tool: toolName });   // :411
  touch();
  ```
  而 `exec` 的归一化在 `:403-405` 已完成，若 `execArg` 既不是合法 exec 也不是 `{exec}` 包装，`exec` 就是 `undefined`。
- **根因**：计数语义「发生过多少次工具调用」被实现为「`tools/result` 被派发过多少次」。
- **反证**：若把 `record` 移到 `if (!exec) return;` 之后，则畸形派发不计数。→ 修法存在。
- **影响**：`:394-396` 的注释明确写着「`toolEvents` 语义是『发生过多少次工具调用』，必须**每次**都 +1」——按注释，**当前实现是对的**。此条应定性为**语义澄清项**而非缺陷，需产品确认。

### D9【P2｜已验证】`mountBridgeService` 双层吞异常且无计数器

- **现象**：Typert 服务挂载失败时，只有一行 warn 日志；面板显示错误文案；**没有任何计数器**。
- **直接原因**：`index.js:121-125`
  ```js
  void mountBridgeService(ctx)
    .then((mounted) => { if (!mounted) ctx.logger?.warn?.('...挂载失败...'); })
    .catch(() => {});
  ```
  `mountBridgeService`（`lib/bridge-service.js:31-65`）**内部已经 `try/catch` 并 `return false`**，所以外层 `.catch(() => {})` 是**死代码**；失败时产生**两条内容相同的 warn**（`:60` 一条 + `:123` 一条）。
- **中间环节**：`lib/bridge-service.js:33` `await import('@deepseek-ai/dsh-typert-protocol')`。
- **根因（潜在）**：**该包不在插件的解析路径里** —— 已实测：
  ```
  $ node -e "import('@deepseek-ai/dsh-typert-protocol')"   # cwd = obsidian-bridge
  FAIL ERR_MODULE_NOT_FOUND
  $ node -e "import('@deepseek-ai/dsh-typert-protocol')"   # cwd = D:\deepseek deskt\...\resources\app
  OK keys= Remote,RemoteError,...,TypertRemoteService,...
  ```
  `lib/bridge-service.js:16-19` 的注释断言「官方 bundle 能解析它，说明 Host 会回退到安装目录」——**当前成立**（面板取数成功、快照 `vaultPath` 真实），但这是一个**未文档化的隐式依赖**：一旦插件被移动、或 Host 的回退策略变化，挂载会失败，且**唯一的证据是一行 warn**。
- **反证**：若把失败计入一个专用计数器（如 `serviceMountFailed`）并在面板展示，则该故障从「弱证据」升级为「强证据」。→ 修法存在。
- **证据强度**：**当前是通的（强证据）**，但**故障路径的可观测性是弱的**。

### D10【P2｜已验证】`tools/result` 过滤规则与 `bridge.js` 并不「完全一致」

- **现象**：注释声称完全一致，实测有两处差异。
- **直接原因**：`index.js:415-421` 的注释
  > **判定规则必须与 `90_Agent/hooks/bridge.js:618-627` 完全一致**

  | 维度 | `index.js:422-441` | `bridge.js:618-627` | 是否一致 |
  |---|---|---|---|
  | 空值兜底 | `exec?.arguments ?? {}`（**nullish**，`:422`） | `toolData.tool_input \|\| {}`（**falsy**，`:619`） | ❌ 不一致 |
  | 非对象参数归一 | `{ value: args }`（`:430`） | 不包装，直接 `JSON.stringify` | ❌ 不一致 |
  | 词表 | `projectOps` + `memoryOps`（`:437-438`） | 同两名（`:622`、`:626`） | ✅ 一致 |
  | 匹配方式 | `text.includes(op)` on `serialized.toLowerCase()` | `toolInput.toLowerCase().includes(op)` | ✅ 一致 |
  | 截断 | `substring(0, 300)`（`:432`） | `substring(0, 300)`（`:619`） | ✅ 一致 |

- **实测差异后果**：`tool_input = ''`（空串）时
  - 插件：`args = ''` → `JSON.parse('')` 抛错被 `:426` 吞 → `args` 仍是 `''` → `toolInput = {value:''}` → `serialized = '{"value":""}'` → `hasContent === false`（`:433`）→ **跳过**
  - `bridge.js`：`'' || {}` → `{}` → `JSON.stringify({})` = `'{}'` → 两个 `isXxxOp` 都 false → **仍然 `logInteraction`**（`:641`）
  - → 插件「跳过」，脚本「照记」，**行为分歧真实存在**（但方向与注释担心的相反：插件更严）。
- **根因**：`??` 与 `||` 的语义差异 + 是否包装非对象参数。两者都会改变待匹配字符串。
- **反证**：若统一为 `const raw = exec?.arguments; const toolInput = raw && typeof raw === 'object' ? raw : (raw === undefined || raw === null ? {} : { value: raw });`，则空串会归一到 `{value:''}` —— 仍与 `bridge.js` 的 `{}` 不同。**要真正一致，必须照抄 `bridge.js` 的 `|| {}`**。→ 修法存在。
- **注**：KB 记录过「实测累积 1600+ 条」噪声，说明 `bridge.js` 侧确实在记空输入；插件侧的过滤**实际上没有减少任何 Vault 写入**（因为脚本会自己记）。这一点值得单独确认是否是设计意图。

### D11【P3｜已验证】启动构建的 `.finally()` 返回值未处理

- `index.js:488` `ensureIndex().catch(() => {}).finally(() => touch());`
- `.finally()` 返回一个新 Promise；若 `touch()` 抛错，该 Promise 无 handler → **unhandled rejection**。
- **风险等级低**：`touch()` → `snapshot()`（`:262-277`）内部 `countMcpTools` 已 `try/catch`（`:242-255`），`buildSnapshot` 是纯函数，`setSnapshot` 是赋值。实测路径不抛。
- **反证**：写成 `void ensureIndex().catch(() => {}).finally(() => { try { touch(); } catch {} });` 即可消除。→ 修法存在。

### D12【P3｜已验证】`getSnapshot()` 吞掉 builder 异常

- `lib/status-store.js:33-39`
  ```js
  if (typeof snapshotBuilder === 'function') {
    try { snapshotValue = snapshotBuilder(); } catch { /* 构建失败时保持 null */ }
  }
  ```
- **后果**：`bridge-service.js:46` `async status() { return getSnapshot(); }` 返回 `null` → 网关编码 `{ok:true, value:null}` → Client `client.js:150` `if (data === null || typeof data !== 'object') throw new Error('快照结构异常: null')` → 面板显示「暂时无法读取桥接状态：快照结构异常: null」。
- **可观测性**：**只有一行面板文案**，Host 侧零日志、零计数。属于 KB 坑 4 的「通道通、无报错、渲染 undefined」同型。
- **反证**：在 `catch` 里 `console.warn` / `status.record('snapshotBuildFailed')` 即可。→ 修法存在。

### D13【P3｜已验证】`refreshSnapshot()` 抛错时不会回落到 `getSnapshot()`

- `lib/status-store.js:69-72`
  ```js
  export async function refreshSnapshot() {
    if (refreshHook) await refreshHook();
    return getSnapshot();
  }
  ```
- **后果**：`refreshHook`（= `index.js:175` 的 `rebuildIndex`）抛错时，`refreshSnapshot` 直接 reject，**`getSnapshot()` 不会被调用** → Client 收到 `gateway/internal` 失败 → 面板显示失败。
- **实际风险**：`rebuildIndex`（`:165-171`）内部 `ensureIndex` 已自吞异常，`snapshot()` 不抛 → **当前不可达**。但契约上没有保证。
- **反证**：`try { if (refreshHook) await refreshHook(); } catch {} return getSnapshot();` 即可。→ 修法存在。

### D14【P3｜推断，已排除主要路径】`fire()` 的 `onFulfilled` 抛错会成为 unhandled rejection

- `lib/writer.js:108` `void handle.done.then((outcome) => {...}, (error) => {...})`
- 若 `onFulfilled` 抛错，`.then` 返回的 Promise 无 handler → **unhandled rejection**。
- **已验证的安全部分**：`:111` `handle.collected.stderr?.readFrom(0)?.text` —— `readFrom`（`dsh-subprocess-local/lib/output.js:188-198`）是**纯计算**（`Buffer.concat` + `subarray` + `toString`），`fromByte = 0` 时 `0 < windowStart` 最多置 `lossy`，**不抛**。
- **已验证的安全部分**：`:88` `args.join(' ')` —— `args` 的三个来源（`bridge`、`memorySync`、`maybeOrganize`）都是字面量数组，不会是 `undefined`。
- **结论**：**当前不可达**，属防御性改进。若将来有人传非数组 `args` 给 `reportFailure`，会触发。
- **反证**：`.then(a, b).catch(() => {})` 或把 `onFulfilled` 包进 `try/catch` 即可。→ 修法存在。

---

## 3. 交叉测试设计（针对每个未覆盖分支）

> 约定：每条给出 **输入 → 期望 → 能区分什么**。✅ = 能拦住对应缺陷的回归。
> 全部用例均为**只读设计**，未执行（本任务为只读评审）。

### 3.1 `lib/vault-index.js`

#### T1-1 `parseEntry` 空值 frontmatter（✅ 拦 D1）

| 项 | 内容 |
|---|---|
| **输入** | `parseEntry('---\ntitle: T\nsummary:\n---\nbody', 'D:/v/a.md')` |
| **期望（当前实现）** | 抛 `TypeError` —— **本用例的作用是「先固化当前行为」，再驱动修复** |
| **期望（修复后）** | 不抛，`summary` 为 `body` 的前 150 字截断到 200 |
| **能区分** | 修复前：`assert.throws` 通过；修复后：`assert.throws` 失败 → 说明行为已变。**必须成对更新**，否则测试会锁死 bug |
| **边界** | `summary: ""`（显式空串）、`summary: ''`、`summary:` 后跟注释 |
| **异常** | `parseEntry(content, undefined)` → 期望不抛（`title` 回退到空串），当前会抛（D13） |

#### T1-2 `parseFrontmatter` 嵌套对象（✅ 拦 D4）

| 项 | 内容 |
|---|---|
| **输入** | `parseFrontmatter('---\nsource:\n  name: ProjX\n---\nbody')` |
| **期望（修复后）** | `data.source` 为 `{ name: 'ProjX' }` |
| **期望（当前）** | `data.source` 为 `[]` |
| **能区分** | 直接断言 `data.source.name === 'ProjX'`；当前实现为 `undefined` → 失败 |
| **对照** | 同输入跑 `bridge.js` 的 `parseFrontmatterBlock`，**两者输出必须逐字段相等**（这是 KB「参照实现优先」的应用） |

#### T1-3 `buildVaultIndex` 全根失败 vs 空 Vault（✅ 验证既有设计）

| 项 | 内容 |
|---|---|
| **输入 A** | `ctx.fs.resolve` 对所有 `SCAN_ROOTS` 都抛错 |
| **期望 A** | `{ ok: false, failedRoots: [...全部 4 项], entries: [] }` |
| **输入 B** | 所有根可解析、目录为空 |
| **期望 B** | `{ ok: true, failedRoots: [], entries: [] }` |
| **能区分** | A 与 B 的 `entries` 都是 `[]`，**只有 `ok` 能区分** → 正是 `index.js:198-201` 依赖的判据 |
| **边界** | 4 个根里 3 个失败 1 个成功 → `ok: true`，`failedRoots` 长度 3 |
| **异常** | `ctx.fs.listDir` 对子目录抛错 → 该子树消失，但 `ok` 仍为 true（**当前行为，需确认是否可接受**） |

#### T1-4 `walk` 的条目/深度上限（✅ 拦回归）

| 项 | 内容 |
|---|---|
| **输入** | 构造 5001 个 `.md` 文件（或把 `MAX_ENTRIES` 临时调小） |
| **期望** | `index.length === 5000`，且**最后一个被处理的条目不超过上限后的第一个** |
| **能区分** | 当前 `:72`/`:80` 的两处检查位置不同（入口 vs 循环内），上限语义是「软」的；断言精确条数可暴露语义漂移 |
| **边界** | 恰好 5000 个；第 5001 个 |
| **异常** | `signal.aborted` 在递归中途被置位 → 期望立即停止，`index` 不再增长 |

### 3.2 `lib/writer.js`

#### T2-1 `maybeOrganize` 的三类 spawn 失败（✅ 拦 D2，**最高优先级**）

| 项 | 内容 |
|---|---|
| **输入 A** | `cfg.nodePath` 指向不存在的路径 → `resolveNode()` 返回 `null` → `spawn()` 返回 `null` |
| **期望 A** | `status.counters.writeFailures === 1` 且 `last.writeFailures.reason === 'spawn-unavailable'` |
| **输入 B** | 把 `ctx.subprocess.spawn` 换成抛错的桩 → `spawn()` 的 `:64` catch → `null` |
| **期望 B** | `writeFailures === 1`，`reason === 'spawn-throw'` |
| **输入 C** | `ctx.subprocess.spawn` 返回 `{ done: Promise.reject(new Error('killed')) }` |
| **期望 C** | `writeFailures === 1`，`reason === 'spawn-error'` |
| **输入 D** | `spawn` 成功但 `exitCode === 1` |
| **期望 D** | `organizeFailed === 1`（`exit: 1`），`writeFailures` **不** +1 |
| **能区分** | A/B/C 三条在**当前实现下全部得到 0**（无计数、无日志）→ 这是「假阴性」测试；修复后必须变 1 |
| **异常** | `handle.done` resolve 为 `undefined` → `outcome?.exitCode ?? -1` → `organizeFailed: 1, exit: -1` |
| **产物断言（KB 教训 E）** | 三条用例的**共同断言**：`organizeRuns + organizeFailed + writeFailures` 至少一个 > 0。**只要三者全 0，测试就失败** —— 这直接针对「0 次与从未运行不可区分」 |

#### T2-2 `spawn()` 的 `env` 合并（✅ 拦 D3）

| 项 | 内容 |
|---|---|
| **输入** | `cfg = { vaultPath: 'D:/MyVault', nodePath: 'C:/node.exe', hmacSecretEnv: 'OBSIDIAN_BRIDGE_HMAC_SECRET' }`，`process.env.OBSIDIAN_BRIDGE_HMAC_SECRET = 's3cret'` |
| **期望** | `ctx.subprocess.spawn` 收到的 `env` **同时**含 `OBSIDIAN_VAULT_PATH === 'D:/MyVault'` 与 `OBSIDIAN_BRIDGE_HMAC_SECRET === 's3cret'` |
| **能区分** | 当前实现只传前者 → 断言失败。**且必须同时断言子进程仍能看到 `PATH`**（防止「修 D3 时改成替换 env」的回归） |
| **边界** | `cfg.hmacSecretEnv` 对应的环境变量在父进程不存在 → 期望**不传该键**（或传 `undefined`），而不是传字符串 `'undefined'` |
| **异常** | `cfg.hmacSecretEnv` 为空串 → 期望不传 |

#### T2-3 `reportFailure` 的四分支完整性（✅ 拦 D2 类回归）

| 项 | 内容 |
|---|---|
| **输入** | 依次触发 `spawn-unavailable` / `exit-N` / `spawn-error` / `spawn-throw` |
| **期望** | 每次都满足：`onWriteFailure` 被调用 **且** `ctx.logger.warn` 被调用 |
| **能区分** | 当前 `fire()` 四分支都满足（`writer.js:105/112/116/122`）—— 本用例是**回归守卫**，防止将来新增第五个失败出口时漏报 |
| **产物断言** | 断言 `logger.warn` 的调用参数**包含脚本路径**（`args.join(' ')`），确保日志可定位到具体脚本 |

#### T2-4 `readFrom(0)` 在空 stderr 上（✅ 拦 D14 类回归）

| 项 | 内容 |
|---|---|
| **输入** | `handle.collected.stderr` 为空（子进程无输出）且退出码非 0 |
| **期望** | `reportFailure` 被调用，`detail` 为空串，**不抛**、**不产生 unhandled rejection** |
| **能区分** | 用 `process.on('unhandledRejection')` 计数；当前为 0，若 `:108` 的 `void` 链被改坏则 > 0 |
| **异常** | `handle.collected` 为 `undefined` → `?.` 链 → `detail = ''` |

### 3.3 `lib/status-store.js`

#### T3-1 `getSnapshot()` builder 异常（✅ 拦 D12）

| 项 | 内容 |
|---|---|
| **输入** | `setSnapshotBuilder(() => { throw new Error('boom'); })`，然后 `getSnapshot()` |
| **期望（当前）** | 返回 `null`，**且不抛**（异常被 `:36` 吞） |
| **期望（修复后）** | 返回 `null`，**且**产生一条可观测记录（日志或计数器） |
| **能区分** | 用 `logger.warn` 调用次数断言。当前为 0 → 测试失败（假阴性），修复后变 1 |
| **边界** | `setSnapshotBuilder(null)` 后再 `getSnapshot()` → 返回 `null`，不抛 |
| **异常** | `setSnapshot({})` 后 builder 抛错 → 应返回已存的 `{}`（`:32` 的短路），不调用 builder |

#### T3-2 `refreshSnapshot()` 的 hook 异常（✅ 拦 D13）

| 项 | 内容 |
|---|---|
| **输入** | `setRefreshHook(() => { throw new Error('rebuild boom'); })`，先 `setSnapshot({v:1})` |
| **期望（当前）** | **reject** |
| **期望（修复后）** | resolve 到 `{v:1}`（回落到 `getSnapshot()`） |
| **能区分** | `await assert.rejects(...)` vs `await assert.resolves(...)` |
| **边界** | `setRefreshHook(null)` → 直接返回 `getSnapshot()` |
| **异常** | hook 返回 `undefined`（非 Promise）→ `await undefined` 正常 → 返回快照 |

#### T3-3 `resetStore()` 的隔离性（✅ 拦既有回归）

| 项 | 内容 |
|---|---|
| **输入** | `setSnapshot(A)` + `setRefreshHook(h)` + `setSnapshotBuilder(b)` → `resetStore()` |
| **期望** | `getSnapshot()` 返回 `null`（三个模块级变量都清空） |
| **能区分** | 防止 HMR 场景下读到上一个实例的快照（KB 记录的实测泄漏 `sessionStarts: 1`） |
| **产物断言** | 模拟两次 `apply()`：第一次 `setSnapshot({c:1})`，`resetStore()`，第二次不调 `touch()` → `getSnapshot()` 必须为 `null` |

### 3.4 `index.js`

#### T4-1 `lastAssistantText` 的七个分支（✅ 补 0 覆盖）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| B1 | `session.seq = 5`，`eventAt(4)` 为 `assistant/message` 且带文本 | 返回该文本 | 第一档主路径 |
| B2 | 同上但 `messageText` 为 `''` | 继续向后找 | `:66` 的 `if (text)` 分支 |
| B3 | `eventAt(3)` 为 `turn/start`，`eventAt(4)` 为 `assistant/message` | 返回 `eventAt(4)` 的文本（**不**被 `turn/start` 拦截） | `:70` 的 break 只在**遍历到**时触发，顺序敏感 |
| B4 | `eventAt` 对某个 seq 返回 `undefined` | continue，不抛 | `:61-62` |
| B5 | `session.seq = undefined` | 走第二档，不抛 | `:60` 的 `Number(undefined)` → NaN |
| B6 | `deriveMessages()` 返回非数组 | 返回 `''` | `:78` |
| B7 | 第一档 `eventAt` 抛错 + 第二档正常 | 返回第二档结果 | `:72` 的 catch |
| **异常** | 两档都抛错 | 返回 `''`，**不抛** | 整体契约 |
| **产物断言** | 用 B7 的结果驱动 `agent/turn-stopping` → 断言 `runner.bridge('stop', {response: ''})` 被调用 **且** `status.counters.stops === 1` → **这条断言正是「有计数、无产物」的可观测化** |

#### T4-2 `countMcpTools` 的分支与 `obsidian-local` 常量（✅ 拦 D-测试空白）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| C1 | `tools.schemas` 返回 `[{name:'mcp__obsidian-local__a'}, {name:'mcp__other__b'}]` | `1` | 按 server 过滤（KB 记录的 222→15 修复） |
| C2 | 返回 `[{function:{name:'mcp__obsidian-local__a'}}]` | `1` | `:248` 的 `t?.function?.name` 分支 |
| C3 | 返回 `['mcp__obsidian-local__a']`（字符串数组） | `1` | `:248` 的 `typeof t === 'string'` 分支 |
| C4 | `tools.schemas` 返回非数组 | `null` | `:247` |
| C5 | `ctx.get('tools')` 返回 `undefined` | `null` | `:244` |
| C6 | `tools.schemas` 抛错 | `null` | `:253` 的 catch |
| C7 | `lastAgent = null` | 期望 `schemas` 被以 `undefined` 调用 | `:246` 的 `?? undefined` |
| **常量守卫** | 读取 `cordis.patch.yml` 的 `obsidian-mcp.config.serverName` 与 `index.js:48` 的 `OBSIDIAN_MCP_SERVER` | **两者必须相等** | **当前无任何测试**；漂移会让面板静默显示「未加载」 |
| **产物断言** | C1~C7 每条都断言：返回值是 `number` 或 `null`，**且**当返回 `null` 时 `logger`/`status` 有可观测记录（当前没有 → 测试失败，驱动修复） |

#### T4-3 `agent/pre-step` 的开关语义（✅ 拦 D5/D7）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| E1 | `enabled.prompt=false`，其余开 | **不**追加注入消息；`prompts` 不 +1；**`indexBuilt` 不 +1**（修复后） | D5 的核心断言 |
| E2 | `enabled.prompt=true`，`inject.enabled=false` | 追加消息**不发生**；`prompts` +1；`injections` **不** +1 | 注入开关独立生效 |
| E3 | `enabled.prompt=true`，`inject.enabled=true`，`queryIndex` 返回空 | `prompts` +1，`injections` 不 +1，`touch()` 被调用 | `:359`/`:363` 的分支 |
| E4 | `decision.messages` 非数组 / 空 / 末项为 `undefined` | 直接 `return decision`，**不抛**、**不调用 `runner.bridge`** | `:314-317` 的防御分支 |
| E5 | `decision.kind === 'reject'` 或 `signal.aborted` | 在 `await next()` 后立即返回，**不**走到 diagnose | `:308` |
| E6 | `step !== 1` | 不 diagnose、不注入、不计数 | `:310` |
| E7 | `last` 是 `runtime-context`（本插件自己注入的） | 不重复注入（`isRealUserMessage` 为 false） | `:330` 的防环 |
| E8 | `promptText.trim() === ''` | 返回 decision，不注入 | `:333` |
| E9 | `ensureIndex` 抛错 | 不注入，但仍留痕 | `:347-349` |
| **异常** | `decision.messages` 末项 `role==='user'` 但 `source` 缺失 | `isRealUserMessage` 返回 false → 不注入 | `message.js:66` |
| **产物断言** | E1 必须断言 `runner.bridge('diagnose', ...)` **未**被调用（D7 修复后） | — |

#### T4-4 `tools/result` 的签名与过滤（✅ 拦 D8/D10）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| F1 | `(exec, result)` 位置参数，`exec.arguments = {note:'x'}` | `toolEvents` +1，`runner.bridge('post-tool', ...)` 被调用 | 现行签名（KB 记录的 `({exec})` 解构修复） |
| F2 | `({exec: {...}}, result)` 对象载荷 | 归一后同 F1 | `:403-405` |
| F3 | `(undefined, result)` | **不计数**（修复后）／计数 1（当前） | D8 |
| F4 | `exec.arguments = {}` | `toolEvents` +1，**不**调 `post-tool` | `:433` 的 `hasContent` |
| F5 | `exec.arguments = 'not json'` | `toolEvents` +1，不抛，`toolInput = {value:'not json'}` | `:425` 的 catch |
| F6 | `exec.arguments = {task:'x'}` | 调 `post-tool`（`task` ∈ projectOps） | `:440` |
| F7 | `exec.arguments = {zzz:'x'}` | 不调 `post-tool` | `:441` |
| F8 | `exec.arguments = {note:'x'}`，序列化后 > 300 字符 | 截断后匹配 | `:432` |
| **一致性** | F4~F8 的每条，**同时**喂给 `bridge.js` 的 `handlePostTool`，断言两者的「是否留痕」一致 | — | **D10 的修复验证**；当前 F4 会不一致 |
| **异常** | `enabled.tool === false` | 立即返回，**不计数**、**不** `touch()` | `:398` |
| **产物断言** | F1~F8 每条都断言 `status.counters.toolEvents` 的**精确增量**（+1 或 +0） | — | 直接针对「计数语义」 |

#### T4-5 `maybeOrganize` 的节流与开关（✅ 拦 D2 的兄弟路径）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| G1 | `organize.enabled = false` | `runner.spawn` **不**被调用 | `:464` |
| G2 | 距上次 < `minIntervalMs` | 不调用 | `:466` |
| G3 | 距上次 ≥ `minIntervalMs` | 调用，参数为 `[script, JSON.stringify({limit: batchLimit})]`，`stdinData === ''` | `:472-475` |
| G4 | `enabled.stop = false` | `agent/turn-stopping` 处理器在 `maybeOrganize` **之前**返回 | `:446` |
| **异常** | `runner.spawn` 返回 `null` | **当前**：静默返回（无计数）；**修复后**：`writeFailures` +1 | D2 |
| **产物断言** | G3 必须断言 `knowledge-organize-cursor.json` 的 mtime 前进（KB 教训 E 的「本该出现的产物」） | — | 这是**唯一**能区分「spawn 成功但脚本没跑」与「spawn 失败」的判据 |

#### T4-6 启动路径（✅ 拦 D9/D11）

| 用例 | 输入 | 期望 | 能区分 |
|---|---|---|---|
| H1 | `mountBridgeService` 返回 `false` | 产生**恰好一条**可观测记录（当前两条 warn） | D9 |
| H2 | `mountBridgeService` reject | **不产生 unhandled rejection**（当前外层 `.catch(() => {})` 兜住，属死代码） | D9 |
| H3 | `ctx.subprocess` 上 `import('@deepseek-ai/dsh-typert-protocol')` 抛 `ERR_MODULE_NOT_FOUND` | 期望：计数 +1 + 日志（当前：仅日志） | D9 的核心 |
| **产物断言** | H3 用 `process.on('unhandledRejection')` 计数为 0 作为附加断言 | — | 防止修 D9 时引入泄漏 |

---

## 4. 因果链追溯（多点，不只报「这一行错了」）

### 链 1：D1 的完整因果链（笔记消失）

```
现象：某篇笔记不计入「知识索引」，日志/计数/面板全无异常
  ↑
直接原因：lib/vault-index.js:52  (data.summary || ...).substring(0,200)
          data.summary 是 [] → [].substring 抛 TypeError
  ↑
中间环节 1：lib/vault-index.js:35  data[currentKey] = val === '' ? [] : ...
          「空值 frontmatter 键」被解析成空数组，而不是空串
  ↑
中间环节 2：lib/vault-index.js:86-91  walk() 的 try/catch 把
          「读失败」与「解析失败」合并处理 → 注释只描述了前者
  ↑
根因：**「解析失败」被归类为「读取失败」**。二者需要不同的可观测性：
      读取失败（权限/IO）应跳过；解析失败（数据格式）应计数并保留原文，
      否则「Vault 里明明有 450 篇，索引只有 N 篇」永远查不出原因。
  ↑
上游 N 层：lib/vault-index.js:14-16 的注释声称与 bridge.js 的
          parseFrontmatter「保持一致」—— 但 bridge.js 对空值键同样返回 []
          （:125），所以**这不是与 bridge.js 的分歧，而是两边共有的语义**。
          真正的上游是「YAML 空值该映射成什么」这个未定义决策。
```

### 链 2：D2 的完整因果链（知识整理静默失败）

```
现象：organizeRuns / organizeFailed / writeFailures 三个计数器全 0
  ↑
直接原因：index.js:476  if (!handle) return;   ← 无 reportFailure
          index.js:484  .catch(() => {})       ← 吞掉
  ↑
中间环节 1：lib/writer.js:48-67  spawn() 有三条失败出口，全部 return null
  ↑
中间环节 2：lib/writer.js:100-124  fire() 是唯一上报失败的函数，
          而它只被 bridge()/memorySync() 使用
  ↑
中间环节 3：index.js 的四个事件处理器全部经 bridge()/memorySync()
          → 走 fire()；唯独 maybeOrganize() 直接调 spawn()
  ↑
根因：**失败上报能力是 fire() 的私有属性，没有上移到 spawn()**。
      任何新的 spawn() 调用方都会自动继承「静默失败」，
      且静态阅读无法发现（writer.js:100 与 :48 在代码上完全对称）。
  ↑
上游 N 层：test/wiring.mjs:250-268 的守卫只核对「导出表」，
          不核对「失败上报」→ 测试给出了虚假的安全感（KB 坑 7/8 同型）
```

### 链 3：D3 的完整因果链（HMAC 密钥失效）

```
现象：面板/日志看不出任何异常；bridge.js 实际用公开默认密钥签名
  ↑
直接原因：lib/writer.js:62  env: { OBSIDIAN_VAULT_PATH: cfg.vaultPath }
          —— 只有 vault 路径
  ↑
中间环节 1：lib/config.js:15  schema 声明 hmacSecretEnv
          lib/config.js:80  resolveConfig 解析它
          cordis.patch.yml:7  配置它
          → **三者都有，唯独没有消费者**
  ↑
中间环节 2：bridge.js:65  secret || process.env.OBSIDIAN_BRIDGE_HMAC_SECRET
          || 'workbuddy-obsidian-bridge'
          → 环境变量缺失时静默回落到硬编码默认值
  ↑
根因：**配置项的「声明—解析—配置—消费」链条在最后一环断开**。
      这类断开的特征是：schema 有、文档有、patch 有、测试有（audit-counters.mjs:164
      把 hmacSecretEnv 当作合法配置传入），但运行时零效果。
  ↑
上游 N 层：docs/CONFIG.md:54 写着「只提供环境变量名，插件本身不读密钥」——
          文档描述的是**意图**，不是**行为**。文档与代码在这里不一致。
```

### 链 4：D5 的完整因果链（停用开关仍在构建索引）

```
现象：面板显示「用户 prompt 已停用」，但「索引构建次数」在涨
  ↑
直接原因：index.js:337-350 的注入块在 index.js:355 的开关判断之前
  ↑
中间环节 1：index.js:204  status.record('indexBuilt', ...) 在 ensureIndex 内部
          → 只要 ensureIndex 成功，计数就 +1，与 enabled.prompt 无关
  ↑
中间环节 2：index.js:352-354 的注释声称「留痕、计数、注入三者必须一起受它控制」
          → 实际只控制了「留痕 + 注入消息追加」，没控制「计数」
  ↑
根因：**「开关的语义边界」在注释与代码之间不一致**。
      注释写的是「三件事」，代码做的是「两件事」。
  ↑
上游 N 层：KB 检查清单（<最佳实践文档>.md:225）只列了「enabled.prompt 同时控制注入」，
          没有要求它控制 indexBuilt —— 所以这条语义从未被任何一方明确定义过。
          **这是需求缺失，不是实现疏忽。**
```

---

## 5. 证据分级汇总

| 编号 | 结论 | 级别 |
|---|---|---|
| D1 | `parseEntry` 空值 frontmatter 抛错 → 笔记被静默移出索引 | **已验证**（源码 + 实测复现） |
| D2 | `maybeOrganize` 三类 spawn 失败零观测 | **已验证**（源码逐行 + 与 `fire()` 对照） |
| D3 | HMAC 密钥未传子进程，回落硬编码默认值 | **已验证**（源码 + `grep` 零消费者 + `bridge.js:65`） |
| D4 | `parseFrontmatter` 不支持嵌套对象，`source?.name` 是死分支 | **已验证**（源码 + 实测） |
| D5 | `enabled.prompt=false` 仍构建索引并计 `indexBuilt` | **已验证**（源码顺序） |
| D6 | 空索引永不 fresh → 重复全量扫描 | **已验证**（源码 + 逻辑） |
| D7 | `diagnose` 不受开关控制，无界增长 | **已验证**（源码 + 实测文件 24 KB 且持续更新） |
| D8 | `toolEvents` 计数先于参数校验 | **已验证**（源码）；**语义待产品确认** |
| D9 | `mountBridgeService` 双层吞异常、无计数器；动态导入包不在插件解析路径 | **已验证**（源码 + 实测 `ERR_MODULE_NOT_FOUND`）+ **推断**（回退机制成立，由面板取数成功反证） |
| D10 | `tools/result` 过滤规则与 `bridge.js` 有两处不一致 | **已验证**（源码逐字段 + 实测推演） |
| D11 | 启动构建 `.finally()` 未处理 | **已验证**（源码）；**风险低**（`touch` 内部已防） |
| D12 | `getSnapshot()` 吞 builder 异常 | **已验证**（源码） |
| D13 | `refreshSnapshot()` hook 抛错时不回落 | **已验证**（源码）；**当前不可达** |
| D14 | `fire()` 的 `onFulfilled` 抛错成 unhandled rejection | **推断**；**主要路径已排除**（`readFrom` 纯计算） |
| — | `obsidian-local` 常量与 patch 的 `serverName` 无一致性测试 | **已验证**（`grep test/*.mjs` 零命中） |
| — | `hmacSecretEnv` 是死配置（schema/resolve/patch 有，消费者无） | **已验证**（`grep` 全仓） |

### 明确标注「证据不足」的部分

1. **`e.execute.call is not a function` 的历史触发点**：`test/evidence/backend-findings.md:149-167` 已定位到旧版 `client.js`（日志 `[obsidian-bridge] remote 注入失败` 在当前源码中 `grep` 零命中），推断为 `ctx.effect(fiberWrapper)` 误用。**本次评审不重复该结论，也不对其负责** —— 它属于 Client 半边。
2. **`mountBridgeService` 的 Host 回退解析机制**：实测「从插件目录 import 失败」+「面板取数成功」→ 反证 Host 有回退。但**回退的具体实现未定位**（未在 `dsh` 主包中找到该逻辑）。**证据不足**，建议由 backend-typert 补充。
3. **D8 的产品语义**：注释说「必须每次都 +1」，代码就是这么做的 → **实现与注释一致**。是「计数语义该不该包含畸形派发」的产品问题，**证据不足以判定对错**。

---

## 6. 建议的修复优先级（供 lead 决策，本次不实施）

| 优先级 | 缺陷 | 建议动作 | 验证方式 |
|---|---|---|---|
| **P0** | D2 | 把失败上报从 `fire()` 上移到 `spawn()`，或让 `maybeOrganize` 复用 `reportFailure` | 新增 T2-1（A/B/C 三例），断言 `writeFailures >= 1` |
| **P0** | D1 | `parseFrontmatter` 空值键改为 `''`，或 `parseEntry` 对 `summary` 做 `Array.isArray` 防御 | 新增 T1-1，断言不抛且 `summary` 来自 body |
| **P1** | D3 | `spawn()` 的 `env` 补 `[cfg.hmacSecretEnv]: process.env[cfg.hmacSecretEnv]`（值不存在则不传） | 新增 T2-2 |
| **P1** | D4 | 照抄 `bridge.js:107-138` 的 `parseFrontmatterBlock`（含嵌套对象） | 新增 T1-2 + 与 bridge.js 的逐字段对照 |
| **P2** | D5 / D7 / D8 / D10 | 产品语义确认后统一调整；D10 建议直接照抄 `bridge.js` 的 `\|\| {}` | T4-3 / T4-4 |
| **P2** | D9 | 新增 `serviceMountFailed` 计数器；清掉死代码 `.catch(() => {})` | T4-6 |
| **P2** | 常量守卫 | 新增测试断言 `index.js:48` 与 `cordis.patch.yml:31` 的 `serverName` 一致 | T4-2 常量守卫 |
| **P3** | D6 / D11 / D12 / D13 / D14 | 低风险清理 | T3-1 / T3-2 / T1-4 |

---

## 7. 与知识库的自检对照

| KB 检查项 | 本次结论 |
|---|---|
| 坑 8 通用化：「为每条静默链路指定一个『本该出现的产物』」 | **D2 完全命中** —— 三个计数器全 0，唯一产物（`knowledge-organize-cursor.json`）只在成功时出现。T2-1 的「三者至少一个 > 0」就是这条规则的落地 |
| 坑 7：「假阳性测试比没有测试更危险」 | **命中** —— `test/wiring.mjs:250-268` 只核对导出表，给出了虚假安全感。T2-1 是针对性补强 |
| 教训 E：「产物断言优先于错误断言」 | 已应用于 T2-1 / T3-3 / T4-5 的设计 |
| 坑 4：「漏解包」 | 本次在 Host 侧的对应物是 **D12**（`getSnapshot` 返回 `null` → 面板「快照结构异常: null」），同样「通道通、无报错」 |
| 检查清单「未注入 `harness`」 | ✅ `index.js:31` `inject = ['agents','fs','subprocess']`，无 `harness`、无 `webServer` |
| 检查清单「Remote 调用方有 `unwrap()`」 | ✅ Client 侧 `client.js:109-120` 已实现；Host 侧 `bridge-service.js:45-52` 返回裸值，由网关包装 —— **契约正确** |
| 检查清单「新增的 `runner.*` 调用已在 `createRunner()` 的 `return` 块里导出」 | ✅ `writer.js:129-153` 导出 `bridge`/`memorySync`/`spawn` |
| 检查清单「每条静默链路都有产物断言」 | ❌ **未达成** —— D2 的链路没有产物断言 |

---

**关联**：`test/evidence/frontend-findings.md`（Client 侧）· `test/evidence/backend-findings.md`（Typert 清单）· `test/evidence/lead-findings.md`（通道排查）
**评审对象**：`index.js` · `lib/writer.js` · `lib/status-store.js` · `lib/vault-index.js`
