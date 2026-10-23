# 知识库整理链路 · 质量门 · 分类规则

> 本文说明 `90_Agent/knowledge-organize.js` 的整理链路、质量门与分类规则，
> 并记录 2026-10-22 体检发现的**缺陷清单**与**修复/清理方案**。
>
> 证据约定：**【已验证】**= 读到源码字面内容或实跑观测到，附文件:行号；
> **【推断】**= 由已验证事实推导；**【证据不足】**= 静态证据无法判定。

## 目录

- [1. 链路总览](#1-链路总览)
- [2. 写入侧：bridge.js 的日志格式](#2-写入侧bridgejs-的日志格式)
- [3. 整理侧：organize 流程](#3-整理侧organize-流程)
- [4. 质量门](#4-质量门)
- [5. 分类规则（PRD §5.2.3）](#5-分类规则prd-523)
- [6. 标题生成策略](#6-标题生成策略)
- [7. 缺陷清单](#7-缺陷清单)
- [8. 清理方案](#8-清理方案)
- [9. 修复方案](#9-修复方案)
- [10. 回归守卫](#10-回归守卫)
- [11. 产品决策：只提炼真知识（方案 A）](#11-产品决策只提炼真知识方案-a)

---

## 1. 链路总览

```
DSH 事件
  └─ obsidian-bridge (index.js)
       └─ ctx.subprocess ──> 90_Agent/hooks/bridge.js logInteraction()
                                └─ 追加写入 00_InteractionLogs/{date}_{type}.md
                                     ├─ {date}_conversation.md   （359 个 section）
                                     ├─ {date}_thinking.md       （965 个 section）
                                     ├─ {date}_project-op.md     （132 个 section）
                                     ├─ {date}_memory-op.md      （106 个 section）
                                     ├─ {date}_decision.md       （  5 个 section）
                                     └─ {date}_insight.md        （  1 个 section）

  └─ obsidian-bridge (index.js:463 maybeOrganize)
       └─ ctx.subprocess ──> 90_Agent/knowledge-organize.js organize()
                                └─ 读取日志 → 质量门 → 分类 → 生成 30_Resources/{category}/
```

**【已验证】** 接线位置：`obsidian-bridge/index.js:453`（在 `agent/turn-stopping` 里调用）、
`:463-485`（`maybeOrganize`，带 `minIntervalMs` 节流）、`:471`（`scriptPath(cfg, '90_Agent/knowledge-organize.js')`）。

**【已验证】** 旧 CLI `90_Agent/knowledge-engine.js` 是**独立 CLI、无自动调用方**
（`index.js:451-452` 注释原文：「knowledge-engine.js 是独立 CLI，没有任何自动调用方，所以知识库从不增长」）。

---

## 2. 写入侧：bridge.js 的日志格式

**【已验证】** `90_Agent/hooks/bridge.js:507`：

```js
const entryContent = fmYaml + '\n' + entry + content + '\n';
```

其中 `entry`（`bridge.js:481`）是 `'\n## [${timestamp}] ${type}\n\n'`。

⇒ 每个条目的物理顺序是：

```
<frontmatter N>
## [ts N] type N

<正文 N>
<frontmatter N+1>          ← 下一个条目的 frontmatter，出现在正文 N 之后
## [ts N+1] type N+1

<正文 N+1>
```

**这是本次所有垃圾 KB 的根源**：整理侧按 `\n## [` 切分后，section N 的「正文」实际是
`正文 N + frontmatter N+1`。见缺陷 **D1**。

---

## 3. 整理侧：organize 流程

**【已验证】** `knowledge-organize.js` 主流程（`:257-334`）：

| 步 | 行号 | 动作 |
|---|---|---|
| 1 | `:259-261` | 枚举日志文件，**只保留 `*_conversation.md`** |
| 2 | `:277` | `text.split(/\n## \[/)` 切分 section |
| 3 | `:135-144` | `parseSection()` 提取 `{timestamp, type, body}` |
| 4 | `:284` | 游标：`ts <= lastOrganizedAt` 跳过 |
| 5 | `:151-172` | `qualityGate()` 质量门 |
| 6 | `:294-299` | `contentHash` 去重 |
| 7 | `:182-192` | `classify()` 分类 |
| 8 | `:302-314` | 生成 `id`/`title`/`summary` |
| 9 | `:214-248` | `writeEntry()` 落盘 |
| 10 | `:330-331` | 写回游标 |

**【已验证】** 与 PRD §5.2.4（`PRD.md:261-272`）的差异：

| PRD 步骤 | PRD 要求 | 实际 |
|---|---|---|
| 1 | 读取 `00_InteractionLogs/{date}_*.md`（全部类型） | **只读 `*_conversation.md`**（`:260`） |
| 8 | 写入 `30_Resources/{category}/{id}_{title前30字}.md` | `{id}_{title前40字}.md`（`:205`） |

---

## 4. 质量门

**【已验证】** 四道门，定义在 `knowledge-organize.js:47-81`：

| 门 | 行号 | 规则 | 实测命中 |
|---|---|---|---|
| 类型门 | `:152-154` | `type ∈ SKIPPED_TYPES`（仅 `session-start`） | **0** —— 因 bridge.js 恒写 `conversation` |
| 长度门 | `:155-157` | `body.length < 80` 拒绝 | 145 条真实正文 <80（但门看的是**含残留的** body，所以没拦住） |
| 内容门 | `:159-164` | 7 条 `TRIVIAL_PATTERNS`（`^会话开始$` 等） | 少 |
| system prompt 门 | `:165-170` | 7 个 `SYSTEM_PROMPT_MARKERS` 子串 | 17 条命中 `You are a helpful assistant` |
| system prompt 门（结构性） | `:171-173` | `ROLE_DECLARATION_RE` 开头 + 无 `USER_QUESTION_RE` 痕迹 | 已启用 |
| **自指循环门** | `:174-179` | 正文含 `INJECTION_MARKER` 即拒 | 2026-10-22 首次重生成拦下 **27 条** |

**【已验证】** `SYSTEM_PROMPT_MARKERS`（`:70-78`）共 7 个：
`You are a helpful assistant` / `You are Claude` / `You are an AI assistant` / `<system>` /
`system prompt:` / `Your task is to` / `你是一个乐于助人的助手`。

**【已验证】** 对 `experience/` 全部 290 条实测扫描 25 个候选标记，命中情况：

| 标记 | 命中 |
|---|---|
| `You are a helpful assistant` | **17** |
| `You are a` | 19（**过于宽泛，不可用**） |
| `作为` / `助手` | 6 / 5（中文常用词，**不可用**） |
| 其余 20 个候选（`You are DSH`、`<identity>`、`Do not reveal`、`IMPORTANT:` 等） | **0** |

⇒ **7 个标记对当前语料足够**（只有 1 个真正生效），但存在两个风险：
① 全部是**精确子串**，换个措辞即漏；② `Your task is to` / `You are an AI assistant`
在正常技术讨论里可能误伤（本次未发生，因为命中数 0）。

### 4.1 自指循环门（`INJECTION_MARKER`）

**规则**：正文含 `知识库相关笔记（自动注入）` 即判为无知识价值，拒绝提炼。

```js
const INJECTION_MARKER = '知识库相关笔记（自动注入）';
// qualityGate() 内：
if (trimmed.includes(INJECTION_MARKER)) {
  return { ok: false, reason: `自指循环：正文含插件注入标记「${INJECTION_MARKER}」，内容已存在于 30_Resources` };
}
```

**为什么加这条规则 —— 两个原因：**

1. **自指循环**。插件在 `agent/pre-step` 里把知识检索结果注入对话上下文，
   注入内容随后被 `bridge.js` 写进 `conversation` 日志；整理器若不拦住，
   就会把「注入块」当成用户知识**再提炼一遍** —— 形成
   `30_Resources` → 检索 → 注入 → 日志 → 再提炼 → `30_Resources` 的回环。

2. **内容重复**。注入的内容本来就来自 `30_Resources`，再提炼一遍等于**复制已有知识**。
   实测该 27 条正文里出现的 31 个笔记路径中，**19 个已作为真实知识存在**。

**实测数据**：2026-10-22 首次重生成（方案 A 后）命中 **27 条**，占当时 101 条的 **27%**；
27 条标题**完全相同**（`知识库相关笔记（自动注入）`）。

**负向对照**（守卫 P13）：把当前脚本复制一份、**只删掉注入门**（其余 D1–D9 与白名单不变，
变体通过 `node --check` 语法校验），P13 结果：

| 脚本 | P13 | 守卫总计 |
|---|---|---|
| 当前（含注入门） | **PASS** | 13 PASS / 0 FAIL |
| 变体（仅删注入门） | **FAIL** | 12 PASS / 1 FAIL |

⇒ P13 是真断言，不是恒真。

---

## 5. 分类规则（PRD §5.2.3）

**【已验证】** PRD 定义（`PRD.md:248-259`）：

| 留痕类型 | category | 附加 tags |
|---|---|---|
| `conversation` | `experience` | `对话记录` |
| `decision` | `process` | `决策` |
| `thinking` | `topic` | `思考` |
| `insight` | `experience` | `洞察` |
| `memory-op` | `entity` | `记忆操作` |
| `project-op` | `project` | `项目操作` |
| `tool-op` | `project` | `工具操作`（v1.0.2 新增，见下） |

> **`tool-op` 说明（v1.0.2）**：`bridge.js` 原先把工具调用兜底写成 `thinking`，
> 导致 `thinking.md` 里 965 条 section **真思考 0 条**（100% 是 `工具: X\n输入: {...}`），
> 进而被提炼成标题为 `Bash`/`pwsh` 的「知识条目」。
> v1.0.2 起工具调用使用独立类型 `tool-op`。
>
> **它不在 `KNOWLEDGE_TYPES` 白名单里** —— 操作日志不产生知识条目。
> 原始日志仍完整保留在 `00_InteractionLogs/`，随时可查。

**实现对照**：

| 留痕类型 | knowledge-engine.js | knowledge-organize.js | 判定 |
|---|---|---|---|
| `conversation` | `:145-147` experience/对话记录 ✅ | `:191` 默认 experience ✅ | 一致 |
| `decision` | `:148-150` process/决策 ✅ | `:190` process/决策 ✅ | 一致 |
| `thinking` | `:151-153` **topic/思考** ✅ | **无此分支** ❌ | **缺失** |
| `insight` | `:154-156` experience/洞察 ✅ | `:189` experience/洞察 ✅ | 一致 |
| `memory-op` | `:157-159` entity/记忆操作 ✅ | `:187` entity/记忆操作 ✅ | 一致 |
| `project-op` | `:160-162` project/项目操作 ✅ | `:188` project/项目操作 ✅ | 一致 |

**⇒ 缺陷 D2：`knowledge-organize.js` 的 `classify()` 缺少 `thinking → topic`。**

**【已验证】** 更严重的是**可达性**：即使补上该分支也永远不会触发，因为
`organize()` 只读 `*_conversation.md`（`:260`），而 `thinking` 类型的 section 全部在
`{date}_thinking.md` 里（实测 965 个 section，见 §1）。

**【已验证】** 另外 3 个类型分支（`memory-op`/`project-op`/`insight`/`decision`）同样不可达 ——
它们的 section 分别在 `{date}_memory-op.md`(106)、`{date}_project-op.md`(132)、
`{date}_insight.md`(1)、`{date}_decision.md`(5)。

**【已验证】** `classify()` 还有 3 条**正文启发式**规则先于类型判断（`:184-186`）：

```js
if (/工具[:：]/.test(head)) return { category: 'project', ... };
if (/对话结束|响应摘要/.test(head)) return { category: 'experience', ... };
if (/用户\s*prompt/i.test(head)) return { category: 'experience', ... };
```

⇒ 由于类型恒为 `conversation`，**分类实际完全由这 3 条正文猜测决定**，
类型字段形同虚设。这是「全部落 experience」的直接原因。

---

## 6. 标题生成策略

**【已验证】** 现状：

| 生成器 | 行号 | 策略 | 实测产物 |
|---|---|---|---|
| `knowledge-engine.js` | `:169` | `` `[${type}] ${summary.substring(0,50)}...` `` | `[conversation] 对话结束 响应摘要:...` |
| `knowledge-organize.js` | `:307` | `summary.slice(0,50)`，summary = 正文换行转空格前 200 字 | `对话结束 响应摘要: 数据出来了：**12 条摘要有内容...` |

两者都**直接截取正文前缀**，因此必然继承 D1 的残留污染。

**【已验证】** 实测对照（6 条 realChars≥200 的样本）：

| 策略 | 产物示例 | 评价 |
|---|---|---|
| 现状（正文前 50 字） | `对话结束 响应摘要: 数据出来了：**12 条摘要有内容，6 条为空**（33%）。空的` | ❌ 无信息量 |
| A：首个非空行前 40 字 | `响应摘要: 数据出来了：**12 条摘要有内容，6 条为空**（33%）。空的那` | ❌ 仍带前缀 |
| **B：优先取首个 markdown 标题** | `交付报告：WorkBuddy-Obsidian-Bridge → DeepSee` | ✅ |
| **B** | `新增：\`test/acceptance.mjs\` — PRD §9 验收脚本` | ✅ |
| **B** | `本轮完成` | ✅ |
| **B** | `效果展示` | ✅ |

**推荐策略（无 LLM 依赖）**：

1. **先剥离残留**（前置条件，否则任何策略都无效）；
2. 取**首个 `#{1,3}` 标题**的文本（去掉 `#` 与首尾空白）；
3. 若无标题，取**首个非空、长度 ≥8、且不以事件前缀开头**的行；
4. 剥离去重前缀：`用户 prompt:` / `对话结束 响应摘要:` / `响应摘要:` / `思考过程:` / `工具调用:` / `记忆同步:`；
5. 去除首尾 markdown 强调符号（`*`、`` ` ``、`_`）与列表符号（`-`/`*`/数字）；
6. 截断到 60 字符（schema 允许 200，但标题宜短）；
7. 兜底：`{type} {date}`（如 `conversation 2026-10-21`），**禁止**退回正文截断。

---

## 7. 缺陷清单

| ID | 缺陷 | 位置 | 实测证据 | 严重度 |
|---|---|---|---|---|
| **D1** | 正文夹带下一个 entry 的 frontmatter | `knowledge-organize.js:142`（根因 `bridge.js:507`） | 290 条中 **277 条**（95.5%）正文含 `\n---\n(type\|date\|timestamp\|...)` | **致命** |
| **D2** | `classify()` 缺 `thinking → topic` | `knowledge-organize.js:182-192` | PRD `PRD.md:256` 要求；实现中无该分支 | 高 |
| **D3** | 只读 `*_conversation.md`，六类映射不可达 | `knowledge-organize.js:260` | thinking 965 / project-op 132 / memory-op 106 / decision 5 / insight 1 个 section 全被忽略 | **致命** |
| **D4** | 分类由正文启发式决定，类型字段失效 | `knowledge-organize.js:184-186` | 291 条全部落 `experience`/`project`；`thinking`/`decision`/`insight` 分支从未触发 | 高 |
| **D5** | 标题 = 正文前 50 字，继承残留 | `knowledge-organize.js:307` | 291 条标题均为 `对话结束 响应摘要: ...` / `用户 prompt: ...` | 高 |
| **D6** | 长度门看含残留的 body，拦不住短内容 | `knowledge-organize.js:81,155` | `MIN_CONTENT_LENGTH=80`；145 条真实正文 <80 仍入库 | 中 |
| **D7** | 残留污染 contentHash，去重失效 | `knowledge-organize.js:294` | 实测：同一正文重复 2 次生成 **2 条**（P10 失败） | 中 |
| **D8** | 文件名截断长度与 PRD 不符 | `knowledge-organize.js:205` vs `PRD.md:272` | 实现 40 字，PRD 要求 30 字 | 低 |
| **D9** | 7 个 system prompt 标记仅 1 个生效 | `knowledge-organize.js:70-78` | 25 候选实测，仅 `You are a helpful assistant` 命中 17 | 低 |

---

## 8. 清理方案

### 8.1 判定标准：如何区分「垃圾」与「有价值的 conversation 提炼」

**第一步 —— 先判「是不是自动生成的」。** 判据（满足任一）：

- 文件名匹配 `^KB-\d{8}-\d{4}_`
- frontmatter 含 `id: "KB-..."` 且 `source.plugin: "obsidian-bridge"`
- frontmatter 含 `contentHash:` 字段

**手工策展的真实知识不满足上述任一条**（实测：`前端框架` 用 `id: FE-前端-001`、`type: permanent`），
因此**不会被误删**。

**第二步 —— 对自动条目判「是否被污染」。**

| 判据 | 含义 | 命中数 |
|---|---|---|
| **污染**：正文含 `\n---\n(字段名):` | 夹带了下一条 entry 的 frontmatter ⇒ 该条的 title/summary/content **全部不可信** | **277** |
| **泄漏**：命中 7 个 system prompt 标记 | 系统提示词被当知识存库 | **17** |
| **过短**：剥离残留后正文 < 200 字 | 无知识价值 | **175** |
| **干净**：realChars ≥ 200 且无污染、无泄漏 | 正文有真实内容 | **4** |

**第三步 —— 关键论点：「有价值」≠「当前这条值得留」。**

即使 4 条「干净」条目，其**标题仍是垃圾**（D5），且：

- 全部内容 100% 存在于 `00_InteractionLogs/*.md`（实测 1.19 MB，**保留不动**）
- 现有条目的 title/summary 已被污染（291 条中 277 条）
- 手工修 291 条标题不现实；重生成是确定性、幂等的

⇒ **推荐判定：291 条全部删除，由修复后的管线从原始日志重生成。**

### 8.2 互斥分层与数量

| 层 | 判据 | 数量 | 处置 |
|---|---|---|---|
| **T1** | 污染 ∨ 泄漏 ∨ 过短 | **287** | 删除 |
| **T2** | 干净（realChars≥200） | **4** | 删除后重生成 |
| **T3** | 非自动生成（手工策展） | **115** | **保留，不动** |
| | **合计自动条目** | **291** | 290 在 `experience/`，1 在 `project/` |

### 8.3 分批计划（待确认后执行）

| 批 | 范围 | 数量 | 前置 | 后置校验 |
|---|---|---|---|---|
| 0 | 确认 git 基线可回滚 | — | `git -C D:/MyVault status --porcelain 30_Resources` 为空 | `git rev-parse --short HEAD` |
| 1 | `project/` 的 1 条（最小批，验证流程） | 1 | 批 0 通过 | `30_Resources/project` 无 `KB-*`；`git status` 显示 1 个 D |
| 2 | `experience/` 中 realChars<200 的 | 175 | 批 1 通过 | 剩余 ≤116 |
| 3 | `experience/` 中命中 system prompt 标记的 | 17 | 批 2 通过 | 剩余 ≤100 |
| 4 | `experience/` 中剩余的污染条目 | 95 | 批 3 通过 | `experience/` 无 `KB-*` |
| 5 | 真实知识完整性复核 | — | 批 4 通过 | 115 篇手工策展全在位（守卫 V2） |

> 每批后向 lead 报告：删除数、剩余数、`git status --porcelain 30_Resources | wc -l`。

### 8.3.1 执行结果（2026-10-22，已完成）

| 批 | 命中 | 删除 | 剩余 | 释放字节 |
|---|---|---|---|---|
| 0 | — | — | 291 | — |
| 1 | `project/` | 1 | 290 | 1,622 |
| 2 | `experience` realChars<200 | 175 | 115 | 375,665 |
| 3 | `experience` 命中 system prompt 标记 | **12** | 103 | 70,599 |
| 4 | `experience` 剩余全部 | 103 | **0** | 572,333 |
| | **合计** | **291** | **0** | **1,020,219** |

> 批 3 命中 12 而非 17：其中 5 条 realChars<200，已在批 2 删除（分批是顺序执行的）。

**批 5 校验**：真实知识 115 篇全部在位 ——
`前端框架` 31 / `后端与数据库` 23 / `开发工程化` 32 / `AI_Agent` 28 / `通信协议` 1。
`00_InteractionLogs/` 19 个日志文件未受影响。

**守卫结果**：`node test/knowledge-quality.mjs` → **15 PASS / 0 FAIL**。

**基线说明**：执行时 HEAD 已从 `d1c8d9e` 前进到 `7d93df3`
（该提交只补全 `.gitignore` 并停止跟踪 13 个敏感/运行时文件，**未触碰 `30_Resources`**）。
`30_Resources` 406 个文件全部被跟踪且执行前工作区干净 ⇒ 回滚命令不变：

```bash
git -C D:/MyVault checkout -- 30_Resources
```

### 8.4 回滚保障

**【已验证】**

- `git -C D:/MyVault rev-parse --short HEAD` → `d1c8d9e`（即 lead 提到的基线提交）
- `git ls-files 30_Resources` → **406 个文件被跟踪**
- `git status --porcelain 30_Resources` → **空**（全部已提交，无未提交改动）
- ⇒ 删除可完整回滚：`git -C D:/MyVault checkout -- 30_Resources`

### 8.5 信息丢失风险

**【已验证】** 零丢失。原始日志 `00_InteractionLogs/*.md` 共 **1,209,725 B**（19 个文件）**保留不动**，
是所有 KB 条目的唯一信息源。删除 1,020,219 B 的派生条目不丢任何信息。

---

## 9. 修复方案

| 缺陷 | 修复动作 | 位置 |
|---|---|---|
| **D1** | `parseSection()` 在取 body 后，用 `body.search(/\n---\n(\w[\w-]*):/)` 截断尾部 frontmatter 残留 | `knowledge-organize.js:142` |
| **D2** | 补 `thinking → { category:'topic', tags:['思考','auto'] }` | `knowledge-organize.js:182-192` |
| **D3** | 放开日志过滤：改为读取 `00_InteractionLogs/{date}_{type}.md` 全部 6 类（保留 `*_conversation.md` 兼容） | `knowledge-organize.js:259-261` |
| **D4** | 删除 3 条正文启发式，改为**严格按 `type` 映射**；无匹配类型时落到 `experience` 并**记 warn** | `knowledge-organize.js:184-186` |
| **D5** | 实现 §6 的 7 步标题策略，替换 `summary.slice(0,50)` | `knowledge-organize.js:302-307` |
| **D6** | 长度门改为对**剥离残留后**的正文判定；阈值 80 → 200 | `knowledge-organize.js:81,155-157` |
| **D7** | 由 D1 修复自动解决（hash 基于干净正文） | — |
| **D8** | `safeFilename` 截断 40 → 30 | `knowledge-organize.js:205` |
| **D9** | 保留 7 个标记；新增结构性检测（`^(You are\|You must\|You should\|Your task\|Do not reveal)\b` 且无提问痕迹） | `knowledge-organize.js:70-78,165-170` |

**约束**：以上修改只涉及 `90_Agent/knowledge-organize.js`（Vault 脚本），
**不改动插件源码**（`obsidian-bridge/index.js` / `lib/`）。

---

## 10. 回归守卫

**【已验证】** 产出物 `test/knowledge-quality.mjs`，实跑结果 **7 PASS / 8 FAIL**：

```bash
cd obsidian-bridge
node test/knowledge-quality.mjs            # 人类可读
node test/knowledge-quality.mjs --json     # 机器可读
node test/knowledge-quality.mjs --skip-vault  # 只跑 fixture
```

| 检查 | 内容 | 修复前 | 修复后 |
|---|---|---|---|
| P1 | `thinking → topic` 分支存在 | FAIL（D3） | PASS |
| P2 | 六类映射端到端 | FAIL（D2/D3/D4） | PASS |
| P3 | 正文不含 frontmatter 残留 | FAIL（D1） | PASS |
| P4 | system prompt 泄漏被拒 | PASS | PASS |
| P5 | 7 个标记齐全 | PASS | PASS |
| P6 | 长度门生效 | PASS | PASS |
| P7 | 标题无结构噪声 | FAIL（D5） | PASS |
| P8 | 标题取 markdown 标题本身 | FAIL（D5） | PASS |
| P9 | 幂等 | PASS | PASS |
| P10 | 相同内容去重 | FAIL（D7） | PASS |
| P11 | 读取全部 6 类日志 | FAIL（D2） | PASS |
| P12 | 游标逻辑存在 | PASS | PASS |
| V1 | Vault 无残留自动条目 | FAIL（待清理） | FAIL（待清理） |
| V2 | 115 篇真实知识在位 | PASS | PASS |
| V3 | 原始日志完好 | PASS | PASS |

**修复前 5 PASS / 7 FAIL → 修复后 14 PASS / 1 FAIL**（仅剩 V1，需执行清理）。

**负向对照（证明断言不漏报）**：把 `git show HEAD:90_Agent/knowledge-organize.js`
抽到临时目录并用 `KNOWLEDGE_ORGANIZE_SCRIPT` 指向它，守卫对**原始脚本**仍然报出
P1/P2/P3/P7/P8/P10/P11 共 7 个 FAIL —— 与 7 个已修缺陷一一对应，且 5 个原本
就 PASS 的仍 PASS。⇒ 断言既不漏报也不误报。

**设计要点**：fixture 驱动 + 子进程实跑 + 检查落盘产物，**不做 mock**；
临时目录隔离，不写 Vault（实测 `30_Resources` 零改动、无临时目录泄漏）。

---

## 11. 产品决策：只提炼真知识（方案 A）

**状态：已决策并执行（2026-10-22，用户拍板）。**

### 决策

> **只有 `conversation` / `decision` / `insight` 三类日志会提炼为知识条目。**
>
> **理由**：`thinking` / `memory-op` / `project-op` 三类日志的 section
> **100% 是工具调用记录**（实测 `*_thinking.md` 965 条 section 中真思考 0 条），
> 根因是 `bridge.js:630` 把 `thinking` 当作所有工具调用的兜底类型。按 PRD §5.2.3
> 全量重生成会产生 1074 条，其中 974 条是工具调用记录，标题为 `Bash` / `WebFetch` /
> `pwsh` / `edit`，属「换标签的垃圾」。
>
> **原始日志完整保留**在 `00_InteractionLogs/`，随时可查。
>
> **待办**：`bridge.js:630` 的类型兜底问题（需单独授权，因为它影响所有新日志格式）。

### 决策前的实测依据

按 PRD §5.2.3 全量重生成（真实日志，隔离临时目录）：

| category | 条数 | 标题样本 |
|---|---|---|
| `topic` | 842 | `Bash` / `WebFetch` |
| `experience` | 97 | `✅ 插件持续在跑` / `当前状态` / `效果展示` / `PRD §9 验收结果` |
| `entity` | 76 | `pwsh` / `edit` |
| `project` | 56 | `Bash` / `输入: {"filepath":...}` / `write` / `todowrite` |
| `process` | 3 | `obsidian-bridge v1.0 知识图谱入库完成` / `文档体系补齐（P0 三项落地）` |

标题质量统计：`≤4 字符` 121 条、`标题是工具名` 127 条、`重复标题涉及` 202 条。

### 根因

`90_Agent/hooks/bridge.js:630` —— `thinking` 是**所有工具调用的兜底类型**：

```js
let tags = ['tool', 'auto'];
let type = 'thinking';            // ← 默认值
if (isMemoryOp) { tags.push('memory'); type = 'memory-op'; runMemorySync(); }
else if (isProjectOp) { tags.push('project'); type = 'project-op'; }
logInteraction(type, `工具: ${toolName}\n输入: ${toolInput}`, tags);
```

### 各日志的真实构成（决策依据）

| 日志 | section | 构成 | 过长度门 |
|---|---|---|---|
| `*_thinking.md` | 965 | **100% 工具调用记录**，真思考 **0** | 842 |
| `*_memory-op.md` | 185 | **100% 工具调用记录** | 76 |
| `*_project-op.md` | 147 | **100% 工具调用记录** | 44 |
| `*_conversation.md` | 374 | 180 响应摘要 + 105 用户prompt + 86 会话开始 + 3 其它 | 122 |
| `*_decision.md` | 5 | 真实决策（含 markdown 标题） | 4 |
| `*_insight.md` | 1 | 真实洞察（2308B） | 1 |

⇒ PRD §5.2.3 的映射本身没错，是**源数据与分类法不匹配**。

### 实现

`knowledge-organize.js` 的 `organize()` 内新增白名单常量：

```js
const KNOWLEDGE_TYPES = ['conversation', 'decision', 'insight'];
```

文件过滤由「全部 `{date}_{type}.md`」改为「仅白名单三类」。
守卫 P11 同步改为断言白名单内容（含「不得包含 thinking/memory-op/project-op」）。

### 执行结果（2026-10-22）

**重生成前验证**（隔离临时目录，实跑）：

| 验证项 | 结果 |
|---|---|
| `scanned` 只覆盖白名单三类 | PASS —— 实际 381，期望 381 |
| 幂等（第二次 `created=0`） | PASS —— run2 `scanned=0 created=0` |
| 零污染（正文无 frontmatter 残留） | PASS —— 0 条 |
| 零 system prompt 泄漏 | PASS —— 0 条 |
| 标题不含工具名 | PASS —— 0 条 |
| 标题不是短拉丁词元或空 | PASS —— 0 条 |

**Vault 实跑**：`scanned=381 created=101 skipped=280`，第二次 `created=0`。

| category | 条数 |
|---|---|
| `experience` | 97 |
| `process` | 3 |
| `project` | 1 |
| **合计** | **101** |

与方案 A 预期「约 100 条」一致（101 条）。

**标题抽样（10 条）**：

```
[experience] 交付报告：WorkBuddy-Obsidian-Bridge → DeepSeek Harness 插件
[experience] PRD §9 验收结果
[experience] REA 开关逻辑：不是你找错方法，是 DSH 的真实限制
[experience] 一、两个页面的本质区别
[experience] 全链路验证
[experience] 面板验证：几乎全对，抓出一个新 bug
[experience] 这一轮我找到了真正的差异
[experience] 为什么这次不一样
[process]    obsidian-bridge v1.0.0 发布前死代码清理
[process]    obsidian-bridge 文档体系补齐（P0 三项落地）
```

**守卫**：`node test/knowledge-quality.mjs` → **15 PASS / 0 FAIL**。

### 遗留观察 → 已修复：自指循环的 27 条注入副本

首次重生成后出现 **27 条标题为 `知识库相关笔记（自动注入）` 的 `experience` 条目**（占 101 条的 27%）。

- 其正文是**插件注入的检索结果**（笔记路径 + 分类 + 置信度），不是用户知识；
- 正文里出现的 31 个笔记路径中，**19 个已作为真实知识存在于 `30_Resources`** ⇒ 内容重复；
- 标题 27 条完全相同，属重复标题。

**根因**：自指循环 —— `30_Resources` → 检索 → 注入对话 → `bridge.js` 写入日志 → 整理器再提炼。

**处置（2026-10-22）**：

1. `qualityGate()` 新增 `INJECTION_MARKER` 门（详见 §4.1）；
2. 删除已生成的 27 条（`??` 未跟踪，直接删）；
3. 重跑整理确认幂等。

**结果**：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 总条数 | 101 | **74** |
| `experience` | 97 | **70** |
| `process` | 3 | 3 |
| `project` | 1 | 1 |
| 重复标题 | 1 种 / 27 条 | **0 种 / 0 条** |
| 重跑整理 `created` | — | **0**（幂等） |
| 守卫 | 15 PASS / 0 FAIL | **16 PASS / 0 FAIL**（新增 P13） |

**最终标题抽样（10 条）**：

```
[experience] 为什么这次不一样
[experience] 上一轮的结果
[experience] 一、交付物
[experience] 你好！👋
[experience] 你的问题的答案
[experience] 一、热插拔确认：支持，但对我的 bundle 不生效
[experience] REA 侧：没有服务开关，但有一个真正的"统一开关"
[experience] 已完成：SkillHub 内容源接入（技能 + 插件）
[experience] 误建的 web profile 已删除
[process]    obsidian-bridge 文档体系补齐（P0 三项落地）
```

**`process/` 目录 3 条已确认落盘**（`git status` 因整个目录未跟踪而折叠成 1 行 `??`，
`git add` 时会展开）：

```
KB-20261021-1708_obsidian-bridge_v1.0.0_发布前死代码清.md
KB-20261021-8413_obsidian-bridge_v1.0_知识图谱入库完成.md
KB-20261021-8499_obsidian-bridge_文档体系补齐（P0_三项落地.md
```
