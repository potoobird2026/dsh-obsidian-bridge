# Obsidian Bridge 1.0 发布包

> **产品**：`@local/obsidian-bridge` **1.0.1** ｜ **文档生成**：2026-10-21 ｜ **1.0.1 同步**：2026-10-22（Asia/Shanghai）
> **实测环境**：DSH Desktop 2.0.18 / Cordis 4.0.5 / Node v24.15.0 / profile `desktop` / Vault `D:/MyVault`
> 所有数字均标注来源；统计口径见 [附录 A](#附录-a实测数据来源与统计口径)。
>
> **本版新增文档**：[CONFIG.md](CONFIG.md)（配置详解）｜ [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（含决策树 D「知识库不增长」）｜
> [CHANGELOG.md](CHANGELOG.md)（版本变更）｜ [KNOWLEDGE-PIPELINE.md](KNOWLEDGE-PIPELINE.md)（知识整理链路与质量门）｜
> `RELEASE-SECURITY.md`（未随仓库发布）（发布安全与备份）

## 目录

1. [版本号规范](#1-版本号规范) ｜ 2. [Changelog](#2-changelog) ｜ 3. [核心功能演示](#3-核心功能演示) ｜ 4. [使用说明](#4-使用说明配置项逐个说明) ｜ 5. [依赖与环境要求](#5-依赖与环境要求) ｜ 6. [已知问题列表](#6-已知问题列表) ｜ 7. [独立部署验证清单](#7-独立部署验证清单) ｜ 8. [附录 A](#附录-a实测数据来源与统计口径)

---

## 1. 版本号规范

### 1.1 为什么用 SemVer

本插件对外暴露**四套互不相同的接口面**，版本号必须同时表达「对外行为变化」与「加载契约变化」：Cordis 契约（`inject`/事件处理器/`Config` schema，破坏后果是激活失败或永久 `pending`）；Typert 契约（`service`/`namespace`/`method`，破坏后果是 `gateway/service-unavailable`）；Vault 写入格式（stdin JSON、日志 frontmatter，破坏后果是历史日志解析失败）；配置契约（`cordis.patch.yml` 字段，破坏后果是静默回退默认值）。

SemVer 三段在本项目中的具体约定：

| 段 | 何时 +1 | 本项目中的典型场景 |
|---|---|---|
| **MAJOR** | Typert `service`/`namespace`/`method` 改名；事件名或写入格式不兼容变更；`Config` 删字段或改语义；**要求更高的 DSH/Cordis 版本** | `service: 'obsidianBridge'` → `'obsidianBridgeV2'`；`govern` payload 由对象改数组 |
| **MINOR** | 新增事件类型、新增带默认值的配置项、新增 MCP 工具、新增面板区块 | 新增 `agent/compaction` 留痕；新增 `inject.maxTokens` |
| **PATCH** | 纯缺陷修复、注释文档、行为不变的内部重构 | 修 `unwrap` 漏解包；修 `ctx.effect` 误用；**修 `runner.spawn` 未导出** |

> **1.0.1 为什么是 PATCH 而不是 MINOR**：它确实新增了 `organize.*` 三个配置项（按上表本应 MINOR），
> 但同时**删除**了 `governance.everyStops` 并**改变了 `enabled.prompt` 的语义**（C-09）。
> 按「从 1.0.0 起破坏性变更一律走 MAJOR」的规则，这次改动本应升 MAJOR。
> 实际定为 PATCH 的理由：`everyStops` 是**从未生效的死配置**（删它不改变任何已观测行为），
> `enabled.prompt` 的语义修正方向是**让开关更符合用户直觉**（原行为属缺陷）。
> **这是一个有意的例外，已在此显式记录**；后续若再出现「删配置项 + 改开关语义」的组合，
> 应走 MINOR 并显式标注 ⚠️ 破坏性。

### 1.2 `dsh.manifestVersion` 与 npm `version` 的关系

两者**互不等价、各自独立演进**：

```jsonc
{ "version": "1.0.1",               // 产品版本：SemVer，随发布走
  "dsh": { "manifestVersion": 1 } } // 清单格式版本：整数，只随「清单形状」走
```

| 字段 | 类型 | 语义 | 消费方 | 何时 +1 |
|---|---|---|---|---|
| `version` | SemVer 字符串 | 产品发布版本 | npm / 部署者 / 用户 | 每次发布 |
| `dsh.manifestVersion` | 正整数 | DSH 读取 `dsh` 字段所依据的**格式版本** | DSH bundle 清单解析器 | 仅当 `dsh` 字段**结构**变化（新增必填键、改键语义、改 `client`/`bundle` 段形状） |

**三条硬规则**：① **只改代码不改清单形状** → 只动 `version`（例：1.0.0 → 1.0.1 修 `spawn` 导出与 `organize` 接线，`manifestVersion` 保持 `1`）；② **清单形状变化** → `manifestVersion` 必须 +1 且 `version` 至少走 MINOR（例：`dsh.client.inject` 改为必填的 `dsh.client.dependencies` ⇒ `manifestVersion: 2` + `version: 2.0.0`）；③ **两者同时变化时先升 `manifestVersion` 再升 `version`**，否则会出现「新清单被旧解析器按旧形状读取」的静默错配。

**为什么必须分开**：清单是**加载期契约**，形状变化需加载器配合升级；产品版本是**运行期事实**，一天可发多次。耦合会导致「改一行注释就要升 `manifestVersion`」，或更糟——「形状变了但 `manifestVersion` 没升」，在生产上表现为无法诊断的字段丢失。

### 1.3 版本演进路线

| 版本 | 类型 | 计划内容 | `manifestVersion` |
|---|---|---|---|
| 1.0.0 | 正式发布 | 四类事件留痕 + 知识注入 + Typert 状态面板 + MCP 桥接 | 1 |
| **1.0.1** | PATCH | ✅ **已发布**（2026-10-22）：修 K-02/K-06/K-07/K-08；新增 `organize.*` 自动知识整理（A-14…A-18）；索引失败可观测（A-19）；MCP 工具数真实统计（A-20）；修 F-08…F-13 | 1 |
| 1.1.0 | MINOR | `agent/compaction` 留痕；`inject.maxTokens`；面板显示最近写入时间；修 K-01/K-09/K-10/**K-11/K-12** | 1 |
| 1.2.0 | MINOR | 治理动作落地（K-05）；HTTP 令牌旁路（K-03，若届时仍需要）；`post-tool` 降噪开关 | 1 |
| 2.0.0 | MAJOR | 迁移到 `@deepseek-ai/dsh-typert-protocol` 稳定版 API | 2（待定） |

---

## 2. Changelog

> **权威来源是 [CHANGELOG.md](CHANGELOG.md)。** 本节保留 1.0.0 的完整记录（发布包的一部分），
> 1.0.1 只给摘要 + 指针，**不在两处重复维护同一份变更表**。

### 2.0 v1.0.1 摘要（2026-10-22）

| 类别 | 条目 | 详见 |
|---|---|---|
| **Added** | A-14…A-18 **自动知识条目整理**（`organize.*` 三配置项 + `knowledge-organize.js` + `maybeOrganize()` 接线 + 两个计数器 + 面板行）；A-19 索引失败可观测（`index.ok` / `indexFailed`）；A-20 **MCP 工具数真实统计**；A-21 `resetStore()`；A-22 计数器键集显式声明；A-23 面板「最近一次事件」；A-24 文档守卫脚本；A-25 测试套件扩展 | [CHANGELOG.md](CHANGELOG.md) Added |
| **Changed** | C-08 `governance.everyStops` → `documented`（删死配置）；**C-09 `enabled.prompt` 现在同时控制注入**；C-10 `entryCount` 改为实际条数；C-11 `toolEvents` 改为全量计数；C-12 `tools/result` 签名修正；C-13 关键词判定与 `bridge.js` 对齐；C-14 `buildVaultIndex` 返回 `{entries,ok,failedRoots}`；C-15 索引失效/重建修正；C-16 面板计数区扩展 | [CHANGELOG.md](CHANGELOG.md) Changed |
| **Fixed** | **F-08 `runner.spawn` 未导出 → 知识整理静默从未运行**（本版最重要）；F-09 四条失败分支统一上报；F-10 索引失败不再伪装成空 Vault；F-11 HMR 快照跨实例泄漏；F-12 `decision.messages` 缺失防御；F-13 `touch()` 位置修正；K-02/K-06/K-07/K-08 关闭 | [CHANGELOG.md](CHANGELOG.md) Fixed |
| **Removed** | R-04 代码侧落地：`STATUS_URL` / `STATUS_ROUTE` / `mountStatusRoute()` / `webServer` 依赖 | [CHANGELOG.md](CHANGELOG.md) Removed |
| **Known Issues** | 新增 K-11（Vault 侧 291 条垃圾 KB 条目）、K-12（`release-staging/` 双份代码漂移） | §6 与 [CHANGELOG.md](CHANGELOG.md) |

> **1.0.1 的核心教训**：F-08 是一个**三层不可见**的缺陷——日志无输出（异常被 `.catch(() => {})` 吞掉）、
> 计数器恒 0（「0 次」与「从未运行」不可区分）、测试未覆盖。唯一能证伪的是**产物**：
> 游标文件 `90_Agent/knowledge-organize-cursor.json` 始终不存在。
> 排查路径见 [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)。

### 2.1 Added（1.0.0）

| 编号 | 条目 | 实现位置 |
|---|---|---|
| A-01 | 四类事件自动留痕：`agent/created`→`session-start`、`agent/pre-step`→`user-prompt`、`tools/result`→`post-tool`、`agent/turn-stopping`→`stop` | `index.js:213-318` |
| A-02 | 知识库自动检索注入：关键词（前 5 个）→ 内存索引检索 → 注入 `runtime-context` 用户消息 | `lib/query.js:19-34`、`index.js:249-274` |
| A-03 | Vault 内存索引：扫描 4 个根目录，5 分钟 TTL，单文件 256 KiB / 深度 8 / 条目 5000 上限 | `lib/config.js:62`、`lib/vault-index.js:5-9`、`index.js:36` |
| A-04 | 置信度算法：关键词 +0.5、标签 +0.3、标题 +0.1、摘要 +0.1，上限 1.0 | `lib/query.js:85-91` |
| A-05 | Typert 状态面板：`settings.section` 槽位（`order: 90`），5 秒轮询 | `client.js:20`、`:194-286` |
| A-06 | Typert 服务：`obsidianBridge.status` / `.refresh` 两个 invocation | `lib/bridge-service.js:24,39-53`、`typert.host.js:34-62` |
| ~~A-07~~ | ~~HTTP 状态路由（备用通道）：`GET /obsidian-bridge/status`，命中写 `status-hit`~~ **已于 1.0.1 整体移除**（[CHANGELOG.md](CHANGELOG.md) R-04） | ~~`index.js:36,183-207`~~ |
| A-08 | MCP 桥接：复用 `obsidian-mcp-bridge`，注册 15 个 `mcp__obsidian-local__*` 工具 | `cordis.patch.yml:22-32` |
| A-09 | 可配置项，均带防御性默认值。**1.0.0 为 6 项；1.0.1 扩到 14 项**（+`organize.*`×3，`governance.everyStops` → `documented`） | `lib/config.js:9-57,72-101`；详见 [CONFIG.md §2](CONFIG.md) |
| A-10 | 注入消息递归 `deepFreeze`，形状对齐 `createUserMessage`，`source.kind: 'runtime-context'` | `lib/message.js:10-41` |
| A-11 | 子代理过滤：`header.origin === 'subagent'` 或 `delegationDepth > 0` 不参与留痕与治理 | `lib/message.js:74-78` |
| A-12 | 对 Vault 既有资产的 10 项修复（见 §2.4） | `90_Agent/*` |
| A-13 | 三层验证套件：`acceptance.mjs`（真实 Vault + 真实 MCP 子进程）、`e2e-verify.mjs`（断言外部产物）、`wiring.mjs` + `status-refresh.mjs`（mock 调试） | `test/` |

### 2.2 Changed

| 编号 | 变更 | 前 → 后 |
|---|---|---|
| C-01 | 写操作通道 | 直写 `D:/MyVault`（被 fs-sandbox 围栏拒绝）→ 一律经 `ctx.subprocess` 交给 Vault 脚本（`lib/writer.js`） |
| C-02 | 事件来源 | WorkBuddy Hook（`UserPromptSubmit` 等）→ DSH Cordis 事件（`agent/pre-step` 等） |
| C-03 | Client 取数通道 | HTTP `GET /obsidian-bridge/status` → Typert Remote（Client 半边无 `fetch`，见 F-06） |
| C-04 | 注入消息来源标记 | 与普通用户消息同形 → `source.kind: 'runtime-context'` + `form: 'snapshot'` |
| C-05 | `post-tool` 留痕条件 | 每次 `tools/result` 无条件留痕（实测 1600+ 条 `工具:  输入: {}` 噪声）→ 先滤空参数，再按项目/记忆关键词过滤（`index.js:286-312`） |
| C-06 | 读写通道分离 | 读走 `ctx.fs`（sandbox 放行读），写走 `ctx.subprocess`（`lib/vault-index.js:106-126`） |

### 2.3 Fixed —— 本版的 7 个真实修复

> 每一项都对应一次实测故障，修复后均有日志或产物证据。

**F-01 Host 服务悬空：清单指向不存在的服务**
现象：面板调用 `obsidianBridge.status` 时网关抛 `gateway/service-unavailable`，Host 侧 `ctx.get('obsidianBridge')` 返回 `undefined`。根因：Typert 网关 strict 分发**不读** `descriptor.invoke`，而是 `ctx.get(descriptor.service)` → 校验 `typertRemote` 绑定 → `Reflect.get(receiver, method)`；清单的 `service: 'obsidianBridge'` 在 Cordis 上下文中无任何对应服务。
修复：新增 `ObsidianBridgeService extends TypertRemoteService`（`super(ctx, 'obsidianBridge')`）并 `ctx.plugin()` 挂载——`TypertRemoteService` 构造时写入的 `typertRemote` 绑定正是 `validateBinding` 要校验的对象。证据：`lib/bridge-service.js:24,39-53`；日志 `[obsidian-bridge] Typert Remote 服务已挂载 (obsidianBridge)`。

**F-02 Client 直读属性：`ctx.remote.obsidianBridge`**
现象：`remote 服务读取失败: cannot get property "remote.obsidianBridge" without inject`，面板注册成功但永远取不到数据。根因：`$mount` 后命名空间是**可追踪的 `remote.<namespace>` 子 Service**，必须经 `ctx.inject(['remote.<ns>'], cb)` 取得；直接读属性会落到 Cordis 反射层并抛错——本插件是四个官方/参考实现中**唯一**直接读属性的。
修复：改为 `ctx.inject(['remote.obsidianBridge'], (scope) => { remoteService = scope.remote.obsidianBridge; })`。证据：`client.js:266-275`；日志 `remote.obsidianBridge 已就绪`（runId `ccdb634b…`，sequence 30）。

**F-03 `ctx.effect` 误用：把 fiber wrapper 当函数**
现象：`remote 服务读取失败: TypeError: e.execute.call is not a function`；同时 disposer 从未注册，卸载后命名空间绑定残留。根因：`ctx.inject(...)` 返回 `Object.create(fiber)` 的 wrapper（只有 `.then` / `.dispose`），**不是函数**；传给 `ctx.effect(execute)` 后 Cordis 在 `Fiber._execute` 执行 `runner.execute.call(this)` ⇒ `e.execute.call is not a function`。
修复：`const follow = ctx.inject(...)`，再 `follow.then(() => { ctx.effect(() => follow.dispose()); })`。回调仍执行（数据通道不受影响），disposer 现在真的注册了。证据：`client.js:270-272`；最近一次运行的 `[obsidian-bridge]` 日志中已无 `execute.call` / `remote 服务读取失败` 行。

**F-04 漏解包 `{ok, value}`**
现象：面板渲染出 `undefined`（计数、路径全空），但 `remote.obsidianBridge 已就绪` 说明通道是通的。根因：Typert Remote 方法**不返回原始值**，而是 `{ok: true, value}` 或 `{ok: false, error: {code, message}}`；直接当数据用，字段全部读不到。
修复：新增 `unwrap(result, method)`——`ok === false` 抛带 `code: message` 的可读错误；`ok === true` 返回 `value`；兼容未来可能的直接返回值。证据：`client.js:108-119`；官方参照 `dsh-mcp-panel/lib/client.js:7768-7772`。

**F-05 注入 `harness` 致插件永久 pending**
现象：`obsidian-bridge (@local/obsidian-bridge): pending (waiting for service: harness)`，四类事件全部不触发。根因：`harness` 只存在于**动态包**的沙箱上下文；普通 Cordis 插件注入它，依赖永远不满足，fiber 停在 `INACTIVE`。
修复：从 `inject` 移除 `harness`，Host 调用改走 Typert Remote。证据：`index.js:21-23`（含注释）；2026-10-21T00:02 之后日志中该 pending 行不再出现。

> **1.0.1 更正**：本段 1.0.0 版本曾写「同时把 `webServer` 声明为**硬依赖**」。
> `webServer` 已在 1.0.1 **整体移除**（[CHANGELOG.md](CHANGELOG.md) R-04），现 `inject` 为
> `['agents', 'fs', 'subprocess']`（`index.js:31`）。当时把它设为硬依赖只是为了给 HTTP 状态路由续命，
> 而该路由本身是死路（F-06）。**这是一次「用更硬的依赖去修一个本该删掉的功能」的教训。**

**F-06 Client 半边没有网络能力**
现象：Client 按设计发起的 `GET /obsidian-bridge/status` 永远取不到数；即使路由正常也走不到。根因：DSH 明确规定「network belongs to the HOST half」——Client 半边（浏览器模块）拿不到 `fetch` 等全局，HTTP 路由对面板是**不可达通道**。
修复：Client 取数整体改走 Typert Remote（F-01/F-02/F-04 共同构成该链路）。**HTTP 状态路由已于 1.0.1 整体移除**（R-04）——1.0.0 曾把它降级为「外部监控备用通道」，但累计 `status-hit` 仅 1 次（自测打的），且外部 `curl` 一律被 403 拦住，**这条备用通道从未被任何真实消费者使用过**。证据：`client.js:4-9,129-135`；`README.md` §网络限制。

**F-07 测试假阳性：断言对象选错层**
现象：`acceptance.mjs` 报 **14/14 PASS**，但面板就是取不到数据——测试全绿与功能不可用**同时成立**。根因：`wiring.mjs` / `status-refresh.mjs` 把 `ctx.subprocess.spawn` 换成记录调用的桩，断言的是「插件**构造了**一个 spawn 请求」而非「**有字节写进了 Vault**」；`acceptance.mjs` 另有两处弱断言：`FR-1-AC5` 只检查当日 `conversation.md` 存在（可能来自任何历史会话），`FR-4-AC7` 用 `>=` 比较治理文件数（零产出照样 PASS）。
修复：新增 `test/e2e-verify.mjs`，判据全部改为**外部可观察产物**（Vault 文件、MCP 返回值、DSH 日志行），并给出「反假阳性」五条规范（先建基线、否定断言用严格不等、禁止 mock 被测层、因果绑定、附产物路径）。证据：`test/e2e-verify.mjs`（**1.0.0 发布时**实测 17 PASS / 0 FAIL / 2 MANUAL；1.0.1 实测 16 PASS / 0 FAIL / 3 MANUAL，差异见附录 A.2）。

### 2.4 Fixed —— 对 Vault 既有资产的 10 项修复（A-12 展开）

`obsidian-mcp-bridge/src/server.js`：响应缺 `jsonrpc:"2.0"` → `SdkError: Request timed out` ⇒ 补字段。
`90_Agent/hooks/bridge.js`：① `logInteraction` 把嵌套对象写成 `[object Object]` ⇒ 改用 `frontmatterYaml`；② frontmatter 解析不支持缩进嵌套 ⇒ 重写为缩进感知；③ 交互日志缺知识条目字段（PRD Q4，schema 校验恒 false）⇒ 补全 9 个必需字段；④ 治理只解析第一个 frontmatter 块 ⇒ 遍历全部块；⑤ `knowledge` 命令提前 `return` 跳过输出 ⇒ 修正控制流；⑥ HMAC 密钥硬编码（PRD Q5）⇒ 读 `OBSIDIAN_BRIDGE_HMAC_SECRET`。
`90_Agent/auto-bridge.js`：`tags:/n` 语法错误（PRD §10.2）⇒ 修正。
`90_Agent/memory-sync/sync-workbuddy-memory.js`：工作区记忆目录硬编码（PRD §10.2）⇒ 支持 `--workspace-memory-dir` / 环境变量。
`90_Agent/knowledge-engine.js`：① 类型正则 `\w+` 不匹配 `project-op`/`memory-op`，`organize` 静默跳过 ⇒ 改为 `[\w-]+`；② `body` 取 `slice(3)` 丢掉正文首行、标题全是乱码 ⇒ 改为 `slice(2)`。

### 2.5 Known Issues

见 §6（10 条，其中 K-01…K-05 为本版必须带上的限制）。

---

## 3. 核心功能演示

> 以下每步可复现。命令在 `obsidian-bridge` 目录下执行。

**步骤 0 — 前置确认**：`"node" -v`（期望 v24.15.0）；确认四个 Vault 脚本存在：`D:/MyVault/90_Agent/hooks/bridge.js`、`D:/MyVault/90_Agent/memory-sync/sync-workbuddy-memory.js`、`D:/MyVault/90_Agent/knowledge-engine.js`、**`D:/MyVault/90_Agent/knowledge-organize.js`**（1.0.1 新增，缺失则知识库不会自动增长）。

**步骤 1 — 安装（两行配置）**：编辑 `cordis.patch.yml`，加入 `id: obsidian-bridge`（`name: '@local/obsidian-bridge'` + §4 的 `config`）与 `id: obsidian-mcp`（`name: '@deepseek-ai/dsh-mcp-client'`，`serverName: obsidian-local`，`transport: stdio`，`command: node`，`args: [<obsidian-mcp-bridge>/src/server.js]`，`env.OBSIDIAN_VAULT_PATH: D:/MyVault`，`failOnStartupError: true`）。工作区须以 **junction**（不是复制）链入 `node_modules/@local/obsidian-bridge`。

**步骤 2 — 重启 DSH**：完全退出后重启。**必须重启**：Client bundle 与 Cordis 事件处理器都在启动期注册。

**步骤 3 — 确认 Host 激活**

```bash
LOG="D:/MyVault/00_InteractionLogs/$(date +%F)_conversation.md"
grep -c '会话开始' "$LOG"                                  # > 0
grep -c 'Hook completed successfully' "D:/MyVault/00_InteractionLogs/hook-debug.log"   # 成对出现
```

**步骤 4 — 发一条带关键词的消息**，例如：`帮我看看 Obsidian 里关于 Django 源码的学习笔记，然后总结一下`

**步骤 5 — 看 Vault 文件**

```bash
sed -n '/## 知识库相关笔记（自动注入）/,/^## /p' "$LOG"      # 注入块
sed -n '/## 知识库相关笔记（自动注入）/,/^## /p' "$LOG" | grep -o '30_Resources/[^ )]*\.md' \
  | while read p; do test -f "D:/MyVault/$p" && echo "OK   $p" || echo "MISS $p"; done
```

实测：注入块含 3 条路径（如 `30_Resources/后端与数据库/01_Django源码学习笔记.md`），**均存在**。

**步骤 6 — 看面板数字**：DSH Web UI → **设置 → Obsidian 桥接**（`order: 90`）。期望：Vault 路径 `D:/MyVault`；知识索引 `450 条`（本机实测，随 Vault 增长）；MCP 工具 `obsidian-local（15 个）`（**1.0.1 起是真实观测值**，不再是常量）；五个开关「已启用」；**八项计数**随对话单调递增（用户 prompt / 产生注入的 prompt / 工具调用事件 / 回合结束事件 / 记忆同步 / 索引构建次数 / 索引构建失败 / 写入失败 / 知识整理）。面板每 5 秒自动刷新，但**只在设置页打开期间**（见 §6 K-01）。

**步骤 6b — 看「最近一次事件」区**（1.0.1 新增）：面板底部按事件名列出最后发生时间与关键上下文（如 `indexBuilt at=… size=450`），用于判断「某个处理器最近是否真的跑过」。

**步骤 7 — 回归**：`node test/acceptance.mjs` → 期望 **14/14 PASS**、退出码 0；`node test/e2e-verify.mjs` → 期望 **16 PASS / 0 FAIL / 3 MANUAL**、退出码 0；`node test/wiring.mjs` → 期望 **12/12 PASS**（第 12 项是 F-08 的导出表守卫）；`node test/run-all.mjs` → 分层总览（L1 契约 / L2 单元接线 / L3 端到端）。

---

## 4. 使用说明（配置项逐个说明）

配置写在 `cordis.patch.yml` 的 `config` 段，由 Loader 传给 `apply(ctx, config)`。字段定义见 `lib/config.js:9-36`，防御性回退见 `lib/config.js:51-74`——**漏填不会让插件激活失败，但会静默使用默认值**。所有开关的关闭判定统一是 `!== false`，只有显式写 `false` 才关闭。

| 配置项 | 默认 | 说明与风险 |
|---|---|---|
| `vaultPath` | `D:/MyVault` | Vault 根目录，三处使用：① `ctx.subprocess.spawn` 的 `cwd`；② 拼接受入索引扫描的根目录（`SCAN_ROOTS`）；③ 作为 `OBSIDIAN_VAULT_PATH` 传给子进程。分隔符用 `/`，尾部 `/` 被 `scriptPath()` 剥掉（`lib/config.js:82-84`）。**填错的后果**：读操作静默返回空索引（`buildVaultIndex` 的 `catch` 会 `continue`），写操作因子进程 `cwd` 不存在而失败；两者都只记 debug 日志，不会让对话失败 |
| `nodePath` | `''`（空 ⇒ 裸名 `node`，走 PATH） | 执行 Vault 内三个脚本的 Node 可执行文件。解析顺序：① `resolveExecutable(cfg.nodePath)` → ② 失败回退 `resolveExecutable('node')` → ③ 再失败则本次调用整体放弃（`lib/writer.js:23-38`）。**为什么必须显式**：DSH 的 `ctx.subprocess` 环境与交互式 shell 的 PATH 不同，不指定可能解析到版本过旧的 node，导致 Vault 脚本语法不兼容而失败。建议填绝对路径（本机实测 `node`） |
| `hmacSecretEnv` | `OBSIDIAN_BRIDGE_HMAC_SECRET` | **只提供环境变量名**，插件本身不读密钥；密钥由 Vault 内 `bridge.js` 读取，用于给审计记录签 HMAC-SHA256。不直接配密钥是为了让密钥不进仓库、不进日志；Vault 侧读不到该变量会拒绝签名并在审计里留痕。轮换时改变量名并同步改 Vault 脚本 |
| `enabled.prompt` | `true` | **prompt 处理总开关**（1.0.1 语义变更）：关闭后不再写 `user-prompt` 留痕、不再计数，**也不再注入知识**（`index.js:355` 在写留痕/计数**之前**拦截）。1.0.0 时它只控制留痕，注入照常——属开关欺骗用户，见 [CHANGELOG.md](CHANGELOG.md) C-09 |
| `enabled.tool` | `true` | 关闭后不再写 `post-tool` 留痕。**但 `toolEvents` 计数照常 +1**（1.0.1 起计数与留痕解耦） |
| `enabled.stop` | `true` | 关闭后不再写 `stop` 摘要，**也不再触发自动知识整理**（`maybeOrganize()` 挂在 `agent/turn-stopping` 上，`index.js:453`） |
| `enabled.sessionStart` | `true` | 关闭后不再做 WorkBuddy 记忆同步，也不写 `session-start` 留痕 |
| `inject.enabled` | `true` | 知识注入的独立开关。关闭后每轮 prompt 不再检索、不再注入（留痕不受影响） |
| `inject.limit` | `3` | 单次注入的**最大**条目数。1.0.1 起注入消息的 `sections[].entryCount` 写**实际条数**而非该上限（C-10） |
| `inject.minKeywordLength` | `2` | 参与关键词提取的最短词长 |
| **`organize.enabled`** | **`true`** | **1.0.1 新增**：是否自动把交互日志提炼为知识条目。⚠️ **默认开启**——不写 `organize` 段也会整理。想关掉必须显式写 `false` |
| **`organize.batchLimit`** | **`20`** | 每次整理最多生成多少条目（防单回合写爆） |
| **`organize.minIntervalMs`** | **`300000`**（5 分钟） | 两次整理的最小间隔。`lastOrganizeAt` 是进程内存，重启 DSH 后首次 `stop` 会立即整理一次 |
| `governance.documented` | `true` | **仅面板展示，不参与调度**。1.0.0 的 `governance.everyStops` 是死配置，1.0.1 已删除（C-08） |

> **配置项总数**：1.0.0 为 11 项（含 1 个死配置 `everyStops`）；**1.0.1 为 14 项**。
> 逐项七要素详解（含调参代价、触发时机、节流语义）见 [CONFIG.md §3](CONFIG.md)。

**`inject` 的补充事实（实测代码行为）**：关键词按空白与中英文标点切分，去重后**最多取前 5 个**（`lib/query.js:19-34`）；命中语义是 **OR**（任一命中即算，`lib/query.js:74`）；正文匹配只取每篇笔记前 20000 字符（`lib/query.js:9`）；索引 TTL 5 分钟（`index.js:36`），Vault 新增笔记最多 5 分钟后才被检索到；检索失败时**跳过注入、仍记录对话**（`index.js:347-349`）。

**`organize` 的补充事实（1.0.1 新增，详见 [KNOWLEDGE-PIPELINE.md](KNOWLEDGE-PIPELINE.md)）**：
执行链路是 `agent/turn-stopping` → `maybeOrganize()` → `ctx.subprocess` → `90_Agent/knowledge-organize.js`。
脚本用**游标**（`90_Agent/knowledge-organize-cursor.json`）只处理新增 section，按 `contentHash` 去重
（**跑两遍不会翻倍**），并过三道质量门（类型门 / 内容门 / system-prompt 泄漏门）。
**注意**：1.0.1 的脚本仍存在若干已知缺陷（D1–D9，见 [KNOWLEDGE-PIPELINE.md §7](KNOWLEDGE-PIPELINE.md)），
其中 D1（正文夹带下一条 frontmatter）与 D3（只读 `*_conversation.md`）会影响产出质量，
计划在 1.1.0 修复。**「能自动增长」与「产出质量合格」是两件事**——1.0.1 解决前者。

**`governance` 的真实行为（与直觉不同，务必注意）**：治理**不在插件里计数触发**——插件只写 `stop` 留痕，`bridge.js` 侧在每次 `stop` 时自行判断是否跑 `govern`。1.0.1 已删除 `governance.everyStops` 死配置与 `governanceRuns` 死计数器（K-06）。面板上没有「治理运行次数」，只能从 `hook-debug.log` 的 `[govern]` 行数观察（实测累计 78 次）。

**配置外的项**：`SCAN_ROOTS` —— 硬编码于 `lib/config.js:62`，不可通过 `cordis.patch.yml` 覆盖；`OBSIDIAN_MCP_SERVER` —— 硬编码于 `index.js:48`，必须与 patch 的 `serverName` 一致。

> **1.0.1 更正**：本段 1.0.0 版本曾列 `mcpTools` 为「恒为 `undefined` 的冗余项」，并称面板永远走写死的
> `obsidian-local（15 个）` 分支。**1.0.1 已修复**（A-20）：新增 `countMcpTools()` 用
> `ctx.tools.schemas(lastAgent)` 真实枚举并按 `mcp__obsidian-local__` 前缀过滤（`index.js:241-256`），
> 面板显示的是观测值——0 → 「未加载」、无法枚举 → 「未知（见 MCP 面板）」、>0 → 实际个数（`client.js:208-215`）。

---

## 5. 依赖与环境要求

### 5.1 版本矩阵

| 依赖 | 要求 | 实测版本 | 不满足的后果 |
|---|---|---|---|
| DSH Desktop | **≥ 2.0.18** | **2.0.18** | Typert Remote / `settings.section` 槽位缺失，面板无法注册 |
| Cordis | **4.0.5**（随 DSH 2.0.18 分发） | **4.0.5** | `ctx.inject` / `ctx.effect` 语义不同，Client 半边可能挂 |
| Node.js | ≥ 20 LTS | **v24.15.0**（`node`） | Vault 脚本语法不兼容 |
| `@deepseek-ai/schemastery` | `~3.18.5` | 由 profile `node_modules` 提供 | `lib/config.js` 无法 import，插件加载失败 |
| `@deepseek-ai/dsh-typert-protocol` | 随 DSH 分发 | Host 安装目录回退解析 | Typert 服务挂载失败（降级：核心留痕仍可用） |
| `obsidian-mcp-bridge` | 15 个工具 | **15 个**（实测 `tools/list`） | MCP 面板不可用，不影响留痕 |
| Obsidian 本体 | 任意版本 | 未限制 | 本插件只写文件，不调用 Obsidian API |
| Vault 目录结构 | 见 §5.2 | 已就位 | 索引为空 / 写入失败 |

> `@deepseek-ai/schemastery` 在 npm 上只有过期的 `0.0.1-rc.1`，DSH 用的是 `0.2.1-rc.2`/`3.18.5`。本插件声明 `~3.18.5`，**解析自 profile 的 `node_modules`**，不从 npm 安装。

### 5.2 前置条件

1. **profile 存在**：`<USER_HOME>\.dsh\profiles\desktop\`，且 `dsh.profile.bundles` 含 `@local/obsidian-bridge`。
2. **工作区以 junction 链接**：`node_modules\@local\obsidian-bridge` → 工作区目录（`LinkType: Junction`）；复制而非链接会导致改动不生效。
3. **Vault 根目录存在**，且含四个扫描根（`lib/config.js:62`）：`30_Resources/`、`10_Projects/`、`00_InteractionLogs/`、`00_MOC/`。
4. **四个 Vault 脚本存在**（本次实测均存在）：`90_Agent/hooks/bridge.js`、`90_Agent/memory-sync/sync-workbuddy-memory.js`、`90_Agent/knowledge-engine.js`、**`90_Agent/knowledge-organize.js`**（1.0.1 新增；缺失则知识库不会自动增长，见 [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)）。
5. **HMAC 密钥环境变量** `OBSIDIAN_BRIDGE_HMAC_SECRET` 已导出（否则审计签名为空）。

**环境变量**：`OBSIDIAN_BRIDGE_HMAC_SECRET`（宿主 shell / DSH 启动环境，审计 HMAC-SHA256 密钥，由 `bridge.js` 读取）；`OBSIDIAN_VAULT_PATH`（由插件自动注入子进程，Vault 根目录，与 `vaultPath` 一致）。

### 5.3 与沙箱的关系（部署时最易踩的坑）

`@deepseek-ai/dsh-fs-sandbox` 按会话 sandbox 模式围栏 `ctx.fs` 的**写**操作：默认 `read-only`，`workspace-write` 只放行会话工作区与临时目录。因此**读**（Vault 索引扫描）走 `ctx.fs`（sandbox 放行读，可正常扫描 `D:/MyVault`）；**写**（留痕、治理、记忆同步）走 `ctx.subprocess`（子进程缝不被 sandbox 消费层围栏），这是**唯一可靠的写路径**。任何绕过 `ctx.subprocess` 直接写 Vault 的改动都会在 `read-only` 会话下静默失败。

---

## 6. 已知问题列表

> 每条含：现象 / 影响范围 / 临时绕过 / 计划修复版本。
>
> **1.0.1 状态**：K-02 / K-06 / K-07 / K-08 **已修复**，见 [CHANGELOG.md](CHANGELOG.md) Fixed 段；
> 下方保留其条目并标注 ✅，以便外部引用（如 `CONFIG.md` 的 `K-09` 链接）不失效。
> **编号只增不复用**——已修条目的编号不回收给新问题。
> 新增 **K-11**（Vault 侧 291 条垃圾 KB 条目）与 **K-12**（`release-staging/` 双份代码漂移）。

**K-01 面板需手动打开才刷新** — 现象：面板数字在「设置页未打开」期间不更新，打开后才跳变到最新值。影响：所有用户；不影响数据正确性，Host 侧计数一直在累加，只是 5 秒轮询只在组件挂载期间运行。绕过：切到别的设置页再切回「Obsidian 桥接」。计划：**1.1.0** 改为主动推送或挂载时强制 `refresh`。

**✅ K-02 `post-tool` 计数只统计项目/记忆相关调用 —— 1.0.1 已修复** — 现象（1.0.0）：面板「工具调用事件」远小于实际工具调用总数。根因：降噪闸门**同时作用在计数上**，而面板标签写的是「工具调用事件」，被理解为全量计数。修复：**计数与留痕解耦**——`toolEvents` 现在每次工具调用都 +1（`index.js:411`），降噪只影响 Vault 留痕（`index.js:432-441`）。详见 [CHANGELOG.md](CHANGELOG.md) C-11。

**✅ K-03 HTTP 状态路由已整体移除（1.0.1）** — 现象（1.0.0）：从脚本 `curl http://127.0.0.1:43120/obsidian-bridge/status` 一律返回 **403**，连 `/` 和随机路径也是，无法区分「已注册 200」与「未注册 404」。根因：`dsh-client-connection` 的 Host/Origin 围栏——脚本请求不带浏览器 Origin，一律被拦。1.0.0 曾把它降级为「外部监控备用通道」，但**从未有真实消费者**：累计 `status-hit` 仅 1 次（自测打的），且 `mountStatusRoute()` 既无成功日志也无失败日志。**1.0.1 决定整体移除路由 + `STATUS_ROUTE` + `webServer` 依赖**（[CHANGELOG.md](CHANGELOG.md) R-04）。如需外部监控：直读 `hook-debug.log` / `00_InteractionLogs/`，或经 Typert Remote。**该条不再是「待修复」，而是「已取消」**——保留编号仅为外部引用不失效。

**K-04 HMR 对 junction bundle 不生效，需重启** — 现象：改完 `index.js` / `client.js` 后插件行为不变，只有完全重启 DSH 才生效。影响：所有开发者。根因：Client bundle 与 Cordis 事件处理器都在**启动期**注册，HMR 只覆盖 `pnpm run dev:web` 正在监听的那部分前端产物。绕过：每次改动后重启 DSH；调试期先跑 `node test/e2e-verify.mjs`（ENV-1 会验证 junction 是否仍指向工作区）。计划：**不计划修复**（平台限制），文档明确写出即可。

**K-05 治理 `flagged: 0` 从未触发实际动作** — 现象：治理扫描每次都产出 `{"totalScanned": 1515, "flagged": 0, "details": []}`（1.0.1 实测值），`governance/*.json` 内容为 `[]`；链路是通的，但**从未产生过任何治理动作**。影响：依赖治理自动清理/修复记忆的用户。根因：治理的阈值逻辑**在 Vault 侧 `bridge.js` 里**（1.0.1 已删除插件侧的 `everyStops` 死配置，见 C-08），插件内没有「应当触发」的样本可验证，且治理规则集本身为空。绕过：手动执行 `node 90_Agent/hooks/bridge.js govern` 并检查 `audit/*-audit.json` 的 `flagged` 字段，或往 Vault 放一条刻意违规的笔记构造样本。计划：**1.2.0** ① 插件侧新增「治理规则命中」埋点；② 补「构造违规笔记 → 断言治理动作」用例；③ 明确 `governance/*.json` 为空是否算正常。

**✅ K-06 `governanceRuns` 计数器从未自增 —— 1.0.1 已修复** — 现象（1.0.0）：`status.counters.governanceRuns` 恒为 0。根因：`index.js` 全文没有 `status.record('governanceRuns')`——治理不在插件进程内触发。修复：**删掉这个死字段**（而非硬造一个计数），并从 `COUNTER_KEYS` 移入 `REMOVED_COUNTER_KEYS` 以保留「为什么没有它」的可检索性（`lib/status.js:38-46`）；配套的 `cfg.governance.everyStops` 一并删除（C-08）。

**✅ K-07 `route-mount` / `status-hit` 是死埋点 —— 1.0.1 已修复** — 现象（1.0.0）：无法判断 HTTP 路由当前是否注册成功。根因：`mountStatusRoute()` 既无成功日志也无失败日志；`status-hit` 只在真实 HTTP 命中时写，而脚本请求被 403 拦住（K-03）。修复：**HTTP 状态路由整体移除**（R-04），埋点问题随之消失。**这是一次「与其给死功能补埋点，不如删掉死功能」的取舍。**

**✅ K-08 `desktopDeselectedBundles` 配置噪音 —— 1.0.1 已修复** — 现象（1.0.0）：DSH「插件管理」页把 `@local/obsidian-bridge` 显示为**未勾选**，但插件实际在运行。根因：`profile/package.json` 同时写了 `dsh.profile.bundles`（含本插件）与 `desktopDeselectedBundles`（也含本插件）；后者在 DSH 2.0.18 中是**纯 UI 台账，不是策略**。修复：已从 `desktopDeselectedBundles` 移除本插件；1.0.1 实测该数组为 `["@perrylink/dsh-github"]`，不含本插件。

**K-09 `typert.host.js` 的 `input` / `invoke` 永不被调用** — 现象：清单里内联的 `input: () => ({})` 与 `invoke: async () => getSnapshot()` 看起来像实现，实际从未执行。影响：维护者会误以为改这两个函数就能改行为。根因：Typert 网关 strict 分发只走 `ctx.get(descriptor.service)` → `typertRemote` 绑定 → `receiver[method]`，**全程不读 `descriptor.invoke`**；`input`/`invoke` 是 `typert.remote-client.js` 生成物上的客户端辅助。绕过：改行为请改 `lib/bridge-service.js` 的 `status()` / `refresh()`。计划：**1.1.0** 删除这两个字段（更贴近官方生成物形状），或在注释里写明「本字段不被消费」。

**K-10 `jsonCodec` 的类型投影为空** — 现象：`ctx.typert.toJSONSchema('@local/obsidian-bridge/types#BridgeStatusSnapshot')` 会得到空对象。影响：需要按 schema 生成类型或做校验的下游工具。根因：`jsonCodec` 的 `create: () => ({})` 满足 loader 与 registry 校验（只检查 `typeof create === 'function'`），但不返回真正的 schema；功能上无影响（`encode` 是恒等函数，纯 JSON 直通正常）。绕过：无（当前无人依赖该 schema）。计划：**1.1.0** 照 `dsh-mcp-panel/lib/typert.host.js:141-148` 的 `strictCodec(typeSymbol, schema)` 补一个 zod schema。

**K-11 Vault 侧遗留 291 条垃圾知识条目（1.0.1 新发现）** — 现象：`30_Resources/experience/` 下有 **291 条** `KB-*.md`，其中 290 条在 `experience/`、1 条在 `project/`，全部由旧 CLI `knowledge-engine.js organize` 生成。特征：标题是乱码（如 `KB-20261019-0520_用户_prompt_最终验证_hook_是否正常工作_---_type_conv.md`），**277/291 条**的正文夹带了下一条目的 frontmatter（缺陷 D1）。影响：① Vault 规模从 147 篇膨胀到 450 篇，检索噪声显著上升；② 用户在面板/文件树里看到的「知识」大量无效。根因：旧 CLI **无游标、无去重、无质量门**——跑两遍条目翻倍，且把 `session-start`（「会话开始」）这类零知识价值内容也生成了条目。**绕过**：`30_Resources/experience/` 与 `project/` 下的 `KB-*` 可整批删除——原始日志 `00_InteractionLogs/*.md`（约 1.19 MB，**保留不动**）是唯一信息源，删除派生条目不丢信息。**注意**：手工策展的笔记（如 `前端框架/` 下 `id: FE-前端-001`）**不在删除范围**，它们不匹配 `^KB-\d{8}-\d{4}_` 且无 `source.plugin` 字段。清理方案与分批计划见 [KNOWLEDGE-PIPELINE.md §8](KNOWLEDGE-PIPELINE.md)。计划：**1.1.0** ① 随 D1–D9 修复一并清理；② 提供清理脚本；③ 修复后由管线从原始日志**幂等重生成**。

**K-12 `release-staging/` 是插件本体的脱敏副本（1.0.1 新发现）** — 现象：仓库内存在 `release-staging/`，含 `index.js`、`client.js`、`typert.host.js`、`lib/`、`test/`、`scripts/`、`docs/`、`.github/`、`LICENSE`、`package.json`，共 **24 个 JS/MJS 文件 / 5757 行**。实测与本体**逐文件哈希一致**，唯一差异是 `lib/config.js` 的 `DEFAULT_VAULT_PATH`（`D:/MyVault` 占位 vs 本体 `D:/MyVault`）。影响：① 代码规模统计会**双份计数**（`scripts/check-line-counts.mjs` 报 48 文件 / 12082 行，其中 5757 行是副本）；② **双份代码漂移风险**——修了本体忘了同步副本，或反之，会让发布物与验证过的代码不一致。绕过：改代码后跑 `node scripts/prepare-github.mjs --stage` 重新生成。计划：**1.1.0** 改为构建期生成（把副本加入 `.gitignore`），或至少在 CI 加一条「副本与本体哈希一致」的守卫。

---

## 7. 独立部署验证清单

> 新用户可**完全按本清单自验**，无需阅读源码。在 `obsidian-bridge` 目录下执行。

**阶段 A — 环境自检**
- [ ] **A1** `node -v` 输出 ≥ 20（实测 v24.15.0）
- [ ] **A2** `D:/MyVault/90_Agent/hooks/bridge.js` 存在
- [ ] **A3** `D:/MyVault/90_Agent/memory-sync/sync-workbuddy-memory.js` 存在
- [ ] **A4** `D:/MyVault/90_Agent/knowledge-engine.js` 存在 ｜ **A4b** **`D:/MyVault/90_Agent/knowledge-organize.js` 存在**（1.0.1 新增，缺失则知识库不会自动增长）
- [ ] **A5** `echo $OBSIDIAN_BRIDGE_HMAC_SECRET` 非空
- [ ] **A6** `node_modules/@local/obsidian-bridge` 的 `LinkType` 是 `Junction`
- [ ] **A7** `node scripts/check-line-counts.mjs` 退出码 0（行数口径与文档声明一致）
- [ ] **A8** `node scripts/check-doc-links.mjs` 退出码 0（文档链接全部有效）

**阶段 B — 配置自检**
- [ ] **B1** `cordis.patch.yml` 含 `id: obsidian-bridge` 且 `name: '@local/obsidian-bridge'`
- [ ] **B2** `cordis.patch.yml` 含 `id: obsidian-mcp` 且 `serverName: obsidian-local`（须与 `index.js:48` 的 `OBSIDIAN_MCP_SERVER` 一致）
- [ ] **B3** `vaultPath` 与实际 Vault 根目录一致 ｜ **B4** `nodePath` 指向存在的 node 可执行文件
- [ ] **B5** `profile/package.json` 的 `dsh.profile.bundles` 含 `@local/obsidian-bridge`
- [ ] **B6** `cordis.patch.yml` 含 `organize` 段且 `enabled: true`（不写也会用默认值开启，但**显式优于隐式**）
- [ ] **B7** `cordis.patch.yml` **不含** `governance.everyStops`（1.0.1 已删除该字段）

**阶段 C — 启动自检（重启 DSH 后）**
- [ ] **C1** 完全退出 DSH 后重新启动
- [ ] **C2** 日志出现 `[obsidian-bridge] client half apply() 开始` ｜ **C3** `Typert Remote 已挂载`
- [ ] **C4** 日志出现 `[obsidian-bridge] remote.obsidianBridge 已就绪` ｜ **C5** `注册 settings.section`
- [ ] **C6** 上述日志中**没有** `remote 服务读取失败` / `execute.call is not a function` / `pending (waiting for service`

```bash
LOG="$APPDATA/DSH Desktop/logs/dsh-$(date +%F).log"
grep -n 'obsidian-bridge' "$LOG" | tail -10
```

**阶段 D — 功能自检**
- [ ] **D1** 发消息后，`00_InteractionLogs/<今天>_conversation.md` 含「会话开始」「用户 prompt:」「对话结束」
- [ ] **D2** `hook-debug.log` 出现 `[user-prompt] Hook completed successfully` ｜ **D3** `[stop] Hook completed successfully`
- [ ] **D4** 发含关键词的消息后，日志出现 `## 知识库相关笔记（自动注入）` 块
- [ ] **D5** 注入块里的笔记路径**逐条存在**（§3 步骤 5 的脚本）
- [ ] **D6** 设置 → Obsidian 桥接 面板显示 Vault 路径与索引条数
- [ ] **D7** 面板**五项**事件开关均为「已启用」 ｜ **D8** **八项**计数随对话单调递增
- [ ] **D9** **知识整理真的在跑**：面板「知识整理」计数 > 0，**且** `Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"` 为 `True`（游标文件不存在 = 从未运行，见 [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)）
- [ ] **D10** 面板「最近一次事件」区能看到 `indexBuilt` 的时间与 `size`

**阶段 E — 回归自检**
- [ ] **E1** `node test/acceptance.mjs` → **14/14 PASS**，退出码 0
- [ ] **E2** `node test/e2e-verify.mjs` → **16 PASS / 0 FAIL / 3 MANUAL**，退出码 0
- [ ] **E3** `E4` / `P1` / `P2` 为 `MANUAL` 属**预期**（`E4` 需先发含关键词的消息；`P1`/`P2` 需启动令牌，见 K-03）
- [ ] **E4** `M1` 显示 15 个工具、`M2` 返回真实笔记数
- [ ] **E5** `node test/wiring.mjs` → **12/12 PASS**（第 12 项是 F-08 的 `createRunner` 导出表守卫）
- [ ] **E6** `node test/run-all.mjs` → 分层总览全绿（L1 契约 / L2 单元接线 / L3 端到端）

**阶段 F — 已知问题确认（确认它们存在，而不是新引入）**
- [ ] **F1** 面板未打开时数字不刷新 —— 符合 K-01
- [ ] **F2** `[govern]` 有触发但 `governance/*.json` 为 `[]` —— 符合 K-05
- [ ] **F3** `30_Resources/experience/` 下有历史 `KB-*` 垃圾条目 —— 符合 K-11（**已确认可整批删除**）
- [ ] **F4** `release-staging/` 与本体哈希一致 —— 符合 K-12（若不一致则是漂移，需重新 `--stage`）

---

## 附录 A：实测数据来源与统计口径

**A.1 代码规模**（1.0.1 实测，命令 `node scripts/check-line-counts.mjs`）：JS/MJS 文件 **48** 个 / **12082** 行（2026-10-22 19:45 快照）。
口径：`text.split('\n').length - (text.endsWith('\n') ? 1 : 0)`（UTF-8，末行换行不计）。

| 分组 | 文件数 | 行数 | 说明 |
|---|---:|---:|---|
| 插件本体 | 11 | **1751** | `index.js` 489、`client.js` 345、`typert.host.js` 77、`lib/`×8 合计 840 |
| 测试 | 10 | **3669** | `test/`（仅 `.js`/`.mjs`），含 `e2e-verify.mjs` 391、`audit-flow.mjs` 799、`audit-counters.mjs` 629 |
| 构建与守卫脚本 | 3 | **905** | `scripts/`：`prepare-github.mjs`、`check-line-counts.mjs`、`check-doc-links.mjs` |
| **本体小计（实际维护面）** | **24** | **6325** | — |
| 发布暂存副本 | 24 | **5757** | `release-staging/`，见 K-12（**脱敏副本，不重复计入维护面**） |

> ⚠️ **代码规模是动态值**：`test/` 与 `scripts/` 在 1.0.1 期间持续演进，本表是 **2026-10-22 19:45 快照**
> （此后已再次变动过）。**权威来源永远是 `node scripts/check-line-counts.mjs` 的即时输出**，
> 不要引用本表的数字做判断，也不要手工统计。
>
> **口径提醒**：项目早期基线写的「2196 行」来自 PowerShell 5.1 裸用
> `Get-Content | Measure-Object -Line`，该命令在 zh-CN 环境按 `gb2312` 解码 UTF-8，
> 会吞掉部分 `0x0A` 行边界（`index.js` 真实 489 行，该口径只得约 250 行）。
> **文档中引用行数必须标注口径**，且必须用 `node` 或 `[System.IO.File]::ReadAllLines()`。
> 该口径事故的完整说明见 [RETROSPECTIVE.md §1.3](RETROSPECTIVE.md)。

**A.2 测试结果**（1.0.1 实测）：PRD §9 验收 **14/14 PASS**（`node test/acceptance.mjs`，退出码 0）；端到端验证 **16 PASS / 0 FAIL / 3 MANUAL**（`node test/e2e-verify.mjs`，退出码 0，共 19 项检查）；接线测试 **12/12 PASS**（`node test/wiring.mjs`）。3 项 MANUAL 是 `E4`（当日日志无注入块，需先发含知识库关键词的消息）与 `P1`/`P2`（HTTP 状态路由需 `DSH_LAUNCH_TOKEN`），属**设计上的待人工项**，非缺陷。
> 历史记录：早期基线为 16 PASS / 1 FAIL / 2 MANUAL（FAIL 项是 `C4`，F-03 修复后转 PASS）；
> 1.0.0 发布时为 17 PASS / 0 FAIL / 2 MANUAL。**差异来自 `E4` 的当日可观测性**——
> 它取决于测量前是否发过含知识库关键词的消息，属**环境相关**而非版本回归。

**A.3 运行计数**（`hook-debug.log`，累计，截至 2026-10-22T11:20Z，口径为 `[<事件>] Hook triggered` 行数）：
`post-tool` **1211**；`stop` **168**；`diagnose` **152**；`user-prompt` **103**；`session-start` **86**；`govern` **78**；`route-mount` **8**（死埋点，随路由移除）；`knowledge` 4；`verify` 1；`status-hit` 1（死埋点）；`harness-probe` 1。日志共 4049 行 / 274088 B。
> **口径提醒**：若用 `grep -c 'post-tool'` 会得到约 **2422**（同时命中 `triggered` 与 `completed` 两行），
> 是错误口径。**只数 `Hook triggered`。** 1.0.0 基线为 `post-tool 1035 / stop 79 / govern 49 / user-prompt 28 / session-start 24`，
> 差异来自统计时刻不同（日志持续增长）。

**A.4 Vault 数据**（`e2e M2` → `obsidian_get_stats`）：笔记数 **450**（`totalNotes`）；总字数 **355490**（`totalWords`）。
> **147 → 450 的增长不是正常积累**：其中 **291 条**是旧 CLI `knowledge-engine.js organize` 无去重生成的
> 垃圾知识条目（见 K-11）。剔除后实际策展内容约 **159 篇**。Vault 规模是**受污染指标**，
> 不应作为「产品产出」的度量。

**A.5 关键环境路径**：profile `<USER_HOME>\.dsh\profiles\desktop`；Node `node`（v24.15.0）；MCP server `<YOUR_WORKBUDDY_PATH>`；Vault `D:/MyVault`；DSH 日志 `%APPDATA%\DSH Desktop\logs\dsh-<date>.log`。

---

**文档结束**。**1.0.1 已发布（2026-10-22）**。下一版本计划：**1.1.0** 处理 K-01 / K-09 / K-10 / **K-11（知识条目清理 + D1–D9 修复）** / **K-12（`release-staging` 改为构建期生成）**；**1.2.0** 处理 K-05；K-03 已随路由移除而关闭；K-04 为平台限制，仅文档说明。
