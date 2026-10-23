# Obsidian Bridge（DeepSeek Harness 插件）

**DSH 插件**：把 DSH 的对话 / 工具 / 回合 / 会话事件自动留痕到 Obsidian Vault，
并自动检索知识库注入上下文。

> **来源**：最初是 `WorkBuddy-Obsidian-Bridge` PRD（面向 WorkBuddy 的 Hook 方案）。
> WorkBuddy 中国版的 Hook 自动触发不可靠（PRD §10.3 Q1/Q2 未解决），
> 因此改为 **DSH Cordis 插件** —— 事件来源是 DSH 自己的 Cordis 事件总线，
> 不依赖 WorkBuddy 的 Hook。留痕动作复用 Vault 里的 `90_Agent/hooks/bridge.js`。

## 安装状态

已安装到 profile `desktop`，两行均 `enabled: true` / `fiberPhase: active`：

- `include:obsidian-bridge` — 自动桥接插件
- `include:obsidian-mcp` — 复用现有 `obsidian-mcp-bridge`，注册 15 个 `mcp__obsidian-local__*` 工具

bundle 目录即本目录（junction 到 profile 的 `node_modules/@local/obsidian-bridge`）。

## 架构

```
DSH Host
├── obsidian-bridge（本插件）
│   ├── agent/pre-step        → 提关键词 → ctx.fs 内存索引检索 → 注入上下文 + 留痕
│   ├── tools/result          → 计数（全量）+ 项目/记忆操作检测 → 留痕
│   ├── agent/turn-stopping   → 响应摘要留痕 → 触发知识整理（节流）
│   ├── agent/created         → 记忆同步 + 会话开始
│   └── Typert Remote         → obsidianBridge.status / .refresh（Client 面板取数）
└── obsidian-local（MCP）     → 15 个 Vault 工具
```

**写操作一律走 `ctx.subprocess`。** `@deepseek-ai/dsh-fs-sandbox` 按会话 sandbox 模式
围栏 `ctx.fs` 的写操作（默认 `read-only`，`workspace-write` 只放行会话工作区 + 临时
目录），直接写你的 Vault 会被拒。子进程缝不被 sandbox 消费层围栏。
读操作走 `ctx.fs`（sandbox 放行读）。

> **⚠️ 1.0.1 变更**：HTTP 状态路由（`GET /obsidian-bridge/status`）与 `webServer` 依赖
> **已整体移除**——Client 半边没有 `fetch`（见下文「网络限制」），该路由从未有真实消费者。
> 面板取数只走 Typert Remote。同时新增**自动知识条目整理**（`agent/turn-stopping` → `organize`）。

> **⚠️ 1.0.2 变更**：
> 1. **工具调用改用独立日志类型 `tool-op`**（原先兜底写成 `thinking`）。
>    此前 `thinking.md` 965 条 section 中**真思考 0 条**，且被提炼成标题为 `Bash`/`pwsh`
>    的「知识条目」。`tool-op` **不产生知识条目**，只留痕。
> 2. **日志文件名改用本地时区**（原先用 UTC，UTC+8 下「今天的日志」会写成昨天）。
> 3. **HMAC 密钥现在会传给子进程**（原先静默回落到硬编码公开密钥）。
> 4. **交叉评审修复 14 个缺陷**（空 `summary:` 静默丢笔记、`maybeOrganize` 失败零观测等），
>    详见 `docs/CHANGELOG.md`。
> 5. **新增 `node scripts/verify-install.mjs`** —— 重启后一条命令自检全部关键项。

## 事件映射（PRD §5.1.2）

| PRD Hook | DSH 事件 | 模式 | 实现 |
|---|---|---|---|
| `UserPromptSubmit` | `agent/pre-step` | waterfall | `await next()` → 展开 decision → 追加注入消息 |
| `PostToolUse` | `tools/result` | emit | 全量计数 + 项目/记忆关键词检测（留痕降噪） |
| `Stop` | `agent/turn-stopping` | serial | 响应摘要 + 触发知识整理（`maybeOrganize()`） |
| `SessionStart` | `agent/created` | serial | 记忆同步（子代理跳过） |

> **`tools/result` 的签名必须是位置参数 `(exec, result)`**，不能写成 `({ exec })` 解构——
> 后者会得到 `undefined`，导致整个处理器**静默失效**（计数恒 0、留痕全丢）。
> 证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502`、`dsh-tools/lib/types/index.js:1079`。
> 对比：`agent/*` 系列是 waterfall/serial，载荷是对象，所以用 `({ agent })`。
> **两类事件的签名不同，不能照抄。**

注入消息用 `source.kind: 'runtime-context'`，因此不会被后续的
`source.kind === 'user'` 判定误认为用户输入，也不会重复注入。

## 对既有资产的修复

| 文件 | 问题 | 修复 |
|---|---|---|
| `obsidian-mcp-bridge/src/server.js` | 响应缺 `jsonrpc:"2.0"` → `SdkError: Request timed out` | 补字段 |
| `90_Agent/hooks/bridge.js` | `logInteraction` 内联写出器把嵌套对象写成 `[object Object]` | 改用 `frontmatterYaml` |
| `90_Agent/hooks/bridge.js` | frontmatter 解析不支持缩进嵌套 | 重写为缩进感知 |
| `90_Agent/hooks/bridge.js` | 交互日志缺知识条目字段（PRD Q4，schema 校验恒 false） | 补全 9 个必需字段 |
| `90_Agent/hooks/bridge.js` | 治理只解析文件第一个 frontmatter 块 | 遍历全部块 |
| `90_Agent/hooks/bridge.js` | `knowledge` 命令提前 `return` 跳过输出 | 修正控制流 |
| `90_Agent/hooks/bridge.js` | HMAC 密钥硬编码（PRD Q5） | 读 `OBSIDIAN_BRIDGE_HMAC_SECRET` |
| `90_Agent/hooks/auto-bridge.js` | `tags:/n` 语法错误（PRD §10.2） | 修正 |
| `90_Agent/memory-sync/sync-workbuddy-memory.js` | 工作区记忆目录硬编码（PRD §10.2） | 支持 `--workspace-memory-dir` / 环境变量 |
| `90_Agent/knowledge-engine.js` | 类型正则 `\w+` 不匹配带连字符的类型（`project-op`/`memory-op`），`organize` 静默跳过这些条目 | 改为 `[\w-]+` |
| `90_Agent/knowledge-engine.js` | `body` 取 `slice(3)` 丢掉正文首行，生成的标题全是乱码 | 改为 `slice(2)` |

## 验证

```bash
node test/run-all.mjs      # 分层总览：L1 契约 / L2 单元接线 / L3 端到端
node test/acceptance.mjs   # 14/14：PRD §9 验收标准逐条核对（推荐，重启后跑这个）
node test/e2e-verify.mjs   # 19 项：分层端到端（断言外部产物，含 Client↔Host 层）
node test/wiring.mjs       # 12 项：接线测试（mock Cordis ctx 加载真实 index.js）
node test/run.mjs          # 18 项：单元测试（含真实 Vault 扫描与检索）

node scripts/check-line-counts.mjs   # 行数口径守卫（核对文档里的行数声明）
node scripts/check-doc-links.mjs     # 文档链接守卫
```

`run.mjs` / `wiring.mjs` 需要解析 `@deepseek-ai/schemastery`（npm 上只有过期的
`0.0.1-rc.1`，Harness 用的是 `0.2.1-rc.2`），从工作区直接跑会 `ERR_MODULE_NOT_FOUND`。
它们面向开发调试；日常验证跑 `acceptance.mjs` 即可，它已内置该处理
（自动复制到 profile 临时目录执行后清理）。

当前验收结果（1.0.1，2026-10-22）：**14/14 PASS**；`e2e-verify.mjs` **16 PASS / 0 FAIL / 3 MANUAL**；
`wiring.mjs` **12/12 PASS**。

实盘已验证：`hook-debug.log` 中 **1211** 条 `post-tool` 事件由插件触发；
`audit/*-integrity.json` 的 `contentHash` / `signature` / `schema` / `overall` 全为 `true`；
`governance/` 与 `audit/` 治理产物生成；记忆同步 4/4 成功。

> **⚠️ 别只看 `acceptance.mjs` 的 14/14。** 它**不覆盖** Client↔Host 通道，
> 也不覆盖「知识库是否在增长」。完整的判据见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## GUI 状态面板：已启用并验证

Client 半边是 `client.js`：注册 `settings.section` 槽位（`replaceRisk: none`，非遮蔽追加），
渲染「Obsidian 桥接」设置页。**数据经 Typert Remote 从 Host 取**（`ctx.inject(['remote.obsidianBridge'], …)`
→ `unwrap(await service.status())`），不走 HTTP。

**验证结果**（重启后实测）：

- Client 半边成功激活，日志出现 `[obsidian-bridge] client half apply() 开始`
- 槽位已注册：`settings.section` 第 7 个 occupant ——
  `{ "registrant": "obsidian-bridge", "id": "obsidian-bridge", "order": 90, "active": true }`
- 数据通路：`[obsidian-bridge] remote.obsidianBridge 已就绪` → `[obsidian-bridge] 面板首次取数成功，vaultPath=…`

> **⚠️ 1.0.1 更正**：本段 1.0.0 版本写的是「数据取自 Host 的 `GET /obsidian-bridge/status`（同源请求，
> 随浏览器会话携带鉴权）」，并列出数据通路日志 `[obsidian-bridge] 状态路由请求成功`。
> **这两处都已失效**：Client 半边**没有 `fetch`**（见「网络限制」），该路由从未被面板使用过，
> 且已于 1.0.1 整体移除。发布的公开 README 骨架见
> `docs/RELEASE-SECURITY.md §3.6`（未随仓库发布）。

### 关键约定（踩过的坑，务必照抄）

#### Client 半边

| 项 | 正确写法 | 错误写法（boot 失败或取不到数） |
|---|---|---|
| factory 形式 | `factory: (require) => { ... }` | `factory(require) { ... }` |
| 返回值 | `var module = { exports: {} }` … `return module.exports` | 返回对象字面量 `{inject, apply}` |
| `apply` | **`async function apply(ctx)`** | 同步 `apply(ctx) {}` |
| 导出 | `exports.apply` / `exports.inject` / `exports.name` | 字面量字段 |
| 取 Remote 命名空间 | **`ctx.inject(['remote.<ns>'], scope => ...)`** | 直接读 `ctx.remote.<ns>`（静默 undefined） |
| 注册 disposer | `const follow = ctx.inject(...)` + `ctx.effect(() => follow.dispose())` | `ctx.effect(follow)`（fiber wrapper 不是函数 → `execute.call` 报错 + 卸载泄漏） |
| `dsh.client.inject` | 含 `@deepseek-ai/dsh-api-remotes` | 漏掉它（启动竞态窗口） |

#### Host 半边

| 项 | 正确写法 | 错误写法 |
|---|---|---|
| Typert Remote 服务 | `class XxxService extends TypertRemoteService` + `super(ctx,'<key>')` + `ctx.plugin(XxxService)` | 只在清单里写 `service: '<key>'`（悬空 → `gateway/service-unavailable`） |
| 注入 `harness` | 不要注入（动态包沙箱专属；注入后插件永久 pending） | `inject: ['harness']` |
| 注入 `webServer` | **不要注入**（1.0.1 已移除该依赖，`inject` 现为 `['agents','fs','subprocess']`） | 为 HTTP 路由注入它（Client 无 `fetch`，路由是死路） |
| `tools/result` 处理器 | 位置参数 `(exec, result)` + 防御性归一 | `({ exec })` 解构（恒 undefined → **整个处理器静默失效**） |
| `runner.*` 调用 | 新增调用后**核对 `createRunner()` 的导出表**（`lib/writer.js:140-154`） | 调用未导出的方法（抛错被 `.catch(() => {})` 吞掉 → **静默从未运行**） |
| 知识整理接线 | `agent/turn-stopping` → `maybeOrganize()`，带 `minIntervalMs` 节流 | 只写脚本不接线（1.0.0 的 `knowledge-engine.js organize` **无任何自动调用方**） |
| `enabled.prompt` | 它是 **prompt 处理总开关**：留痕 + 计数 + 注入一起控制 | 以为它只控制留痕（1.0.0 行为，已修） |

> **「调用了未导出的方法」是 1.0.1 修掉的最严重缺陷**（`runner.spawn`）。
> 它与 `runner.bridge` 在源码阅读上完全对称，**静态阅读无法发现**。
> 回归守卫见 `test/wiring.mjs` 第 12 项；完整根因见
> [docs/RETROSPECTIVE.md §4.8](docs/RETROSPECTIVE.md) 与 [docs/CHANGELOG.md](docs/CHANGELOG.md) F-08。

## v1.0.1 修复（2026-10-22）

| 编号 | 一句话 | 影响 |
|---|---|---|
| **F-08** | **`runner.spawn` 未导出 → 知识整理静默从未运行** | 知识库永不自动增长（用户实际遇到的问题） |
| F-09 | `writeFailures` 只计数不打日志 | 四条失败分支里三条日志零输出 |
| F-10 | 索引失败伪装成空 Vault | 面板把「扫描失败」显示成「空 Vault」 |
| F-11 | HMR 快照跨实例泄漏 | 重新激活读到上一个实例的 `sessionStarts: 1` |
| F-12 | `decision.messages` 缺失会中断整个回合 | waterfall 无异常兜底 |
| F-13 | `touch()` 位置错误使面板停在旧值 | 「留痕了但没注入」时快照不刷新 |
| C-09 | `enabled.prompt` 现在同时控制注入 | 此前关掉开关后面板显示「已停用」但知识仍被注入 |
| R-04 | 移除 `STATUS_URL` / `STATUS_ROUTE` / `mountStatusRoute()` / `webServer` | 删掉从未有消费者的死通道 |
| A-14…A-18 | 新增自动知识条目整理（`organize.*`） | 知识库开始自动增长 |
| A-19…A-20 | 索引失败可观测 + MCP 工具数真实统计 | 面板不再显示常量 |

完整变更见 [docs/CHANGELOG.md](docs/CHANGELOG.md) 的 `## [1.0.1] - 2026-10-22`。

#### 证据

- `dsh-api-gateway/lib/index.js:1224-1229`、`:1191-1194`、`:1698-1706` —— 网关按 `ctx.get(descriptor.service)` 解析
- `dsh-typert-protocol/lib/index.js:326-352` —— `bindTypertRemote` 写入绑定
- `dsh-api-gateway/lib/client.browser.js:1669`、`:1696`、`:1773`、`:2031`、`:2101` —— `$mount` 全链路
- `dsh-mcp-panel/lib/index.js:2399-2425`、`:2896` —— 官方参考实现
- `cordis/lib/index.js:1142`、`:1600-1606` —— `ctx.effect` / fiber wrapper

#### 网络限制

**Client 半边没有网络能力**（DSH 文档原文："network belongs to the HOST half"）。
`fetch` / `setTimeout` 等浏览器全局不可用。跨 Host 的数据获取必须走
Typert Remote 或 `ctx` 服务，不能走 HTTP。

参考实现：profile 中的第三方 bundle `dsh-mcp-panel`（同槽位 + 同款 Typert Remote）。
