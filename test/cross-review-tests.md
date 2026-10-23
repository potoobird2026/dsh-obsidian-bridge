# obsidian-bridge 测试套件 —— 断言审计 + 覆盖率缺口 + 交叉验证

评审人：resolve-probe（只读评审，**未修改任何测试文件**）
日期：2026-10-22
评审对象：`test/` 下 8 个套件（`run-all.mjs` 实际挂载的 8 个）+ 2 个未挂载脚本
评审输入：`D:/MyVault/10_Projects/WorkBuddy-Obsidian-Bridge/04-最佳实践.md`、`01-开发复盘.md`、`docs/BEST-PRACTICES.md`

> **证据分级**：本文每条结论标注 **[已验证]**（有命令输出）/ **[推断]**（有源码行号但无实跑）/ **[证据不足]**。
> 覆盖率数字全部来自**实际运行**（`NODE_V8_COVERAGE` + 自写解析器），不是估算。

> ## ⚠️ 评审期间目标文件被并发修改（重要）
>
> 本次评审是**只读**的，但工作区在评审期间被其他协作者改动，因此本文数字对应**特定修订**：
>
> | 文件 | 评审开始时 | 评审期间 | 本文数字对应 |
> |---|---:|---:|---|
> | `index.js` | 489 行 | **536 行** | 489 行修订 |
> | `lib/vault-index.js` | 146 行 | **162 行** | 146 行修订 |
> | `test/coverage.mjs` | 200 行 | 已重写（行号位移） | 见 §1.3 的两组数字 |
> | `test/run.mjs` | 238 行 | 254 行 | 238 行修订（FP-3 的行号在 254 行修订下仍为 `:187-191`，已复核） |
>
> 结论：**行号可能随修订漂移，但缺陷机制（口径、零断言、硬编码 `false`）在两次修订下都存在** —— §1.3 对两个修订各测了一次。

---

## 0. 评审方法

```
# 1) 全量跑一遍，确认基线
$env:NODE_V8_COVERAGE = "$env:TEMP\ob-cov"; node test/run-all.mjs
# 2) 逐套件各跑一次（每套件独立 coverage 目录，避免跨套件串味）
node <tmp>/ob-cov3.mjs <ROOT> "$env:TEMP\ob-cov-per"
# 3) 解析 V8 coverage，按 realpath 归并
node <tmp>/ob-cov4.mjs / <tmp>/ob-cov5.mjs
```

**基线（实测）**：`通过 8 ｜ 失败 0 ｜ 跳过 0（按设计 0 / 环境缺失 0）（共 8 套件）`
—— 见 `test/run-all.mjs:235` 的输出格式，本次运行 0 FAIL。

**V8 区间语义（已用受控实验标定，非推测）**

在 `%TEMP%\cov-cal2\t.mjs` 上实跑，V8 对 `function branch(x){ if(x){...} else {...} }` 报告：

```
fn "branch" blk true L1-L6:c1 | L4-L6:c0
```

即：`ranges[0]` = **函数自身跨度**（count = 被进入次数）；`ranges[1..]` = 内部块（各自 count）。
推论：**把 `ranges[0]` 当行覆盖，等于「函数被调用过」就把它体内每一行都算覆盖**。
这是本项目 `test/coverage.mjs` 的口径缺陷（见 §2.1）。

---

## 1. 覆盖率实测（真实数字）

### 1.1 插件本体行覆盖（逐套件并集）

| 文件 | 覆盖/总行 | 覆盖率 | 函数进入 | 各套件覆盖行数 |
|---|---:|---:|---:|---|
| `lib/config.js` | 111/111 | **100.0%** | 9/9 | wiring:110 status-refresh:111 run:111 |
| `lib/status.js` | 85/86 | 98.8% | 10/10 | wiring:85 status-refresh:85 |
| `lib/message.js` | 76/78 | 97.4% | 18/22 | wiring:76 status-refresh:48 run:75 |
| `lib/query.js` | 116/128 | 90.6% | 13/21 | wiring:112 status-refresh:38 run:115 |
| `lib/vault-index.js` | 126/146 | 86.3% | 12/15 | wiring:124 status-refresh:71 run:124 |
| `lib/status-store.js` | 61/72 | 84.7% | 13/14 | wiring:57 status-refresh:61 |
| `lib/writer.js` | 113/154 | 73.4% | 20/26 | wiring:113 status-refresh:113 |
| `index.js` | 353/489 | 72.2% | 48/84 | wiring:251 status-refresh:348 |
| `lib/bridge-service.js` | 40/65 | 61.5% | 4/10 | wiring:40 status-refresh:40 |
| **`client.js`** | **0/345** | **0%** | — | **无任何套件执行** |
| **`typert.host.js`** | **0/77** | **0%** | — | **无任何套件执行** |

### 1.2 未覆盖行（并集，节选）

```
index.js (136/489 未覆盖)
  62-70, 72-74, 78-85,      <- lastAssistantText 的两个 catch 与第二段兜底
  113-115, 125, 176,        <- 常量/导出
  190-191, 201, 207-211,    <- ensureIndex 的 fresh 判定与 catch
  244-255,                  <- countMcpTools 的 null 分支与 catch
  294,                      <- agent/created 的 isSubagent 守卫
  304-373,                  <- agent/pre-step 处理器主体（含注入、diagnose）
  398, 408, 422-430, 446,   <- tools/result 的归一/留痕/降噪分支
  464, 466, 476, 480-482, 484, 488  <- maybeOrganize 全部分支

lib/writer.js (41/154 未覆盖)
  29-39, 50, 64-66, 84-93, 103-107, 110-111, 114-117, 120-123, 132

lib/bridge-service.js (25/65 未覆盖)
  33-56, 61                 <- mountBridgeService 的 import + ctx.plugin 全部路径
```

### 1.3 覆盖率工具本身的缺陷 **[已验证]**

`test/coverage.mjs:115-120`（评审开始时修订为 `:114-120`）把**所有** `count > 0` 的 range（含 `ranges[0]`）都算作行覆盖：

```js
for (const range of fn.ranges ?? []) {
  if (range.count > 0) {
    coveredOffsets.add(`${range.startOffset}-${range.endOffset}`);
  }
}
```

**同一份 coverage 数据、同一个文件，两种算法的实测对照**（`%TEMP%\ob-cov-per\wiring`，输入完全相同）：

| `index.js` 修订 | `test/coverage.mjs` | 函数跨度感知算法 | 虚高 |
|---|---:|---:|---:|
| 489 行（评审开始时） | **410/489 = 83.8%** | **251/489 = 51.3%** | 159 行 / **32.5pp** |
| 536 行（评审期间重写后） | **410/536 = 76.5%** | **253/536 = 47.2%** | 157 行 / **29.3pp** |

两个修订下虚高幅度稳定在 **29–33 个百分点**。机制：`index.js` 的模块顶层 `ranges[0]` 跨度为整个文件（实测 `0-17160` 字节），
只要模块被求值一次，就把整个文件标记为「跑过」。

> **这条直接违背用户要求 1**（「对每一行代码做完整测试，不跳过任何一条线」）——
> 因为**测量工具本身在放大覆盖率**。`test/coverage.mjs` 的收尾提示写着
> 「高覆盖率 + 弱断言 = 假阳性」，但它的口径正是「高覆盖率」的来源之一。

---

## 2. 断言审计表

图例：**FP** = 能写出「应该 FAIL 但会 PASS」的输入（假阳性）；**FN** = 断言过松（假阴性）；
**DUP** = 重复覆盖；**ENV** = 依赖环境偶然性。

### 2.1 已确认的假阳性（FP）

| # | 位置 | 问题 | 验证方式 | 级别 |
|---|---|---|---|---|
| **FP-1** | `test/contract.mjs:121-124` + `:171` | `findSignature` 返回 null 时，事件被 `skipped.push(...)` 后 `continue`，**不产生任何 check**；而 `:169-176` 的「tools/result 是位置参数事件」在 `!sig` 时 `return`，**仍记 PASS**。若 DSH 目录在但 `api-catalog.js` 缺失/改名，4 条签名检查全部消失，套件仍报「通过 1/1」、退出码 0 | **已实测**：`DSH_APP_DIR` 指向空目录 → 输出 `契约测试通过 1/1`，`exit 0`；经 `run-all.mjs` 后显示 `✅ 契约：事件处理器签名与平台声明一致` | **高** |
| **FP-2** | `test/coverage.mjs:115-120`（评审期间重写后行号） | 把 `ranges[0]`（函数跨度）当行覆盖 → 见 §1.3，两个修订下分别虚高 32.5pp / 29.3pp | 已实测（§1.3，两次修订各测一次） | **高** |
| **FP-3** | `test/run.mjs:187-191` | **零断言**：`ok('真实 Vault 关键词检索')` 之前只有一串 `console.log`，没有任何 `assert`。`results.length === 0` 也照样 PASS | 读源码即可确认（`:187-191` 无 `assert`） | **高** |
| **FP-4** | `test/audit-flow.mjs:320`（A11）、`:527`（C2）、`:540`（C3）、`:768`（I1）、`:780`（I2） | 5 处 `report(..., false)` 把 `isBug` **硬编码**。其中 A11/C2/C3 明明已经算出了 `actual`（`ctx.listDirCalls`、`ctx.warnings`），却不参与判定。headline「BUG 0 / 37 条」里有 5 条**结构上不可能**是 BUG | 读源码 + `grep -n "^\s*false,$"` | **高** |
| **FP-5** | `test/audit-flow.mjs:762-769`（I1） | 注释一致性检查：`idx = lines.findIndex(l => l.includes('按阈值触发治理'))`，注释被删 → `idx = -1` → 标题变成 `index.js:0 注释…`，`isBug` 仍为 `false` → **永远 OK** | 读源码 | 中 |
| **FP-6** | `test/audit-counters.mjs:476-490`（V1/V2） | **文本级断言伪装成行为断言**：`clientSrc.matchAll(/counters\.(\w+)/g)` 只证明「`client.js` 源码里出现了 `counters.X`」，**不证明面板真的会渲染它**。把渲染代码放进一个永不执行的分支，V1/V2 照样 PASS。（已排除「注释也能满足」这一更强说法：实测 `client.js` 的 29 行注释里**没有一行**含 `counters`，所以 FP 机制不是注释，而是「源码存在 ≠ 运行时可渲染」） | 读源码 + `Select-String` 实测 | 中 |
| **FP-7** | `test/wiring.mjs:236-247` | 第二次 `import(index.js + '?route=1')` 之后，mock 的 `ctx.on` 会**覆盖** `listeners[...]`。该 fresh 实例的处理器此后再未被调用，`routes.length === 0` 只证明「没注册路由」，不证明路由逻辑被测过 | 读源码 | 低 |

### 2.2 已确认的假阴性 / 覆盖缺口（FN）

| # | 位置 | 问题 | 级别 |
|---|---|---|---|
| **FN-1** | `test/run-all.mjs:85-166` | **8 个套件里没有 `test/knowledge-quality.mjs`（23 KB）也没有 `test/coverage.mjs`**。前者是知识整理质量门的唯一实现，后者是覆盖率工具。二者都不进 gate | **高** |
| **FN-2** | 全域 | **`lastAssistantText`（`index.js:55-90`）零覆盖**：`grep -n 'lastAssistantText\|stops.*response' test/*.mjs` → **0 命中**。两处 `catch {}`（`:72`、`:86`）静默返回 `''`，后果是 Vault 的 `stop` 小节没有摘要，而 `stops` 计数仍 +1（**有计数、无产物的静默失败**） | **高** |
| **FN-3** | 全域 | **`maybeOrganize` / `knowledge-organize-cursor.json` 零断言**：`grep -n 'knowledge-organize-cursor\|maybeOrganize\|organizeRuns\|organizeFailed' test/*.mjs` → 只有 3 条**注释**（`audit-flow.mjs:724`、`wiring.mjs:252,254`）。`wiring.mjs:250-268` 只核对 `createRunner()` 的**导出表**，没有任何断言验证 `maybeOrganize()` 真的跑起来、游标文件真的出现 | **高** |
| **FN-4** | 全域 | **`obsidian-local` 硬编码 vs `cordis.patch.yml:31` 的 `serverName` 无一致性断言**：`audit-counters.mjs:575-576` 把 `mcp__obsidian-local__*` 写死在 mock 里，而 `index.js:48` 的 `OBSIDIAN_MCP_SERVER = 'obsidian-local'` 与 `cordis.patch.yml:31` 的 `serverName: obsidian-local` 是**三处独立审计**（当前三者恰好一致）。任一处漂移 → `countMcpTools`（`index.js:249-255`）静默返回 0，面板显示「未加载」而不报错。**没有任何断言把三者绑在一起** | 中 |
| **FN-4b** | 全域 | **`client.js`（345 行）与 `typert.host.js`（77 行）运行时覆盖率为 0**：8 个套件里没有任何一个在 Node 里执行过 Client 半边（它走 `window.__ModuleLoader__.load`，见 `client.js:7-11`）。Client 半边目前**只被文本断言**（V1–V4/V8/N6–N8）覆盖 —— 即「源码里写了」而非「跑起来对」 | **高** |
| **FN-5** | `test/audit-flow.mjs:101` | mock 的 `effect() {}` **丢弃 disposer**，因此无法发现「disposer 从未注册」的泄漏（`04-最佳实践.md:117` 记为坑 3 的次生危害）。对照 `audit-counters.mjs:106-108` 是记录 `effects` 的 | 中 |
| **FN-6** | `test/audit-flow.mjs:193` | `ctx.warnings.length = 0; // 丢弃 mountBridgeService 的降级告警` —— 若 `mountBridgeService` 回归为「永远失败」，`ctx.logger.warn` 会被调用然后**立刻被清空**，套件保持全绿 | 中 |
| **FN-7** | `test/e2e-verify.mjs:384`（M4） | 唯一能把「计数器 == 真实工具调用数」对账的项被**显式 SKIP**，理由写明「计数器本身无法外部读取」。于是计数器真实性只在 mock-ctx 套件里成立 | 中 |
| **FN-8** | `test/audit-counters.mjs:214,219,224,230,241` | 用**对象载荷** `{ exec: {...} }` 调 `tools/result`，走的是 `index.js:403-405` 的**防御性归一**分支；真实派发形态是位置参数 `(exec, result)`（`index.js:397`）。真实形态只有 `wiring.mjs:165` 与 `audit-flow.mjs:415` 覆盖 | 中 |
| **FN-9** | `test/audit-flow.mjs:174` | fixture 用 `governance: { everyStops: 10 }`，而 `audit-counters.mjs:167` 用 `governance: { documented: true }`。`everyStops` 是被 V9/N1 明令清除的死键 —— **两个套件对同一配置的形状不一致** | 中 |

### 2.3 环境依赖（ENV）

| # | 位置 | 依赖 | 缺失时行为 |
|---|---|---|---|
| ENV-1 | `test/wiring.mjs:106-108` | 真实 Vault 必须有能命中关键词的笔记，`decision.messages.length === 2` 才成立 | `run-all.mjs` 把 wiring 标为 `optionalInfra`（`:104`），无 Vault 时 SKIP，**不会误判 PASS**（设计正确） |
| ENV-2 | `test/run.mjs:179` | `assert.ok(index.length > 0)` 依赖真实 Vault 非空 | 同上（`run-all.mjs:122` 标 `optionalInfra`） |
| ENV-3 | `test/run.mjs:229-234` | 索引条数对账**硬编码** `SCAN_ROOTS = ['30_Resources','10_Projects','00_InteractionLogs','00_MOC']`（`:221`），未从 `lib/vault-index.js` 导入 | 源码改 `SCAN_ROOTS` → 测试**响亮 FAIL**（可接受），但两份规则并存本身是 DUP |

### 2.4 文档漂移（非断言，但削弱审计可用性）

| # | 位置 | 问题 |
|---|---|---|
| DOC-1 | `test/audit-counters.mjs:570-572` | 注释称 `countMcpTools` 读 `tools?.list?.() ?? tools?.tools`；实测 `index.js:241-256` 已改为 `tools.schemas(scope)`。**注释与实现不符** |
| DOC-2 | `test/audit-flow.mjs:253,270,300,317,342,359,375,390,404,420,435` | `title` 里引用的 `index.js:187 / :294 / :264 / :311 / :317-319 / :270 / :201 / :216,219 / :199` **全部过期**（实际：`agent/created` 在 `:291`、`tools/result` 在 `:397`、`pre-step` 在 `:302-375`、`turn-stopping` 在 `:445`） |
| DOC-3 | `test/audit-counters.mjs:24`、`test/audit-flow.mjs:26` | 头部注释称「工作区里没有 `node_modules`」——**现已存在**。实测 `obsidian-bridge/node_modules` 创建于 `2026/10/22 19:52:49`，故 `run-all.mjs:52` 的 `stage()` 走 `local` 分支，`profile` 模式的 staging（含 `ob-testrun-*`）对本工作区已是**死路径** |
| DOC-4 | `test/audit-counters.mjs:53`、`test/audit-flow.mjs:58` | staging 目录写在**真实 profile 的 node_modules** 下（`~/.dsh/profiles/desktop/node_modules/.audit-*-staging`）。`audit-counters.mjs:608-609` 只在**末尾**清理 —— 中途崩溃会残留。**实测已有残留**：`~/.dsh/profiles/desktop/node_modules/ob-testrun-25096`（创建 `2026/10/22 19:30:44`，早于本次评审会话，属历史泄漏；本次评审未新增残留 —— 复查 `.audit-*-staging` / `ob-testrun-*` 时该目录仍在，但 `node_modules` 建于 19:52，说明它来自更早一次被中断的 `run-all.mjs`） |

---

## 3. 交叉验证（与 Host 半边专家 `frontend-client` 对照）

来源：`test/cross-review-host.md`（Host 半边逐行覆盖交叉评审）与 `test/evidence/frontend-findings.md`。

| Host 专家提出的问题 | 位置 | 本套件是否有等价覆盖 | 结论 |
|---|---|---|---|
| **D2**：`maybeOrganize()` 三层不可见失败（最高优先级） | `index.js:463-485` | **无**。仅 `wiring.mjs:250-268` 核对 `createRunner` 导出表；无游标文件断言 | **缺口（FN-3）** |
| **D9**：`lastAssistantText` 两处 `catch{}` 静默 → 有计数无产物 | `index.js:55-90` | **无**。零测试命中 | **缺口（FN-2）** |
| `countMcpTools` 的 `:244 return null` 与 `:253 catch{}` 不可区分 | `index.js:241-256` | **无**。`audit-counters.mjs:582`（N3）只覆盖「schemas 正常返回」这一条 | **缺口** |
| `ensureIndex` 的 `:198-201` `ok:false` 分支 | `index.js:189-217` | ✅ `audit-counters.mjs:595`（N5）覆盖 | 已覆盖 |
| `ensureIndex` 的 `:207-211` `catch` 吞错 | `index.js:189-217` | ✅ `audit-counters.mjs:595` + `audit-flow.mjs:508` 覆盖 | 已覆盖 |
| `tools/result` 的 `:432` `JSON.stringify` try/catch | `index.js:397-444` | ✅ `audit-flow.mjs:433-439`（A13）覆盖对象载荷；`:415`（A12）覆盖真实位置参数 | 已覆盖 |
| `lib/writer.js` `resolveNode` 三处 `catch` 全返回 `null` | `writer.js:25-40` | ✅ `audit-counters.mjs:437`（W3）覆盖 | 已覆盖 |
| `lib/writer.js` `spawn` 的 `if (!executable) return null` / `catch → null` | `writer.js:48-67` | ✅ `audit-counters.mjs:414,427,447`（W1/W2/W4）覆盖 | 已覆盖 |
| `countMcpTools` 与 `cordis.patch.yml` 的 `serverName` 一致性 | `index.js:48` vs `cordis.patch.yml:31` | **无** | **缺口（FN-4）** |
| `ctx.warnings` 被丢弃导致 `mountBridgeService` 回归不可见 | `audit-flow.mjs:193` | **无**（且是**制造**该盲区的源头） | **缺口（FN-6）** |

**交叉结论**：Host 专家列出的 11 项里，**本套件对 4 项有等价覆盖、对 5 项完全无覆盖、对 2 项的「覆盖」实际上是被硬编码 `false` 关掉的**。
用户要求 2（交叉测试）在当前套件里**尚未达成**：`test/cross-review-host.md` 是 Host 侧单向评审，没有反向的「Host 用例 → 本套件映射表」。

---

## 4. 补测方案（含完整 mock）

> 以下为**建议**，本次评审未落地。每条都给出可复制的最小实现。

### 4.1 修 `coverage.mjs` 的口径（FP-2）

```js
// test/coverage.mjs:115-120 替换为：
for (const fn of script.functions ?? []) {
  const rs = fn.ranges ?? [];
  if (rs.length === 0) continue;
  // ranges[0] 是函数自身跨度，count>0 只说明「被进入过」，不是「体内每行都跑过」
  const isWholeFile = (r) => r.startOffset === 0 && r.endOffset >= textByteLength * 0.95;
  const body = fn.isBlockCoverage && rs.length > 1 ? rs.slice(1) : rs;
  for (const range of body) {
    if (isWholeFile(range)) continue;
    if (range.count > 0) coveredLines.add(range);
    else zeroLines.add(range);      // 内部 0 计数块要从覆盖里扣除
  }
}
// 最终：covered = coveredLines 中未被任何 zeroLines 覆盖的行
```

### 4.2 补 `contract.mjs` 的「零检查即失败」（FP-1）

```js
// test/contract.mjs:116 之后
if (skipped.length > 0) {
  // 平台目录在但一个声明都没读到 —— 这是回归，不是「跳过」
  const catalogRoot = path.join(DSH_APP, 'node_modules', '@deepseek-ai');
  const catalogExists = fs.existsSync(catalogRoot)
    && fs.readdirSync(catalogRoot).some((p) => fs.existsSync(path.join(catalogRoot, p, 'lib', 'types', 'api-catalog.js')));
  if (catalogExists) {
    check('守卫：平台目录存在时必须读到至少一条签名声明', () => {
      throw new Error(`api-catalog 存在但 ${skipped.length} 个事件全部未找到声明：${skipped.join('；')}`);
    });
  }
}
```
并把 `:171` 的 `if (!sig) return;` 改为 `if (!sig) { /* 已在上面统一判失败 */ }`。

### 4.3 补 `lastAssistantText`（FN-2）—— 用真实 session 形状

```js
// test/status-refresh.mjs 追加（复用已有 makeCtx）
{
  const store = await import(pathToFileURL(path.join(ROOT, 'lib/status-store.js')).href);
  store.setSnapshot(null);
  const ctx = makeCtx();
  index.apply(ctx, {});
  await tick();

  // 真实 session 形状：seq 从 1 起，eventAt 只在前半段有值
  const mkEvent = (type, text) => ({ type, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  const session = {
    header: {},
    seq: 4,
    eventAt: (seq) => (seq === 3 ? mkEvent('assistant/message', '本轮摘要内容') : undefined),
    deriveMessages: () => [],
  };
  await fire(ctx, 'agent/turn-stopping', { agent: { session } });

  const snap = store.getSnapshot();
  check('agent/turn-stopping：response 取到本轮助手消息（非空）', () => {
    assert.ok(snap.last.stops.response, `response 应非空，实际 ${JSON.stringify(snap.last.stops.response)}`);
    assert.ok(snap.last.stops.response.includes('本轮摘要内容'));
  });
}
```
**为什么这条能抓 bug**：它断言的是**产物**（`last.stops.response`），不是「没报错」。
`lastAssistantText` 的两个 `catch {}` 一旦被触发，`response` 变 `''` → 立即 FAIL。

### 4.4 补 `maybeOrganize` 的产物断言（FN-3）—— 坑 8 的通用化

```js
// test/organize-gate.mjs（新增，或并入 wiring.mjs）
// 断言「本该出现的产物」= knowledge-organize-cursor.json
{
  const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-organize-'));
  // ... 造 2 篇笔记（1 篇新、1 篇与游标 contentHash 相同）
  const ctx = makeCtx({ vaultPath: VAULT });
  index.apply(ctx, { vaultPath: VAULT });
  for (let i = 0; i < 10; i += 1) ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  await tick(300);

  check('maybeOrganize：游标文件出现（产物断言，非错误断言）', () => {
    assert.ok(fs.existsSync(path.join(VAULT, '90_Agent/knowledge-organize-cursor.json')),
      'knowledge-organize-cursor.json 未生成 —— 整理从未运行（异常被 catch 吞掉）');
  });
  check('maybeOrganize：organizeRuns 计数随触发增长', () => {
    const snap = getSnapshot();
    assert.ok(snap.counters.organizeRuns >= 1, `organizeRuns=${snap.counters.organizeRuns}`);
  });
}
```
**关键点**：`runner.spawn` 在 mock 里必须**真的执行**（或至少记录调用），否则 `maybeOrganize` 的 `TypeError` 会被 `.catch(() => {})` 吞掉而游标不生成 —— 那正是本断言要抓的。

### 4.5 把 `knowledge-quality.mjs` / `coverage.mjs` 挂进 gate（FN-1）

```js
// test/run-all.mjs:85 SUITES 追加
{ layer: 'L2', name: '知识整理质量门', file: 'test/knowledge-quality.mjs',
  needs: () => STAGE !== null, needDesc: L2_NEED, pass: /通过 (\d+)\/(\d+)/ },
{ layer: 'L1', name: '覆盖率口径自检', file: 'test/coverage.mjs',
  needs: () => HAS_DSH, needDesc: 'DSH 安装目录', optionalInfra: true,
  pass: /口径自检通过/, cwd: ROOT },
```
（`coverage.mjs` 需要先在 §4.1 修好，并加一个「不依赖 `NODE_V8_COVERAGE` 目录」的纯口径自检模式。）

### 4.6 把 5 处硬编码 `false` 变成真断言（FP-4）

```js
// audit-flow.mjs:320 (A11)
report('A11 ...', '...', '...', `...`, snapBefore?.index?.builtAt === snapAfter?.index?.builtAt);
// audit-flow.mjs:527 (C2)
report('C2 ...', '...', '...', `...`, calls1 !== ctx.listDirCalls);
// audit-flow.mjs:540 (C3) / :768 (I1) / :780 (I2) 同理
```

### 4.7 统一两个套件的 `tools/result` 调用形态（FN-8）

`audit-counters.mjs` 的 T1–T6 改为位置参数，与真实派发一致：

```js
// 替换 audit-counters.mjs:214 等
ctx.listeners['tools/result']({ name: 'write', arguments: { file_path: 'D:/x.md', content: 'project 计划' } }, {});
```
对象载荷的兼容性由 `audit-flow.mjs:433-439`（A13）单独守，不需要在计数器套件里重复。

---

## 5. 结论摘要

| 维度 | 结论 |
|---|---|
| **基线** | 8 套件全绿（实测）。但「全绿」≠「覆盖完整」 |
| **最大风险** | `test/coverage.mjs` 的口径缺陷使覆盖率**系统性虚高 32.5pp**（同数据实测 83.8% vs 51.3%），直接架空用户要求 1 的度量基础 |
| **最危险的假阳性** | `contract.mjs` 在平台目录存在但读不到声明时仍报「通过 1/1」并退出 0（已实测复现）；`audit-flow.mjs` 5/37 检查被硬编码 `false` |
| **最危险的真缺口** | ① `lastAssistantText`、② `maybeOrganize`/游标文件、③ `client.js` 全半边（345 行 0% 运行时覆盖）、④ `obsidian-local` 三处一致性 —— **四项零断言**，且①②都属于「静默失败」家族（KB 坑 2/4/8） |
| **结构问题** | `run-all.mjs` 漏挂 2 个脚本；两个套件对 `tools/result` 与 `governance` 的 fixture 互相矛盾；Client 半边只有文本断言 |
| **交叉验证** | Host 侧 11 项中 5 项无等价覆盖、2 项的覆盖被硬编码关闭 → 用户要求 2 **未达成** |
| **证据不足** | 无。（本文所有 FP/FN 均附行号或命令输出；未验证项已在 §2.4 标为文档漂移而非断言缺陷） |
| **修订漂移** | 评审期间 `index.js`（489→536 行）、`lib/vault-index.js`（146→162）、`test/coverage.mjs`、`test/run.mjs` 被并发修改。**行号可能失效，但缺陷机制在两个修订下都复现**（FP-2 已对两修订各测一次；FP-3 的行号在 254 行修订下仍为 `:187-191`，已复核）。其余 9 个测试文件 mtime 均早于本次会话，引用稳定 |

**建议优先级**：FP-2（口径）→ FN-3（organize 产物）→ FP-1（contract 零检查）→ FN-2（lastAssistantText）→ FN-1（挂载脚本）→ FN-4b（Client 半边运行时覆盖）→ 其余。

---

## 附：本次评审的可复现命令

> 解析脚本是**临时**的（写在 `%TEMP%`，未入库）。核心算法已在 §4.1 内联给出，
> 按此重写一个 60 行的解析器即可复现全部数字。

```powershell
# 基线
$env:NODE_V8_COVERAGE = "$env:TEMP\ob-cov"; node test/run-all.mjs

# 逐套件 coverage（每套件独立目录，避免跨套件串味）
node <tmp>/ob-cov3.mjs <ROOT> "$env:TEMP\ob-cov-per"
node <tmp>/ob-cov5.mjs "$env:TEMP\ob-cov-per" <ROOT>

# 项目自带覆盖率工具（注意其口径缺陷，见 §1.3）
node test/coverage.mjs "$env:TEMP\ob-cov-per\wiring"

# 复现 contract.mjs 的假阳性
$env:DSH_APP_DIR = "$env:TEMP\empty-dsh"   # 空目录
node test/contract.mjs; echo "exit=$LASTEXITCODE"
node test/run-all.mjs
```

**V8 区间语义的受控标定**（用于证明 §1.3 不是推测）：

```powershell
# 造一个只含 branch/multi 的文件，跑一次，打印 ranges
node <tmp>/calib.mjs     # 见 §0 的实测输出
```
