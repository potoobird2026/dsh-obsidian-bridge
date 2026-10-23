# 配置参考（CONFIG）

> 适用版本：`@local/obsidian-bridge` **1.0.1**
> 配套文档：[RELEASE-1.0.md](RELEASE-1.0.md)（发布说明）｜ [CHANGELOG.md](CHANGELOG.md)（版本变更）｜
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（故障排查）
> **数据来源**：`lib/config.js`（schema 与默认值）、`cordis.patch.yml`（实测配置）。所有默认值均取自
> `lib/config.js:72-101` 的 `resolveConfig()`，非文档臆测。

## 目录

1. [配置写在哪个文件](#1-配置写在哪个文件)
2. [14 个配置项总表](#2-14-个配置项总表)
3. [逐项详解](#3-逐项详解)
4. [完整可复制示例](#4-完整可复制示例)
5. [`enabled.*` 的关闭语义（易踩）](#5-enabled-的关闭语义易踩)
6. [配置外的项：`SCAN_ROOTS`](#6-配置外的项scan_roots)
7. [环境变量](#7-环境变量)
8. [沙箱与读写通道](#8-沙箱与读写通道)
9. [常见配置错误](#9-常见配置错误)

---

## 1. 配置写在哪个文件

配置**只有一个来源**：`obsidian-bridge/cordis.patch.yml` 的 `config` 段。Loader 把它传给 `apply(ctx, config)`。

```yaml
- insert:
    - id: obsidian-bridge
      name: '@local/obsidian-bridge'
      config:
        vaultPath: D:/MyVault          # ← 配置从这里开始
        ...
```

**没有**其他配置文件（无 `.env`、无 `settings.json`、无环境变量覆盖表）。除 §7 的两个环境变量外，
所有行为都由这个 YAML 决定。

> **漏填不会让插件激活失败。** `resolveConfig()` 为每个字段提供防御性默认值（`lib/config.js:72-101`）。
> 代价是：**漏配时静默使用默认值**，行为与你的预期不符却没有任何报错。因此部署后务必对照 §4 逐项核对。
>
> ⚠️ **`organize` 段尤其要注意**：它带 `enabled: true` 的默认值，也就是说**即使你不写这一段，
> 自动知识整理也是开启的**（默认 `batchLimit: 20` / `minIntervalMs: 300000`）。
> 想关掉必须显式写 `organize.enabled: false`。

---

## 2. 14 个配置项总表

| # | 配置项 | 类型 | 默认值 | 必填性 | 一句话作用 |
|---|---|---|---|---|---|
| 1 | `vaultPath` | string | `D:/MyVault` | 语义必填 | Vault 根目录；写操作的 `cwd`、扫描根前缀、子进程环境变量 |
| 2 | `nodePath` | string | `''`（⇒ 裸名 `node`） | 建议填 | 执行 Vault 内四个脚本的 Node 可执行文件 |
| 3 | `hmacSecretEnv` | string | `OBSIDIAN_BRIDGE_HMAC_SECRET` | 建议保持默认 | **只提供环境变量名**，插件本身不读密钥 |
| 4 | `enabled.prompt` | boolean | `true` | 否 | prompt 处理总开关：留痕 + 计数 + **知识注入** |
| 5 | `enabled.tool` | boolean | `true` | 否 | 是否写 `post-tool` 留痕（计数不受影响） |
| 6 | `enabled.stop` | boolean | `true` | 否 | 是否写 `stop` 摘要 + **是否触发知识整理** |
| 7 | `enabled.sessionStart` | boolean | `true` | 否 | 是否做记忆同步 + 写 `session-start` 留痕 |
| 8 | `inject.enabled` | boolean | `true` | 否 | 知识注入的独立开关 |
| 9 | `inject.limit` | number | `3` | 否 | 单次注入的最大条目数 |
| 10 | `inject.minKeywordLength` | number | `2` | 否 | 参与关键词提取的最短词长 |
| 11 | `organize.enabled` | boolean | `true` | 否 | 是否自动把交互日志提炼为知识条目 |
| 12 | `organize.batchLimit` | number | `20` | 否 | 每次整理最多生成多少条目 |
| 13 | `organize.minIntervalMs` | number | `300000`（5 分钟） | 否 | 两次整理的最小间隔 |
| 14 | `governance.documented` | boolean | `true` | 否 | 是否在面板展示治理配置区（**不参与调度**） |

**必填性说明**：schema（`lib/config.js:9-57`）**没有**把任何字段标为必填——`resolveConfig` 对全部字段
都给了回退值。所以「必填性」一列描述的是**实践中必须填对**，而不是**不填会报错**。

**版本差异**：1.0.0 只有 11 项，其中 `governance.everyStops`（number）是**死配置**——插件侧从未读取它，
治理实际由 Vault 侧 `bridge.js` 的 `runGovernance()` 在每次 `stop` 时自行触发。1.0.1 把它替换为
`governance.documented`，并新增 `organize.*` 三项。详见 [CHANGELOG.md](CHANGELOG.md) 的 C-08 / A-14。

---

## 3. 逐项详解

### 3.1 `vaultPath`

| 项 | 内容 |
|---|---|
| 类型 / 默认 | `string` / `D:/MyVault`（`lib/config.js:59`） |
| 含义 | Vault 根目录。三处使用：① `ctx.subprocess.spawn` 的 `cwd`；② 拼接受入索引扫描的根目录（`SCAN_ROOTS`）；③ 作为 `OBSIDIAN_VAULT_PATH` 传给子进程 |
| 格式 | 用 `/` 作分隔符；尾部 `/` 会被 `scriptPath()` 剥掉（`lib/config.js:109-111`），带不带等价 |
| 填错后果 | **读操作**：`buildVaultIndex` 的 `catch` 会 `continue`（`lib/vault-index.js:111-115`），索引静默为空，注入永远不命中。**写操作**：子进程 `cwd` 不存在，`spawn` 失败，脚本不执行。**两者都只记 debug 日志，对话不会失败**——这是最难发现的一类故障 |
| 示例 | `vaultPath: D:/MyVault` |

> **1.0.1 起填错的可见性改善了**：索引失败现在会记 `indexFailed` 计数器，面板「索引构建失败」行会变红，
> 不再伪装成「空 Vault」（`index.js:198-211`）。但**写入**失败仍主要靠 `writeFailures` 计数器观察。

### 3.2 `nodePath`

| 项 | 内容 |
|---|---|
| 类型 / 默认 | `string` / `''`（空 ⇒ 用裸名 `node`，走 PATH） |
| 含义 | 执行 `bridge.js` / `knowledge-organize.js` / `knowledge-engine.js` / `sync-workbuddy-memory.js` 的 Node 可执行文件 |
| 解析顺序 | ① `ctx.subprocess.resolveExecutable(cfg.nodePath)` → ② 失败回退 `resolveExecutable('node')` → ③ 再失败则**本次调用整体放弃**（`lib/writer.js:25-40`） |
| 为什么必须显式 | DSH 的 `ctx.subprocess` 环境与交互式 shell 的 PATH 不同；不指定可能解析到**版本过旧**的 node，导致 Vault 脚本因语法不兼容而失败 |
| 示例 | `nodePath: node`（本机实测值，Node v24.15.0） |

### 3.3 `hmacSecretEnv`

| 项 | 内容 |
|---|---|
| 类型 / 默认 | `string` / `OBSIDIAN_BRIDGE_HMAC_SECRET` |
| 含义 | **只提供环境变量名**，插件本身不读密钥。密钥由 Vault 内 `bridge.js` 读取，用于给审计记录签 HMAC-SHA256 |
| 为什么不直接配密钥 | 密钥不进仓库、不进日志。Vault 侧读不到该变量会**拒绝签名**并在审计里留痕 |
| 轮换方式 | 改这个变量名，并同步修改 Vault 内 `bridge.js` 的读取逻辑 |
| 示例 | `hmacSecretEnv: OBSIDIAN_BRIDGE_HMAC_SECRET` |

### 3.4 `enabled.prompt` / `enabled.tool` / `enabled.stop` / `enabled.sessionStart`

四个事件开关，**默认全 `true`**。关闭判定统一是 `!== false`（见 §5）。

| 配置项 | 关闭后的效果 |
|---|---|
| `enabled.prompt` | **prompt 处理总开关**：不再写 `user-prompt` 留痕、不再计数，**也不再注入知识** |
| `enabled.tool` | 不再写 `post-tool` 留痕。**但 `toolEvents` 计数照常 +1**（计数与留痕已解耦） |
| `enabled.stop` | 不再写 `stop` 摘要，**也不再触发知识整理**（`maybeOrganize()` 在 `stop` 处理器内） |
| `enabled.sessionStart` | 不再做 WorkBuddy 记忆同步，也不写 `session-start` 留痕 |

> ⚠️ **`enabled.prompt` 的语义在 1.0.1 变了**（[CHANGELOG.md](CHANGELOG.md) C-09）：
>
> | 版本 | 行为 |
> |---|---|
> | 1.0.0 | 只控制「留痕」。关掉后**知识仍会被检索并注入**（注入只受 `inject.enabled` 控制）——面板显示「已停用」但行为没停，属**开关欺骗用户** |
> | **1.0.1** | 控制「留痕 + 计数 + 注入」三者。`index.js:355` 在写留痕与计数**之前**拦截 |
>
> 现在想让插件完全不参与 prompt 处理，**只需设 `enabled.prompt: false`**。
> `inject.enabled` 退化为「在 prompt 处理已开启的前提下，单独关闭注入」的细分开关。

### 3.5 `inject.enabled` / `inject.limit` / `inject.minKeywordLength`

| 配置项 | 默认 | 含义 |
|---|---|---|
| `inject.enabled` | `true` | 知识注入的独立开关。关闭后每轮 prompt 不再检索、不再注入（**留痕不受影响**） |
| `inject.limit` | `3` | 单次注入的**最大**条目数（实际条数取决于检索命中数） |
| `inject.minKeywordLength` | `2` | 参与关键词提取的最短词长，小于该长度的词被丢弃 |

**`inject` 的实测行为**（读代码得到，配置里看不到）：

- 关键词按空白与中英文标点切分，去重后**最多取前 5 个**（`lib/query.js:19-34`）——`limit` 是**结果条数**，
  不是关键词数，两者互不影响。
- 命中语义是 **OR**（任一关键词出现即算命中），与 PRD §5.3.3 的置信度权重并存（`lib/query.js:74`）。
- 正文匹配只取每篇笔记的前 **20000** 字符（`lib/query.js:9`）。
- 索引 TTL **5 分钟**（`index.js:36`）——Vault 里新增的笔记**最多 5 分钟后**才会被检索到。
- 检索失败时**跳过注入、仍记录对话**（`index.js:347-349`），不会让对话失败。

> **`entryCount` 的语义在 1.0.1 变了**（[CHANGELOG.md](CHANGELOG.md) C-10）：
> 注入消息的 `sections[].entryCount` 与 `injections` 计数器的 `last.entries` 此前写的是**配置上限
> `inject.limit`**，现在写的是**实际注入条数**（`results.length`，`index.js:345`、`:370`）。
> 审计时不再需要「命中数 vs 上限」的二次推断。注意 `injections` **计数器本身**的语义是
> 「**产生过注入的 prompt 次数**」，不是条目数——条目数看 `last.injections.entries`。

### 3.6 `organize.enabled` / `organize.batchLimit` / `organize.minIntervalMs`

> **1.0.1 新增。** 这一节对应「知识库为什么不增长」——详见
> [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)。

把交互日志（`00_InteractionLogs/*_conversation.md`）**提炼**为结构化知识条目
（`30_Resources/{category}/KB-*.md`）。`bridge.js` 负责**留痕**（原始日志），本功能负责**提炼**。

| 项 | 内容 |
|---|---|
| 类型 / 默认 | `organize.enabled`：`boolean` / `true`（`lib/config.js:93`）<br>`organize.batchLimit`：`number` / `20`（`:94`）<br>`organize.minIntervalMs`：`number` / `300000`（`:95`） |
| 触发时机 | `agent/turn-stopping`（回合结束）→ `maybeOrganize()`（`index.js:453`、`:463-485`） |
| 执行方式 | `ctx.subprocess` 起子进程跑 `90_Agent/knowledge-organize.js`，stdin 传 `{"limit": batchLimit}`，**不走会话 fs 沙箱**（§8） |
| 节流 | `Date.now() - lastOrganizeAt < minIntervalMs` 时直接返回。`lastOrganizeAt` 是**进程内存**，每次 DSH 启动重置为 0 —— **启动后首次 `stop` 会立即整理一次** |
| 计数 | 退出码 0 → `organizeRuns` +1；非 0 → `organizeFailed` +1（`index.js:478-482`）。面板「知识整理」行显示 `organizeRuns`，有失败时附「失败 N」（`client.js:261-267`） |
| 增量语义 | 脚本用**游标**（`90_Agent/knowledge-organize-cursor.json`）只处理时间戳晚于上次的 section，并按 `contentHash` 去重。**跑两遍不会翻倍** |
| 质量门 | 三道：①类型门（跳过 `session-start`）；②内容门（长度 < 80 字符、或命中「会话开始」「对话结束」等无价值模式）；③system-prompt 泄漏门（`You are a helpful assistant` 等标记） |
| 分类 | 由正文开头与 section 类型映射到 `experience` / `project` / `entity` / `process`（`classify()`） |
| 调大 `batchLimit` 的代价 | 单回合可能写入几十个文件（一次 `fs.writeFileSync` 每个条目），且**全在同一个子进程内同步执行**。默认 20 是防「单回合写爆」 |
| 调小 `minIntervalMs` 的代价 | 每次 `stop` 都起子进程重扫日志。虽然游标让扫描量很小，但仍有进程启动开销（宽限期 `GRACE_MS = 8000`） |
| 关闭方式 | `organize.enabled: false`。注意**默认是开启的**——不写这一段也会整理 |
| 示例 | `organize: { enabled: true, batchLimit: 20, minIntervalMs: 300000 }` |

> **⚠️ 1.0.0 的用户注意**：1.0.0 **没有**这个功能。当时 `knowledge-engine.js organize` 是**独立 CLI，
> 没有任何自动调用方**，所以知识库从不自动增长。若你从 1.0.0 升级，请确认 `organize.enabled` 不是 `false`。

### 3.7 `governance.documented`

| 项 | 内容 |
|---|---|
| 类型 / 默认 | `boolean` / `true`（`lib/config.js:98`） |
| 含义 | **仅用于面板展示治理配置区，不参与任何调度** |

**为什么只有一个 `documented` 字段**（1.0.0 → 1.0.1 的变更，[CHANGELOG.md](CHANGELOG.md) C-08）：

1.0.0 有一个 `governance.everyStops: 10`，文档写「每多少次 `stop` 触发一次治理扫描」。**这是错的**：
插件侧从未读取该字段（死配置）。治理的实际行为是——

- 治理**不在插件里计数触发**。插件只写 `stop` 留痕；`bridge.js` 侧在每次 `stop` 时**自行判断**是否跑 `govern`。
- 要观察治理是否运行，只能数 `hook-debug.log` 的 `[govern]` 行（实测累计 78 次）。
- 治理是否**真的产生了动作**：检查 `90_Agent/audit/<date>-audit.json` 的 `flagged` 字段。
  实测 `flagged: 0` + `governance/<date>-governance.json` 为 `[]`，即「链路通但从未触发动作」（见 K-05）。

1.0.1 删掉 `everyStops`（连同 `status.counters.governanceRuns` 死字段），保留一个**诚实的**
`documented` 开关，避免继续用一个不存在的旋钮误导用户。**治理的阈值逻辑若将来要在插件侧实现，
应新增字段而不是复活 `everyStops`。**

---

## 4. 完整可复制示例

> 以下为**实测可用**的完整配置（本机 profile `desktop`）。路径按你的环境改。

```yaml
- insert:
    - id: obsidian-bridge
      name: '@local/obsidian-bridge'
      config:
        # Vault 根目录。写操作的 cwd、扫描根前缀、子进程环境变量都由它派生。
        vaultPath: D:/MyVault
        # 执行 Vault 内脚本的 Node。留空则用 PATH 中的 node（不推荐：DSH 子进程 PATH 与 shell 不同）。
        nodePath: node
        # 只写环境变量名；密钥由 Vault 内 bridge.js 读取，用于审计 HMAC-SHA256。
        hmacSecretEnv: OBSIDIAN_BRIDGE_HMAC_SECRET
        # 四个事件开关。关闭语义是 !== false，只有显式写 false 才关闭。
        enabled:
          prompt: true
          tool: true
          stop: true
          sessionStart: true
        # 知识注入（G2）。
        inject:
          enabled: true
          limit: 3
          minKeywordLength: 2
        # 知识条目整理。默认开启 —— 不写这一段也会整理（batchLimit 20 / 5 分钟节流）。
        # 想关掉必须显式写 enabled: false。
        organize:
          enabled: true
          batchLimit: 20
          minIntervalMs: 300000
        # 治理：仅面板展示开关。治理扫描实际由 Vault 侧 bridge.js 在 stop 时自行触发。
        governance:
          documented: true
    - id: obsidian-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: obsidian-local
        transport: stdio
        command: node
        args:
          - <YOUR_WORKBUDDY_PATH>
        env:
          OBSIDIAN_VAULT_PATH: D:/MyVault
        failOnStartupError: true
```

**`obsidian-mcp` 段的说明**（它不是本插件的配置，但必须在同一个 `insert` 里）：

- `transport: stdio` —— 经标准输入输出与 MCP server 通信（实测 15 个工具）。
- `failOnStartupError: true` —— MCP 子进程启动失败时让**整个 bundle 启动失败**，便于早发现路径写错。
  设为 `false` 会让 MCP 静默不可用，而留痕功能一切正常，极难排查。

> **`serverName` 必须与插件内的常量一致**：`index.js:48` 的 `OBSIDIAN_MCP_SERVER = 'obsidian-local'`。
> 面板的 MCP 工具数按 `mcp__<serverName>__` 前缀统计（`index.js:249`）。改这里就要同步改插件常量。

---

## 5. `enabled.*` 的关闭语义（易踩）

**关闭判定是 `!== false`**（`lib/config.js:81-86`），也就是说：

```js
prompt: enabled.prompt !== false      // 只要不是字面量 false，一律视为开启
```

| 你写的值 | 实际效果 | 是否符合直觉 |
|---|---|---|
| `true` | 开启 | ✅ |
| `false` | **关闭** | ✅ |
| **省略不写** | **开启**（默认） | ⚠️ 容易以为「没配就是关」 |
| `0` / `"false"` / `null` | **开启**（`!== false` 为真） | ❌ 最常见的误用 |

> **结论**：想让某个事件停摆，**必须显式写 `false`**。写 `0`、写字符串 `"false"`、或留空，都是开启。
>
> **这条规则同样适用于 `inject.enabled` 与 `organize.enabled`**——它们的默认值都是 `true`，
> 所以「我没配 organize」≠「organize 关闭」，而是「organize 用默认参数开启」。

---

## 6. 配置外的项：`SCAN_ROOTS`

有项目**看起来像配置，实际不可配**：

| 名称 | 位置 | 真相 |
|---|---|---|
| `SCAN_ROOTS` | `lib/config.js:62` 硬编码 | 扫描根目录**不可通过 `cordis.patch.yml` 覆盖**。当前值为 `['30_Resources', '10_Projects', '00_InteractionLogs', '00_MOC']`。Vault 里其他目录的笔记**永远不会被检索到** |
| `OBSIDIAN_MCP_SERVER` | `index.js:48` 硬编码 | MCP server 名（`'obsidian-local'`），用于面板统计工具数。必须与 `cordis.patch.yml` 的 `serverName` 一致 |

**实践建议**：若你的 Vault 把知识笔记放在别的目录，目前唯一的办法是改 `lib/config.js:62`（属代码改动，
需随版本发布）。这是 1.1.0 计划中的改进项。

> **1.0.0 → 1.0.1 的变化**：1.0.0 的这份清单里还有一项 `mcpTools`，文档称它「恒为 `undefined`，
> 面板因此永远走写死的 `obsidian-local（15 个）` 分支」。**1.0.1 已修复**——新增 `countMcpTools()`
> 用 `ctx.tools.schemas(lastAgent)` 真实枚举并按前缀过滤（`index.js:241-256`），面板现在显示的是
> **观测值**而非常量：0 显示「未加载」、无法枚举显示「未知（见 MCP 面板）」、>0 显示实际个数
> （`client.js:208-215`）。因此 `mcpTools` 不再是「配置外的项」，它根本不再是配置。

---

## 7. 环境变量

| 变量 | 谁设置 | 用途 | 缺失后果 |
|---|---|---|---|
| `OBSIDIAN_BRIDGE_HMAC_SECRET` | 宿主 shell / DSH 启动环境 | 审计记录的 HMAC-SHA256 签名密钥（由 Vault 内 `bridge.js` 读取） | 审计记录**拒绝签名**，`signature.passed` 为 false |
| `OBSIDIAN_VAULT_PATH` | **由插件自动注入**子进程（`lib/writer.js:62`） | 告诉 Vault 脚本 Vault 根目录（`knowledge-organize.js:27` 读取它） | 无需手动设置；它与 `vaultPath` 自动保持一致 |

> 没有其他环境变量。DSH 的 `ctx.subprocess` 会**在父环境基础上叠加**（`env` 字段），无需复制整份 `process.env`。

---

## 8. 沙箱与读写通道

这是部署时最容易踩的坑，配置正确也会中招：

`@deepseek-ai/dsh-fs-sandbox` 按会话 sandbox 模式围栏 `ctx.fs` 的**写**操作：

- 默认 `read-only`；`workspace-write` 只放行**会话工作区 + 临时目录**。
- 直接写 `D:/MyVault` 会被拒——**除非**会话工作区恰好是 Vault（极少见）。

因此本插件的通道分工是：

| 操作 | 通道 | 为什么 |
|---|---|---|
| **读**（Vault 索引扫描） | `ctx.fs` | sandbox 放行读，可正常扫描 `D:/MyVault`（`lib/vault-index.js:113-146`） |
| **写**（留痕、记忆同步、知识整理、治理） | `ctx.subprocess` | 子进程调用不经过 sandbox 的消费层，不受围栏约束（`lib/writer.js:20-67`） |

> **结论**：任何绕过 `ctx.subprocess` 直接写 Vault 的改动，都会在 `read-only` 会话下**静默失败**——
> 不报错、不告警，只是文件没出现。这是本插件最需要长期保持的架构约束。
>
> ⚠️ **1.0.1 的 `runner.spawn` 事故正是这条约束的反面教材**：知识整理**走对了**通道
> （`ctx.subprocess`），但插件侧调用的 `runner.spawn` 方法**根本没有被 `createRunner()` 导出**，
> 于是异常在 `.catch(() => {})` 里被吞掉，整理**从未运行**（[CHANGELOG.md](CHANGELOG.md) F-08）。
> **通道选对了不等于调用接对了。**

---

## 9. 常见配置错误

| 现象 | 可能的配置原因 | 排查 |
|---|---|---|
| 面板有数据，但 Vault 里没有任何留痕文件 | `enabled.*` 被误设为 `0` / `"false"` / 留空（实际是开启）→ 说明是别的原因；或 `nodePath` 指向不存在的文件 → 写操作整体放弃 | 查 `hook-debug.log` 有无 `Hook triggered`；确认 `nodePath` 文件存在 |
| 索引永远为 0，注入从不命中 | `vaultPath` 写错（读静默返回空）或 Vault 缺四个扫描根 | 看面板「索引构建失败」是否 > 0（1.0.1 新增）；跑 `node test/e2e-verify.mjs` 的 `E4` 与 `ENV-1` |
| **知识库不增长**（`30_Resources/` 下没有新条目） | `organize.enabled: false`；或 `enabled.stop: false`（整理挂在 `stop` 上）；或 `minIntervalMs` 设得过大；或 `batchLimit` 为 0 | **见 [TROUBLESHOOTING.md 决策树 D](TROUBLESHOOTING.md)**——先看面板「知识整理」计数与游标文件 |
| 面板「知识整理」恒为 0 | 同上；或子进程退出码非 0（会记 `organizeFailed`，面板显示「失败 N」） | 手动跑一次脚本：`node 90_Agent/knowledge-organize.js '{"limit":20}'`，看 stdout 的 `{scanned,created,skipped}` |
| 审计记录没有签名 | `OBSIDIAN_BRIDGE_HMAC_SECRET` 未导出 | 在 DSH 的启动环境中确认该变量存在 |
| MCP 工具数为 0 或「未知」 | `obsidian-mcp` 段路径写错且 `failOnStartupError: false`；或 `serverName` 与 `index.js:48` 的 `OBSIDIAN_MCP_SERVER` 不一致 | 把 `failOnStartupError` 设为 `true`，让启动直接失败；核对两处 server 名 |
| 关了 `enabled.prompt` 但知识仍被注入 | **1.0.0 的已知语义缺陷**——当时注入只受 `inject.enabled` 控制 | 升级到 1.0.1（`enabled.prompt` 现在同时控制注入，见 §3.4）；临时绕过：同时设 `inject.enabled: false` |
| 配了 `governance.everyStops` 但不生效 | **该字段在 1.0.1 已删除**（死配置，插件侧从未读取） | 删掉该字段；治理由 Vault 侧 `bridge.js` 自行触发（见 §3.7） |
| 改了配置但行为不变 | 改了 `cordis.patch.yml` 但**没重启 DSH**；或 profile 的 `node_modules/@local/obsidian-bridge` 是**复制**而非 Junction | `(Get-Item <路径>).LinkType` 必须是 `Junction`；改完必须完全退出 DSH 再启动 |

---

**相关文档**：[RELEASE-1.0.md](RELEASE-1.0.md)（发布说明与已知问题）｜
[CHANGELOG.md](CHANGELOG.md)（版本变更）｜[TROUBLESHOOTING.md](TROUBLESHOOTING.md)（故障排查）。
