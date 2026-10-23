# 测试体系收敛方案（test-suite-plan）

- 生成时间：2026-10-22T19:25+08:00
- 范围：`obsidian-bridge/test/` 全部 27 个文件（20 `.mjs` + 7 `.md`）
- 约束：**本方案只做分类与计划，不执行删除**；不修改插件源码；不修改 `run-all.mjs` 引用的 7 个套件内容
- 行数口径：`node` 读 UTF-8 后 `split('\n')` 计数（末行换行不计），与 `scripts/check-line-counts.mjs:26-29` 一致

---

## 0. 现状核对（先纠正两个数字）

### 0.1 「27 个 .mjs / 272 KB」的准确口径

| 口径 | 数量 | 行数 | 字节 |
|---|---|---|---|
| `.mjs` | 20 | 3617 | 154410 B |
| `.md` | 7 | 2325 | 123930 B |
| **合计** | **27** | **5942** | **278340 B = 271.8 KB** |

「272 KB」= **全部 27 个文件**，不是「27 个 .mjs」。`.mjs` 实际只有 20 个。

### 0.2 被 `run-all.mjs` 引用的套件（7 个，不可动）

`run-all.mjs:69-129` 的 `SUITES` 数组：

| # | 文件 | 行 | 层 | 实测断言数 | 断言 ID / 位置 |
|---|---|---|---|---|---|
| 1 | `contract.mjs` | 189 | L1 | **9**（输出 `契约测试通过 9/9`） | `:126,133,149,169` 四个 `check()` 对 4 个事件展开为 9 条 |
| 2 | `wiring.mjs` | 244 | L2 | **12**（输出 `接线测试全部通过：12 项`） | `:103,114,127,139,149,170,184,195,208,216,241` + 1 |
| 3 | `status-refresh.mjs` | 184 | L2 | **10**（输出 `通过 10/10`） | `:103,110,123,131,138,143,150,158,162,169` |
| 4 | `run.mjs` | 189 | L2 | **18**（输出 `全部通过`，无计数） | `:36,44,49,62,70,77,82,91,98,103,114,118,123,128,131,174,179,185` |
| 5 | `audit-counters.mjs` | 630 | L2 | **55**（输出 `通过 55/55`） | `audit-counters.mjs:216-595`（T*/P*/I*/S*/SS*/G*/IB*/W*/F*/V*/N*） |
| 6 | `acceptance.mjs` | 263 | L3 | **14**（输出 `通过 14/14`） | `:55-248`（FR-1..FR-7, PLUGIN） |
| 7 | `e2e-verify.mjs` | 392 | L3 | **19**（输出 `通过 16/19，失败 0`；16 PASS + 3 MANUAL） | ENV-1..3, G1/G2, M1/M2, E4, P1/P2 |

> 断言数一律**以实测输出为准**（`run-all.mjs` 的 `pass` 正则捕获值），不按代码里的 `check(` 出现次数估算 —— 后者会把注释与嵌套调用算进去。

> `run-all.mjs` 自身（196 行）是**运行器**，不是套件，不在保护范围内（如需接入 audit-flow 才需改动它）。

### 0.3 未被任何套件引用的文件（13 个）

`grep` 全仓 `.mjs` 引用（含 `audit-*` / `count-lines`）**只命中自身**，无外部引用：

```
obsidian-bridge\test\audit-flow.mjs:15,58,795   ← 仅自引用（头部注释/输出文案）
```

即：**12 个 `.mjs` + 7 个 `.md` 均未被 `run-all.mjs` 或任何套件引用**。

---

## 1. 分类表

分类口径：
- **A｜常驻回归守卫**：断言产品行为，纳入 `run-all.mjs` 长期执行
- **B｜证据保留**：有诊断/取证价值，但非常驻；移出 `test/` 到 `test/evidence/`
- **C｜可删除**：一次性探针，结论已由常驻套件覆盖

### 1.1 `.mjs`（20 个）

| 文件 | 行 | 字节 | 分类 | run-all 引用 | 理由 |
|---|---|---|---|---|---|
| `run-all.mjs` | 196 | 7201 | **A**（运行器） | — | 统一入口，不可动 |
| `contract.mjs` | 189 | 7366 | **A** | ✅ L1 | 平台契约（签名/解构合法性），唯一防「按错误约定调用」的套件 |
| `wiring.mjs` | 244 | 9077 | **A** | ✅ L2 | 事件接线 + 子进程调用（已知为「部分连通」级，见 §4.3） |
| `status-refresh.mjs` | 184 | 6957 | **A** | ✅ L2 | 计数器 + 快照写入语义 |
| `run.mjs` | 189 | 7735 | **A** | ✅ L2 | 单元：config/message/query/frontmatter/真实 Vault 索引 |
| `audit-counters.mjs` | 630 | 29107 | **A** | ✅ L2 | 计数器语义 + 面板可见性回归守卫（56 条） |
| `acceptance.mjs` | 263 | 12902 | **A** | ✅ L3 | PRD §9 验收（真实 Vault + 真实 MCP） |
| `e2e-verify.mjs` | 392 | 17486 | **A** | ✅ L3 | 产物与面板数据一致性（见 §4.4 遗留问题） |
| `audit-flow.mjs` | 800 | 32172 | **A（建议接入）** | ❌ **未接入** | 唯一的**控制流守卫**（37 条三态断言，`process.exit(1)` on BUG）。当前**FAIL**（见 §4.1） |
| `count-lines.mjs` | 14 | 574 | **C** | ❌ | 与 `scripts/check-line-counts.mjs` **重复**且更弱（后者 106 行、有守卫、`exit(1)`） |
| `audit-tools-repro.mjs` | 68 | 3209 | **C** | ❌ | 无 assert。其诊断（位置参数 vs 解构）已被 **三重**覆盖（§2.1） |
| `audit-vault-events.mjs` | 41 | 1884 | **C** | ❌ | 无 assert。同类检查由 `e2e-verify.mjs` E1-E5 覆盖 |
| `audit-vault-count.mjs` | 90 | 3422 | **C（有缺口）** | ❌ | 无 assert。索引**能力**已覆盖，但「索引条数 vs Vault 全量 `.md`」对账无常驻断言 |
| `audit-vault-list.mjs` | 47 | 1885 | **C（有缺口）** | ❌ | 无 assert。一次性逐文件取证 |
| `audit-vault-times.mjs` | 55 | 2581 | **C（有缺口）** | ❌ | 无 assert。birthtime/ctime 一次性取证 |
| `audit-tools.mjs` | 52 | 2617 | **C（有缺口）** | ❌ | 无 assert。主机日志工具统计；**无**「插件计数 vs 真实工具调用数」对账 |
| `audit-runs.mjs` | 35 | 1819 | **C（有缺口）** | ❌ | 无 assert。runId↔pid 映射 + 真实 prompt 归属；能力未覆盖 |
| `audit-session.mjs` | 58 | 2488 | **C** | ❌ | 无 assert。会话日志解压计数；真实/注入区分能力已由 `run.mjs:70` 覆盖 |
| `audit-session-all.mjs` | 56 | 2415 | **C** | ❌ | 同上（全量版） |
| `audit-session-shape.mjs` | 32 | 1513 | **C** | ❌ | 无 assert。JSON 结构探查；结构正确性已由 `contract.mjs` 从**平台权威源**校验 |

### 1.2 `.md`（7 个）

| 文件 | 行 | 字节 | 分类 | 理由 |
|---|---|---|---|---|
| `audit-counters.md` | 226 | 14637 | **A（随守卫）** | `audit-counters.mjs` 的结论文档，常驻守卫的配套说明 |
| `e2e-verification.md` | 518 | 27324 | **A（随守卫）** | `e2e-verify.mjs` 的结论文档 |
| `audit-flow.md` | 197 | 15087 | **A（随守卫）** | `audit-flow.mjs` 的结论文档。**§3.3 决定：守卫已接入 `run-all`，其结论文档随守卫保留在 `test/`**，不迁入 evidence |
| `audit-panel-fields.md` | 522 | 20868 | **B → `test/evidence/`** | 面板字段真实性审计（一次性），结论已由 `audit-counters.mjs` V1-V9 守卫承接 |
| `backend-findings.md` | 355 | 18213 | **B → `test/evidence/`** | 后端 Typert 清单注册排查（一次性） |
| `frontend-findings.md` | 433 | 23980 | **B → `test/evidence/`** | Client 取数链路排查（一次性） |
| `lead-findings.md` | 74 | 3821 | **B → `test/evidence/`** | 数据通道断点排查（一次性） |

---

## 2. 可删除项的删除前检查清单

> 前置条件：**每一项都必须先跑一遍 `run-all.mjs` 确认全绿**，再执行删除。删除后重跑一次。

### 2.1 `audit-tools-repro.mjs`（68 行）→ 删除

它建立的唯一事实：`tools/result` 的处理器若写成 `({ exec }) => {}` 解构，会因 DSH 派发位置参数 `(exec, result)` 而静默失效。

| 覆盖方 | 位置 | 断言内容 |
|---|---|---|
| `contract.mjs` | `:133-140` | 处理器形参数 == 平台声明数 |
| `contract.mjs` | `:149-165` | **解构合法性**：解构形式的形参，平台必须声明为对象类型，否则「解构非对象参数会得到 undefined，处理器将静默失效」 |
| `contract.mjs` | `:169-176` | `tools/result 是位置参数事件（防回归）` |
| `wiring.mjs` | `:155,170` | 按**真实位置参数**调用并断言 post-tool 留痕 |
| `audit-flow.mjs` | `:414-420` | 断言签名必须是位置参数 `(exec, result)` |

**结论**：5 处覆盖，可安全删除。

### 2.2 `audit-vault-events.mjs`（41 行）→ 删除

它按条目解析当日 Vault 日志并分类统计（user-prompt / stop / session-start / tool / injection）。

| 覆盖方 | 位置 | 断言内容 |
|---|---|---|
| `e2e-verify.mjs` | E1 | `会话开始` 小节存在于当日 conversation 日志 |
| `e2e-verify.mjs` | E2 | `用户 prompt:` 小节 |
| `e2e-verify.mjs` | E3 | `对话结束` 小节 |
| `e2e-verify.mjs` | E4 | 注入块含真实笔记路径且文件存在 |
| `e2e-verify.mjs` | E5 | 子进程 `triggered`/`completed` 配对 |

**结论**：5 处覆盖，可安全删除。

### 2.3 `audit-session.mjs` / `audit-session-all.mjs` / `audit-session-shape.mjs`（58 / 56 / 32 行）→ 删除

它们建立的事实：DSH 会话日志是 zstd 压缩的 JSONL；真实用户消息与注入消息可按 `source.kind` 区分。

| 覆盖方 | 位置 | 断言内容 |
|---|---|---|
| `run.mjs` | `:70` | `isRealUserMessage 能区分真实用户输入与注入消息` |
| `run.mjs` | `:77` | `isSubagent 识别子代理` |
| `e2e-verify.mjs` | E4 | 注入块路径真实存在（证明 `source.kind === 'runtime-context'` 的注入真的产生了内容） |

**结论**：能力已覆盖；三个探针仅做**全量计数**（一次性诊断），可删除。

### 2.4 `audit-vault-count.mjs` / `audit-vault-list.mjs` / `audit-vault-times.mjs`（90 / 47 / 55 行）→ 删除，**但需先补 1 条常驻断言**

它们建立的事实：按 `vault-index.js` 规则（`SCAN_ROOTS` + 隐藏项 + 256KB + 深度 8）复算的索引条数，与 Vault 全量 `.md` 数**不一致**（差异来自 `00_InteractionLogs`/`90_Agent` 之外的目录与过滤规则）。

| 覆盖方 | 位置 | 断言内容 | 覆盖程度 |
|---|---|---|---|
| `run.mjs` | `:174` | `buildVaultIndex 扫描真实 Vault -> N 条（ok=...）` | ✅ 索引能力 |
| `e2e-verify.mjs` | F2 | `index.size` 等于索引条数 | ✅ 快照字段 |
| `run.mjs` | `:36-44` | `resolveConfig` 默认值含 `SCAN_ROOTS` 语义 | ✅ 配置 |

**缺口**：**没有任何常驻断言**校验「索引条数 == Vault 中符合规则的 `.md` 总数」。探针的结论（差异分布）是一次性事实，但**对账能力**没有沉淀。

**建议**：删除前，在 `run.mjs` 的真实 Vault 索引测试（`:165-186`）后补一条：

```js
// 索引条数必须等于按 SCAN_ROOTS 规则独立复算的条数
const expected = await recountByRules(VAULT);   // 独立实现，不复用 vault-index.js
assert.equal(index.length, expected);
```

### 2.5 `audit-tools.mjs`（52 行）→ 删除，**但需先补 1 条常驻断言**

它建立的事实：从主机日志统计真实工具调用数，并按插件关键词规则预判「相关」调用数。

| 覆盖方 | 位置 | 断言内容 | 覆盖程度 |
|---|---|---|---|
| `audit-counters.mjs` | T1-T5 | `toolEvents` 每次 +1、边界、开关 | ✅ **插件侧计数** |
| `wiring.mjs` | `:170,184` | 真实位置参数下 post-tool 留痕 + `toolEvents` 记录工具名 | ✅ |
| `status-refresh.mjs` | `:123-150` | 相关/不相关/空参数均 +1 | ✅ |

**缺口**：**没有任何常驻断言**把「插件 `toolEvents` 计数」与「会话中真实发生的工具调用数」对账。用户最初报的正是「工具调用事件恒为 0」——当时就是缺这条对账。

**建议**：删除前，在 `e2e-verify.mjs` 增加一条 L3 断言：读当日会话日志的 `tools/result` 事件数，与面板/快照的 `counters.toolEvents` 比对（容忍启动后的新增）。

### 2.6 `audit-runs.mjs`（35 行）→ 删除，**有缺口但建议接受**

它建立的事实：`runId` ↔ host pid ↔ 时间范围；每条真实用户 prompt 属于哪个 runId。

**缺口**：`runId` 归因能力没有任何常驻测试覆盖。但该能力**只用于人工诊断**（把日志条目归到某次进程运行），产品行为不依赖它。

**建议**：接受缺口，直接删除；若日后需要，可按同样方式重写（代码仅 35 行）。

### 2.7 `count-lines.mjs`（14 行）→ 删除（重复）

```js
// test/count-lines.mjs:3-12 —— 硬编码 4 个文件名，只打印，无断言
const files = ['RETROSPECTIVE', 'RELEASE-1.0', 'DOC-IMPROVEMENT-PLAN', 'BEST-PRACTICES'];
```

**覆盖方**：`scripts/check-line-counts.mjs`（106 行）

| 对比项 | `test/count-lines.mjs` | `scripts/check-line-counts.mjs` |
|---|---|---|
| 统计对象 | 硬编码 4 份文档 | `docs/` 全部 `.md` + 插件代码 |
| 行数口径 | `split('\n').length - (endsWith('\n')?1:0)` | 同（`:26-29`，并注释说明 gb2312 失真事故） |
| 守卫 | 无 | **有**：核对 `docs/` 中 `（NNN 行）` 声明与实测一致，不符 `exit(1)`（`:99-105`） |
| 被引用 | ❌ | ❌ |

**结论**：功能被完全覆盖且更严格，可安全删除。

---

## 3. `audit-flow.mjs` 处置建议（唯一需要决策的项）

### 3.1 现状：它是真守卫，但当前 FAIL

- 结构：37 条三态断言（OK/BUG/WARN/INFO），`process.exit(results.some(r => r.status === 'BUG') ? 1 : 0)`（`:799`）
- 实测：`合计：BUG 1 / WARN 3 / OK 33 / INFO 0`，**exit 1**

### 3.2 BUG H1 是**审计脚本的误报**，不是产品缺陷

```js
// audit-flow.mjs:726-732
report('H1 重载后快照短暂保留旧计数', ...,
  '新实例首次取数应反映新实例的计数（全 0）',
  `旧实例=${...}；新实例 apply 后立刻=${...}`,
  immediate.sessionStarts !== 0 || immediate.indexBuilt !== 0,   // ← BUG 判定条件
);
```

实测输出：

```
旧实例    = {"sessionStarts":1,"indexBuilt":1,...}
新实例立刻 = {"sessionStarts":0,"indexBuilt":1,...}
```

- `sessionStarts` **1 → 0**：说明 `resetStore()`（`lib/status-store.js:63-67` + `index.js:102`）**已生效**，旧计数不再泄漏 ✅
- `indexBuilt` = 1：是**新实例自己在 `apply()` 里 `ensureIndex()` 构建索引**记录的（`index.js` 启动路径），属**合法**的新计数，不是泄漏

即：H1 的意图「全 0」**写错了** —— 事件类计数应回到 0，但 `apply()` 自身会递增的计数器（`indexBuilt` / `indexFailed` / `organizeRuns` / `organizeFailed`）不应要求为 0。

**修法**（改审计脚本，不改产品）：把判定条件收窄为「事件类计数是否泄漏」：

```js
const LEAKY = ['prompts', 'injections', 'toolEvents', 'stops', 'sessionStarts', 'writeFailures'];
immediate && LEAKY.every((k) => (immediate[k] ?? 0) === 0)
```

### 3.3 建议路径

1. 先按 §3.2 修 `audit-flow.mjs` 的 H1 判定（仅此一处，产品不动）
2. 重跑确认 `BUG 0`（WARN 3 不影响 exit code）
3. 把 `audit-flow.mjs` 作为 **L2** 接入 `run-all.mjs` 的 `SUITES`，`pass` 正则用 `/合计：BUG (\d+) \/ WARN (\d+) \/ OK (\d+)/`，`failed` 取 BUG 数
4. `audit-flow.md` 随之保留在 `test/`（不再移入 evidence）

**为什么强烈建议接入**：它是唯一覆盖**守卫顺序 / 副作用可见性 / 静默失败 / 状态泄漏 / 注释与实现一致性**的套件。目前这些语义**只由这一个脚本守着**，而它恰好在跑 `run-all` 时不会被执行 —— 等于这套断言实际处于「休眠」状态。

---

## 4. 风险与注意事项

### 4.1 `audit-flow.mjs` 当前 FAIL —— **不要直接接入 `run-all`**

若在 H1 修好前接入，`run-all` 会立即全红。务必按 §3.3 顺序执行。

### 4.2 删除后重跑 `run-all` 是**唯一**验收标准

`run-all.mjs:132-161` 逐套件 `execFileSync` 并据输出正则判定 PASS/FAIL；`:191` 有任何 FAIL 就 `exit(1)`。删除动作本身不影响它，但**必须重跑一次**确认 7 个套件仍全绿。

### 4.3 `wiring.mjs` / `status-refresh.mjs` 是已知的「部分连通」级守卫

我在 2026-10-21 的审计中确认：`wiring.mjs` 用 mock `ctx.subprocess.spawn`（`:53-70`），断言的是「构造了 spawn 请求」而非「字节写进 Vault」。**这是设计取舍**（L2 层不碰真实 Vault），不是缺陷，**不要**在本次收敛中改动它们（保护范围）。但建议日后在 `e2e-verify.mjs` 补一条「子进程真的 exit 0 且产物存在」的断言来补上这层。

### 4.4 `e2e-verify.mjs` 的 P1/P2 已失效（需单独决策）

`e2e-verify.mjs:331-364` 的 HTTP 探针请求 `/obsidian-bridge/status` —— 该路由已在 v1.0.0 **移除**（`wiring.mjs:241` 断言「HTTP 状态路由与 webServer 依赖已移除」）。

现状（实测 `e2e-verify.mjs` 输出）：**16 PASS / 0 FAIL / 3 MANUAL**

| 项 | 状态 | 性质 |
|---|---|---|
| `E4` 知识注入带真实笔记路径 | `MANUAL` | **刻意的**：依赖当日 conversation 日志里恰好有注入块（`e2e-verify.mjs:131` 注释「标为 MANUAL 并给出复现命令，而不是判 FAIL」）。属日期依赖，合理 |
| `P1` `GET /obsidian-bridge/status` | `MANUAL` | **失效**：路由已删除，需 `DSH_LAUNCH_TOKEN` 才执行，因此永不真正运行 |
| `P2` 快照计数随真实事件增长 | `MANUAL` | 同上，依赖 P1 |

P1/P2 恒为 `MANUAL` → **永远不真正执行，也永远不 FAIL** —— 一条静默失效的测试。

**建议**：把 P1/P2 改为探测 Typert Remote 侧（例如读面板实际渲染值），或直接移除。**该项需 lead 决策**，本方案不执行。

### 4.5 行数口径

本方案所有行数均按 `node` + `split('\n')` 统计（末行换行不计）。PowerShell 5.1 的 `Get-Content | Measure-Object -Line` 在中文 UTF-8 文件上会因 **gb2312 解码**失真 —— 见 `scripts/check-line-counts.mjs:6-17` 记录的事故。**统计行数请一律用 `node`**。

---

## 5. 建议执行顺序

### 5.0 基线（已实测，2026-10-22T19:25+08:00）

```
$ node test/run-all.mjs
  L1 契约      ✅ 契约测试通过 9/9
  L2 接线      ✅ 接线测试全部通过：12 项
  L2 状态刷新  ✅ 通过 10/10
  L2 单元      ✅ 全部通过
  L2 计数器审计 ✅ 通过 55/55
  L3 验收      ✅ 通过 14/14
  L3 产物一致性 ✅ 通过 16/19，失败 0
  通过 7 ｜ 失败 0 ｜ 跳过 0（共 7 套件）     exit 0
```

**基线全绿**，可作为删除前的对照。

> 注意 `contract.mjs` 实测 **9/9**（`contract.mjs:187` 的输出），而 §0.2 表按代码结构数出 4 个 `check()` 调用点 —— 因为 `:117-166` 的循环对 4 个事件各跑 2~3 条断言，实际展开为 9 条。**断言数以实测输出为准。**

### 5.1 执行步骤

| 步 | 动作 | 影响面 | 验收 |
|---|---|---|---|
| 0 | ✅ 已完成：跑 `node test/run-all.mjs` 记录基线 | — | **7/7 全绿**（见 §5.0） |
| 1 | 修 `audit-flow.mjs` 的 H1 判定（§3.2） | 1 文件 | `BUG 0` |
| 2 | 接入 `run-all.mjs` 的 L2（§3.3-3） | 1 文件（运行器） | `run-all` 全绿且含 audit-flow |
| 3 | 补 2 条常驻断言（§2.4 索引对账、§2.5 工具对账） | `run.mjs` + `e2e-verify.mjs` | 新增断言 PASS |
| 4 | 删除 **11** 个探针（§2.1-2.3, §2.6-2.7） | 11 文件 | `run-all` 全绿 |
| 5 | 移动 **4** 份 `.md` 到 `test/evidence/`（§1.2） | 4 文件 | 无引用断裂 |
| 6 | 终跑 `node test/run-all.mjs` + `node scripts/check-line-counts.mjs` | — | 全绿 |

> **两处对原方案的修正**（执行时发现，已按更合理者执行）：
> 1. **删除 11 个而非 10 个** —— 原步骤 4 写「10 个」是笔误；§2.1-2.7 实际列出 11 个（`count-lines.mjs` + 3 个 `audit-session*` + 3 个 `audit-vault*` + `audit-tools.mjs` + `audit-tools-repro.mjs` + `audit-vault-events.mjs` + `audit-runs.mjs`）。
> 2. **移动 4 份而非 5 份** —— `audit-flow.md` 按 §3.3 随已接入 `run-all` 的守卫保留在 `test/`，故 B 类实际迁出 4 份。

**最终形态**：`test/` 保留 10 个 `.mjs`（8 常驻套件 + 运行器 + `audit-flow`）+ 4 份 `.md`（3 份随守卫 + 本方案）；`test/evidence/` 存放 4 份历史 findings。
**共减少 11 个文件（548 行 / 24407 B）+ 迁出 4 份文档（1485 行 / 66920 B）。**

---

## 6. 明确不做的事

- 不修改 `contract / wiring / status-refresh / run / audit-counters / acceptance / e2e-verify` 这 7 个套件的**任何内容**
- 不修改 `run-all.mjs` 引用的套件清单（除非执行 §3.3 的 audit-flow 接入）
- 不修改任何插件源码（`index.js` / `lib/*` / `client.js` / `cordis.patch.yml`）
- 不执行任何删除或移动 —— **等确认**

---

## 7. 执行记录（2026-10-22T19:45+08:00）

### 7.0 回滚点

`obsidian-bridge/` 已 `git init` 并做基线提交（**删除前**）：

```
0b03977  baseline: test-suite-convergence (pre-cleanup)
```

`.gitignore` 本会排除全部 `test/audit-*` 与 `test/*-findings.md`，因此基线提交时
用 `git add -f` 强制纳管，否则删除将不可回滚。**任一删除项都可用
`git checkout 0b03977 -- <path>` 单独恢复。**

### 7.1 步骤 1：修 `audit-flow.mjs` 的 H1 判定

`:726-748` 新增 `LEAKY_COUNTERS` 常量并把判定条件从
`immediate.sessionStarts !== 0 || immediate.indexBuilt !== 0`
收窄为 `LEAKY_COUNTERS.some((k) => (immediate[k] ?? 0) !== 0)`。

结果：`BUG 0 / WARN 3 / OK 34`（原 `BUG 1`），`exit 0`。

### 7.2 步骤 2：接入 `run-all.mjs`

- `run-all.mjs` 新增 L2 套件条目（`audit-flow.mjs`），`pass` 正则匹配
  `合计：BUG (\d+) \/ WARN (\d+) \/ OK (\d+) \/ INFO (\d+)（共 (\d+) 条）`。
- **同时修正了运行器的失败数解析**：原实现硬取正则**第 3 组**当失败数，而本套件
  的第 3 组是 OK 数（34）—— 若不修，`run-all` 会把全绿的 audit-flow 判成 FAIL。
  改为支持 `failedGroup` 字段（默认 3，本套件设为 1 = BUG 数）。

结果：`run-all` **8 套件全绿**。

### 7.3 步骤 3：补 2 条对账断言

| 断言 | 位置 | 结果 |
|---|---|---|
| 索引条数 == 按 `SCAN_ROOTS` **独立复算**的 `.md` 数 | `run.mjs:187-222` | ✅ `433 条，跳过 dot=1/oversize=1` |
| 真实派发链对账：工具留痕 > 0 且 ≤ 真实工具执行数 | `e2e-verify.mjs` M3 | ✅ `真实工具执行=747，工具留痕=168` |

> 关于「插件 `toolEvents` == 真实工具调用数」：**不可自动化**，已作为 `M4` 显式 SKIP
> 并写明原因 —— 计数器只在 Host 进程内存（`lib/status-store.js:14`），不落盘、不写日志；
> 面板经 Typert Remote 读取，而启动令牌是进程内随机值
> （`dsh-client-connection/lib/index.js:294-300` 的 `PROCESS_LAUNCH_TOKENS`，从不写盘，
> 日志里也无 `token=`）。外部脚本拿不到，故不假装在测。

### 7.4 步骤 4：删除 11 个探针

删除前逐项用脚本核对覆盖（见 §2.1-2.7），**全部确认后才删**：

| 文件 | 行 | 字节 | 覆盖确认 | 回滚方式 |
|---|---|---|---|---|
| `test/audit-tools-repro.mjs` | 68 | 3209 | 4 处（contract×2 / wiring / audit-flow） | `git checkout 0b03977 -- test/audit-tools-repro.mjs` |
| `test/audit-vault-events.mjs` | 41 | 1884 | 4 处（e2e-verify E1-E5） | 同上 |
| `test/audit-session.mjs` | 58 | 2488 | `run.mjs:70` | 同上 |
| `test/audit-session-all.mjs` | 56 | 2415 | `run.mjs:70` | 同上 |
| `test/audit-session-shape.mjs` | 32 | 1513 | `contract.mjs`（平台权威源） | 同上 |
| `test/audit-vault-count.mjs` | 90 | 3422 | `run.mjs` 索引对账（本次新增） | 同上 |
| `test/audit-vault-list.mjs` | 47 | 1885 | `run.mjs` 真实 Vault 索引 | 同上 |
| `test/audit-vault-times.mjs` | 55 | 2581 | `run.mjs` 索引对账 | 同上 |
| `test/audit-tools.mjs` | 52 | 2617 | `e2e-verify.mjs` M3（本次新增） | 同上 |
| `test/audit-runs.mjs` | 35 | 1819 | **无覆盖** —— lead 决策「接受缺口」 | 同上 |
| `test/count-lines.mjs` | 14 | 574 | `scripts/check-line-counts.mjs`（有守卫） | 同上 |
| **合计** | **548** | **24407** | | |

### 7.5 步骤 5：迁移 4 份文档 + 同步引用

`git mv`（git 识别为 rename）：

```
R  test/audit-panel-fields.md -> test/evidence/audit-panel-fields.md
R  test/backend-findings.md   -> test/evidence/backend-findings.md
R  test/frontend-findings.md  -> test/evidence/frontend-findings.md
R  test/lead-findings.md      -> test/evidence/lead-findings.md
```

同步更新的引用：

| 文件 | 改动 |
|---|---|
| `scripts/prepare-github.mjs` | `PUBLISH_EXCLUDE` 的 4 个键改为 `test/evidence/...`；删除 10 条已删脚本的陈旧键 |
| `scripts/prepare-github.mjs` | `PUBLISH_INCLUDE` 移除已删的 `test/count-lines.mjs`（能力由 `scripts/check-line-counts.mjs` 承载，`scripts/` 在发布集内） |
| `test/test-suite-plan.md` | §1.2 分类表、§5.1 步骤 4/5 的数量修正、本节 |

回滚：`git checkout 0b03977 -- test/audit-panel-fields.md`（其余同理），或
`git revert` 本次提交。

### 7.6 步骤 6：终跑

见 §7.7。

### 7.7 执行期间发现的额外事项（不在批准范围内，仅记录）

1. **`test/knowledge-quality.mjs`（421 行）** —— 基线提交后才出现的新守卫，
   覆盖 `90_Agent/knowledge-organize.js` 的治理逻辑。**当前 FAIL（7 PASS / 8 FAIL）**，
   且**未接入 `run-all`**。不在本次批准范围内，未改动。
2. **`e2e-verify.mjs` 的 `P1/P2`** 已按 lead 决策改为**显式 SKIP** 并写明原因
   （原为「需 token 才执行」的隐性失效）。
3. **`run-all.mjs` 的失败数解析**存在通用缺陷（见 §7.2），本次顺带修正。
