# 故障排查（TROUBLESHOOTING）

> 适用版本：`@local/obsidian-bridge` **1.0.1**
> 配套文档：[RELEASE-1.0.md](RELEASE-1.0.md)（发布说明与已知问题）｜
> [CHANGELOG.md](CHANGELOG.md)（版本变更）｜[CONFIG.md](CONFIG.md)（配置参考）
> **本文不重复根因分析**——每个坑的完整证据链见 [RETROSPECTIVE.md](RETROSPECTIVE.md) §4（7 个坑）与 §5（4 层排查）。
> 本文只给**症状 → 可能原因 → 诊断命令 → 处置**，以及可复用的决策树。

## 目录

1. [排查总原则](#1-排查总原则)
2. [七个真实坑 + P8：速查表](#2-七个真实坑--p8速查表)
3. [每个坑的诊断命令](#3-每个坑的诊断命令)
4. [决策树 A：面板取不到数据（4 层通道）](#4-决策树-a面板取不到数据4-层通道)
5. [决策树 B：留痕不生效](#5-决策树-b留痕不生效)
6. [决策树 C：插件根本没加载](#6-决策树-c插件根本没加载)
7. [**决策树 D：知识库不增长**](#7-决策树-d知识库不增长)
8. [常见错误信息速查](#8-常见错误信息速查)
9. [提交 issue 时请提供什么](#9-提交-issue-时请提供什么)

---

## 1. 排查总原则

1. **先确认上一层真的成功了，再进入下一层。** 跳过这一步，就会把次生错误误判成「通道仍断」——
   本项目初版排查就是这样把 `e.execute.call` 误读为「通道故障」的。
2. **锚定「外部产物」，不要锚定「日志里没报错」。** 判据必须是 Vault 文件、MCP 返回值或 DSH 日志行，
   不能是进程内变量或「我没看到错误」。
3. **报错里的变量名（如 `e`）指向框架内部，不是调用点。** 顺着 `runner.execute` 的**赋值来源**反查，
   而不是顺着变量名找定义。
4. **静默失败比报错失败更贵。** 直读 `ctx.remote.<ns>` 返回 `undefined` 时不抛异常；
   `vaultPath` 填错时读操作静默返回空索引；**调用了未导出的方法**时异常被 `.catch(() => {})` 吞掉
   （见 P8）。**「没报错」不等于「没问题」。**
5. **一次只改一处。** 同时改配置和代码，就无法判断是谁起了作用。
6. **「功能没生效」要先问「它真的被调用了吗」。** P8 的教训：代码写对了、通道选对了、
   配置也开了，但**方法名不存在**——所有静态阅读都看不出问题，只有**产物**（游标文件）能证伪。

**万能起点**（先跑这个，它会告诉你断在哪一层）：

```powershell
cd "<USER_HOME>\Documents\deepseek-harness\default-workspace\obsidian-bridge"
node test/e2e-verify.mjs
```

期望：`16 PASS / 0 FAIL / 3 MANUAL`。若 `C1`–`C5` 中任何一项 FAIL，跳到 §4。
3 项 MANUAL 是 `E4`（需先发一条含知识库关键词的消息）与 `P1`/`P2`（需启动令牌），属预期。

---

## 2. 七个真实坑 + 1.0.1 新增的 P8：速查表

> 全部 8 个坑都真实发生过、都有完整证据链，**不要因为它们「已修复」就跳过这一节**——
> 改动配置或升级 DSH 后，同样的坑会以不同面貌复现。
>
> P1–P7 是 1.0.0 期间的坑（见 [RETROSPECTIVE.md](RETROSPECTIVE.md) §4）；
> **P8 是 1.0.1 修复的坑**，也是「知识库不增长」的直接根因（见 §7 决策树 D）。

| # | 症状（你看到的原文） | 可能原因 | 诊断命令 | 处置 |
|---|---|---|---|---|
| **P1** | 面板报 `gateway/service-unavailable`；后端 `ctx.get('obsidianBridge')` 返回 `undefined` | **Host 清单 `service` 悬空**——清单声明了服务名，但 Cordis 上下文里没有对应 Service。网关 strict 分发只认真实 Service，**不读** `descriptor.invoke` | `Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.log" -Pattern 'service-unavailable'` | 确认存在 `ObsidianBridgeService extends TypertRemoteService` 且经 `ctx.plugin()` 挂载（`lib/bridge-service.js:39-55`）。根因见 [RETROSPECTIVE.md §4.1](RETROSPECTIVE.md) |
| **P2** | 面板渲染 `undefined`；日志 `cannot get property "remote.obsidianBridge" without inject` | **Client 直读 `ctx.remote.<ns>`**——点号转发只在 `props` 已声明时生效，未声明时**静默返回 `undefined`，不抛错** | `Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.log" -Pattern 'without inject'` | 改用官方入口 `ctx.inject(['remote.obsidianBridge'], cb)`（`client.js:311-314`）。根因见 [RETROSPECTIVE.md §4.2](RETROSPECTIVE.md) |
| **P3** | 每次 Client 激活都刷一条 `TypeError: e.execute.call is not a function`；卸载后命名空间绑定残留 | **`ctx.effect(fiber)` 误用**——`ctx.inject` 返回的是 fiber wrapper（只有 `.then`/`.dispose`），不是函数 | `Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.error.log" -Pattern 'execute.call'` | 改为 `follow.then(() => { ctx.effect(() => follow.dispose()); })`（`client.js:315-317`）。根因见 [RETROSPECTIVE.md §4.3](RETROSPECTIVE.md) |
| **P4** | 面板渲染 `undefined`，**但通道是通的**（`remote.obsidianBridge 已就绪` 存在） | **漏解包 `{ok, value}`**——Remote 方法不返回原始值，而是包装对象 `{ok:true,value}` / `{ok:false,error}` | `Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.log" -Pattern '面板首次取数成功'` | 确认 `unwrap()` 在 `loadStatus()` 里被调用（`client.js:108-119,134`）。根因见 [RETROSPECTIVE.md §4.4](RETROSPECTIVE.md) |
| **P5** | 日志 `obsidian-bridge (@local/obsidian-bridge): pending (waiting for service: harness)`；**四类事件全部不触发** | **注入了 `harness`**——它只存在于动态包沙箱上下文；静态 bundle 插件注入它，fiber 永远停在 PENDING 且不超时 | `Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-*.error.log" -Pattern 'pending \(waiting for service'` | 从 `inject` 移除 `harness`（现为 `index.js:31`）；Host 调用改走 Typert Remote。根因见 [RETROSPECTIVE.md §4.5](RETROSPECTIVE.md) |
| **P6** | `curl http://127.0.0.1:43120/obsidian-bridge/status` **一律 403**（连 `/` 和随机路径也是），无法区分 200/404 | **两层原因**：① Client 半边**没有 `fetch`**（network belongs to the HOST half）；② HTTP 请求被 Origin 围栏拦截（`dsh-client-connection/lib/index.js:742-743`） | `curl.exe -sS -i http://127.0.0.1:43120/obsidian-bridge/status` | **该路由已于 1.0.1 整体移除**（[CHANGELOG.md](CHANGELOG.md) R-04）。面板走 Typert Remote；如需外部监控请直读 Vault 或走 Typert |
| **P7** | `node test/acceptance.mjs` 报 **14/14 PASS**，但面板就是取不到数据 | **测试假阳性**——`wiring.mjs` / `status-refresh.mjs` 把被测层（`ctx.subprocess.spawn`）mock 掉，断言的是「构造了 spawn 请求」而非「字节写进 Vault」 | `Select-String -Path "test\*.mjs" -Pattern 'spawn\(spec\)'`（找桩） | 以 `node test/e2e-verify.mjs` 为准（判据是外部产物）。根因见 [RETROSPECTIVE.md §4.7](RETROSPECTIVE.md) |
| **P8** | **知识库不增长**：`30_Resources/` 下没有新条目；面板「知识整理」恒为 0；DSH 日志里**没有任何 organize 报错** | **调用了未导出的方法**——`index.js:472` 调 `runner.spawn(...)`，但 `lib/writer.js` 的 `return` 块只导出 `bridge` / `memorySync`；抛 `TypeError: runner.spawn is not a function`，被 `index.js:484` 的 `.catch(() => {})` **吞掉**。三层（日志 / 计数器 / 测试）全部不可见 | `Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"` → **`False` 即命中**（游标文件从未生成 = 脚本从未被插件调用） | **升级到 1.0.1**（`lib/writer.js:140-154` 补 `spawn` 导出）；回归守卫见 `test/wiring.mjs:246-263` 第 12 项。详见 §7 决策树 D 与 [CHANGELOG.md](CHANGELOG.md) F-08 |

> **P6 与 P3 的关系**：`e.execute.call` **不是** Typert 的问题，而是 Cordis `Fiber._execute` 的次生错误。
> 全仓库只有 Cordis 一处 `execute.call`，Typert 栈（loader/registry/protocol/gateway）**零命中**。

> **P8 的教训（最值得记住的一条）**：`runner.spawn` 与 `runner.bridge` 在**源码阅读**上完全对称——
> 都是 `async function` 定义 + 被调用。区别只在 `return {...}` 那一块有没有把它列进去。
> **静态阅读无法发现这类缺陷**，只有「调用 → 观察产物」能证伪。
> 因此凡是新增对 `runner.*` 的调用，**必须同时核对导出表**（`test/wiring.mjs:246-263` 就是为此加的守卫）。

---

## 3. 每个坑的诊断命令

### 3.0 环境与路径

```powershell
$env:APPDATA                                  # → <USER_HOME>\AppData\Roaming
$LOG   = "$env:APPDATA\DSH Desktop\logs\dsh-$(Get-Date -Format 'yyyy-MM-dd').log"
$ERR   = "$env:APPDATA\DSH Desktop\logs\dsh-$(Get-Date -Format 'yyyy-MM-dd').error.log"
$VAULT = "D:/MyVault"
$HOOK  = "$VAULT/00_InteractionLogs/hook-debug.log"
$CONV  = "$VAULT/00_InteractionLogs/$(Get-Date -Format 'yyyy-MM-dd')_conversation.md"
```

### 3.1 一次性抓取插件的全部日志行

```powershell
Select-String -Path $LOG -Pattern 'obsidian-bridge' |
  Select-Object -Last 25 | ForEach-Object { $_.Line }
```

**期望的最后 5 行**（顺序大致如此）：

`client half apply() 开始` → `Typert Remote 已挂载` → `remote.obsidianBridge 已就绪` → `注册 settings.section` → `面板首次取数成功，vaultPath=D:/MyVault`

**只要缺少 `remote.obsidianBridge 已就绪`，就说明断在 P2/P3/P4 之一**——按 §4 的决策树逐层排除。

### 3.2 逐个坑的诊断命令

```powershell
# P1  Host 服务悬空
Select-String -Path $LOG -Pattern 'service-unavailable','obsidianBridge'
# P2  直读属性（静默 undefined）
Select-String -Path $LOG -Pattern 'without inject','remote.obsidianBridge 已就绪'
# P3  ctx.effect 误用
Select-String -Path $ERR -Pattern 'execute\.call'
# P4  漏解包 {ok,value} —— 通道通但面板 undefined
Select-String -Path $LOG -Pattern '面板首次取数成功','快照结构异常'
# P5  注入 harness 致 pending
Select-String -Path $ERR -Pattern 'pending \(waiting for service'
# P6  HTTP 403（预期行为，非缺陷）
curl.exe -sS -i http://127.0.0.1:43120/obsidian-bridge/status
# P7  测试假阳性 —— 找出哪些测试桩掉了 subprocess
Select-String -Path "test\*.mjs" -Pattern 'spawn\(spec\)','resolveExecutable\(cmd\)'
# P8  知识整理静默未运行 —— 游标文件是否存在（不存在即命中）
Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"
#     并手动跑一次脚本，确认脚本本身是好的：
node "D:/MyVault/90_Agent/knowledge-organize.js" '{"limit":20}'
```

### 3.3 验证留痕真的写进了 Vault（绕过所有测试）

```powershell
# 1) 当日会话日志有三个小节
Select-String -Path $CONV -Pattern '会话开始','用户 prompt:','对话结束' |
  Select-Object -Last 5 | ForEach-Object { $_.Line }

# 2) 子进程真的执行完（triggered 与 completed 必须成对）
Select-String -Path $HOOK -Pattern '\[user-prompt\] Hook (triggered|completed)' |
  Select-Object -Last 4 | ForEach-Object { $_.Line }

# 3) 注入块里的笔记路径真实存在
$m = Select-String -Path $CONV -Pattern '知识库相关笔记' -Context 0,12
$paths = [regex]::Matches(($m.Context.PostContext -join "`n"), '30_Resources/[^ )]*\.md')
$paths | ForEach-Object { "{0}  {1}" -f $(if (Test-Path "$VAULT/$($_.Value)") { 'OK  ' } else { 'MISS' }), $_.Value }
```

---

## 4. 决策树 A：面板取不到数据（4 层通道）

> 这是本项目**最耗时**的问题。四层必须**逐层确认上一层成功**，不要跳层。
> 完整叙事见 [RETROSPECTIVE.md §5](RETROSPECTIVE.md)。

```
面板取不到数据
│
├─【第 1 层】Client 半边 apply() 跑了吗？
│   ├─ 日志有「client half apply() 开始」        → 通过，进第 2 层
│   └─ 没有                                        → 查 ENV 层：
│        · profile 的 dsh.profile.bundles 是否含 @local/obsidian-bridge
│        · node_modules/@local/obsidian-bridge 的 LinkType 是否 Junction（复制会静默用旧码）
│        · package.json 的 dsh.client.platform 是否为 "web"
│        验证：node test/e2e-verify.mjs 的 ENV-1 / ENV-2 / C1
│
├─【第 2 层】$mount 成功了吗？
│   ├─ 日志有「Typert Remote 已挂载」             → 通过，进第 3 层
│   └─ 报「Typert Remote 挂载失败」                → 查 contribution 形状：
│        · codec.mode 必须是 'strict'，且 typeSymbol 非空、create 是函数
│        · namespace / method 必须匹配 ^[A-Za-z0-9_$.-]+$
│        · package.json 的 dsh.client.inject 是否含 @deepseek-ai/dsh-api-remotes
│        验证：node test/e2e-verify.mjs 的 C2
│
├─【第 3 层】命名空间取到了吗？
│   ├─ 日志有「remote.obsidianBridge 已就绪」      → 通过，进第 4 层
│   ├─ 报「cannot get property ... without inject」→ P2：必须用 ctx.inject，不能直读属性
│   └─ 两者都没有（静默）                          → 同样是 P2 —— 直读属性**不抛错**，只是 undefined
│        验证：node test/e2e-verify.mjs 的 C3
│
├─【第 4 层】数据解包了吗？
│   ├─ 面板显示「暂时无法读取桥接状态：...失败: <code>: <message>」
│   │                                            → 通道通但解包/调用失败：查 P4 的 unwrap
│   ├─ 面板显示数字但明显偏旧                       → K-01：面板只在挂载期间轮询，切走再切回
│   └─ 仍有 error 日志（如 e.execute.call）         → P3：fiber wrapper 被传给了 ctx.effect
│        验证：node test/e2e-verify.mjs 的 C4 / C5
│
└─ 全部通过但仍无数据 → 查 Host 侧服务是否挂载（P1）与快照构建器是否注入
```

**每层的判据都必须是「日志里出现了某一行」**，而不是「我觉得应该成功了」。

---

## 5. 决策树 B：留痕不生效

> 症状：DSH 里对话正常，但 Vault 里**没有**新文件，或文件内容不增长。

```
留痕不生效
│
├─【闸门 1】插件加载了吗？
│   ├─ 日志有「Typert Remote 服务已挂载 (obsidianBridge)」→ 通过
│   └─ 没有 → 跳到 §6（插件根本没加载）
│
├─【闸门 2】事件开关开了吗？
│   ├─ 面板「事件开关」四项均「已启用」             → 通过
│   └─ 有「已停用」→ 查 CONFIG.md §5：关闭语义是 !== false，
│        写 0 / "false" / 留空 都是开启；必须显式写 false
│
├─【闸门 3】nodePath 解析成功了吗？
│   ├─ hook-debug.log 出现 [<事件>] Hook triggered   → 通过
│   └─ 没有                                        → 两个原因：
│        · nodePath 指向的文件不存在（resolveExecutable 失败 → 本次调用整体放弃）
│        · Vault 脚本不存在（路径拼错）
│        验证：Select-String -Path $HOOK -Pattern 'Hook triggered'
│
├─【闸门 4】子进程执行完了吗？
│   ├─ 同一事件同时有 triggered 与 completed         → 通过
│   └─ 只有 triggered、没有 completed                → 脚本崩了或超时被杀（宽限期 8s）
│        验证：Select-String -Path $HOOK -Pattern '\[user-prompt\] Hook'
│
├─【闸门 5】文件真的出现了吗？
│   ├─ $CONV 行数增长 / 含新小节                     → 通过
│   └─ 没增长                                        → vaultPath 写错（写操作的 cwd 不存在）
│
└─【闸门 6】是「空参数/不相关关键词」被过滤了吗？（预期行为，不是缺陷）
    ├─ 参数为 {} / {"value":""} / {"value":null} → 第一道闸门（index.js:432-434）
    ├─ 参数不含 project/task/todo/plan/roadmap/memory/remember/recall/forget/knowledge/note → 第二道（index.js:437-441）
    └─ 结论：**留痕**数必然远小于实际工具调用数，这是刻意降噪（见 K-02）。
        注意 1.0.1 起 **`toolEvents` 计数是全量的**（index.js:411），
        面板「工具调用事件」= 实际工具调用数；只有 Vault 里的 post-tool 留痕才被降噪。
```

> **验证留痕写真的落盘**，用 §3.3 的三条命令——它们直接读 Vault 文件，不经过任何测试框架。
>
> **⚠️ 决策树 B 只覆盖「留痕」**。如果你要排查的是「**知识库**不增长」（`30_Resources/` 下没有新条目），
> 那是**另一条链路**（留痕 → 提炼），走 §7 决策树 D。两者容易混淆：
> 留痕正常**不代表**知识库会增长——1.0.0 期间留痕一直正常，但知识整理从未运行过（P8）。

---

## 6. 决策树 C：插件根本没加载

```
插件没加载
│
├─ 症状 A：DSH 日志里完全没有 [obsidian-bridge] 字样
│   ├─ profile 的 dsh.profile.bundles 是否含 @local/obsidian-bridge
│   ├─ profile 的 package.json 的 dependencies 是否有该包（link: 指向工作区）
│   ├─ profile 的 desktopDeselectedBundles 是否含它（DSH 2.0.18 中是纯 UI 台账，不影响加载，
│   │   但会让管理页显示「未勾选」，别被它误导）
│   └─ 验证：node test/e2e-verify.mjs 的 ENV-1 / ENV-2
│
├─ 症状 B：日志出现 pending (waiting for service: xxx)
│   ├─ xxx 是 harness → P5：移除该注入（只存在于动态包沙箱）
│   ├─ xxx 是 webServer → **1.0.1 已移除该依赖**；若仍报，说明代码不是 1.0.1
│   │   （1.0.0 曾把它声明为硬依赖；现 `inject` 只有 `['agents','fs','subprocess']`，`index.js:31`）
│   └─ xxx 是其他服务 → 该服务未在 profile 中加载，补 bundle
│
├─ 症状 C：日志出现 ERR_MODULE_NOT_FOUND
│   ├─ 缺 schemastery → 该包解析自 profile 的 node_modules，不从 npm 装
│   ├─ 缺 dsh-typert-protocol → Host 安装目录回退解析；失败时面板不可用但留痕仍可用
│   └─ 验证：node test/e2e-verify.mjs 的 M1 / M2
│
└─ 症状 D：改了代码但行为没变
    ├─ `(Get-Item "<USER_HOME>\.dsh\profiles\desktop\node_modules\@local\obsidian-bridge").LinkType`
    │   → 必须是 `Junction`；复制目录会让 test/wiring.mjs 通过但运行时用旧码（K-04）
    └─ 改完**完全退出 DSH** 再启动了吗？（HMR 对 junction bundle 不生效）
```

---

## 7. 决策树 D：知识库不增长

> **症状**：DSH 里对话正常，`00_InteractionLogs/*_conversation.md` 也在增长，
> **但 `30_Resources/` 下没有新的知识条目**（`KB-*.md` 数量不变）。
>
> 这是**用户实际报过的问题**，也是 P8 的场景。它与决策树 B（留痕不生效）**是两条不同的链路**：
>
> ```
> 链路 1（留痕）  DSH 事件 → bridge.js 子进程 → 00_InteractionLogs/*.md        ← 决策树 B
> 链路 2（提炼）  *_conversation.md → knowledge-organize.js 子进程 → 30_Resources/**/KB-*.md   ← 本决策树
> ```
>
> **关键**：链路 1 正常**不代表**链路 2 会跑。1.0.0 期间链路 1 一直正常，但链路 2 **从未运行过**。

### 7.1 一张图看懂「为什么以前不增长」

| 版本 | 链路 2 的调度方 | 结果 |
|---|---|---|
| 1.0.0 及之前 | `knowledge-engine.js organize` 是**独立 CLI，没有任何自动调用方** | 只能手动跑；不跑就永不增长 |
| 1.0.1（修复前） | 新增 `maybeOrganize()` 接线，但调用了**未导出的** `runner.spawn` → 异常被吞 | **仍然永不增长**，且日志/计数器/测试三层都看不见（P8） |
| **1.0.1（修复后）** | `maybeOrganize()` → `runner.spawn`（已导出）→ `knowledge-organize.js` | 每次 `stop` 后按节流自动整理 ✅ |

### 7.2 决策树

```
知识库不增长（30_Resources/ 下没有新 KB-*.md）
│
├─【闸门 0】先确认「上游留痕」是通的
│   └─ $CONV 有增长吗？没有 → 先走决策树 B（留痕不生效），链路 2 依赖链路 1 的产物
│      验证：Select-String -Path $CONV -Pattern '用户 prompt:','对话结束'
│
├─【闸门 1】插件版本是 1.0.1 吗？（P8 的关键）
│   ├─ 1.0.0 → **必然不增长**（当时没有自动调用方）。升级到 1.0.1
│   └─ 1.0.1 → 进闸门 2
│      验证：node -e "console.log(require('./package.json').version)"
│
├─【闸门 2】organize 开关开了吗？
│   ├─ 面板「事件开关」→ 无「知识整理」开关（它挂在 stop 上，没有独立开关）
│   ├─ 看 cordis.patch.yml 的 organize.enabled
│   └─ ⚠️ 默认是 true —— 但若显式写了 false，整理永不触发
│      验证：CONFIG.md §3.6；配置里没有 organize 段 = 用默认值 = 开启
│
├─【闸门 3】enabled.stop 开了吗？
│   └─ **整理挂在 `agent/turn-stopping` 上**（index.js:453）。stop 关了就永远不会整理
│      验证：面板「回合结束（摘要 + 治理）」是否「已启用」
│
├─【闸门 4】节流挡住了吗？
│   ├─ minIntervalMs 默认 300000（5 分钟）。5 分钟内连续 stop 只整理第一次
│   └─ lastOrganizeAt 是**进程内存**，重启 DSH 后首次 stop 会立即整理一次
│      验证：连续发两轮对话，间隔 > 5 分钟，看面板「知识整理」是否 +1
│
├─【闸门 5】★ 子进程真的起来了吗？（P8 的落点）
│   ├─ **最关键的一条**：游标文件是否存在
│   │   Test-Path "D:/MyVault/90_Agent/knowledge-organize-cursor.json"
│   │   ├─ False → **脚本从未被插件调用过** → 命中 P8
│   │   │    · 1.0.1 修复前：runner.spawn 未导出，异常被 .catch(() => {}) 吞掉
│   │   │    · 检查 lib/writer.js 的 return 块是否含 spawn(args, stdinData)
│   │   │    · 回归守卫：node test/wiring.mjs 第 12 项
│   │   └─ True → 脚本至少跑过一次，进闸门 6
│   ├─ 面板「知识整理」计数：
│   │   ├─ 恒为 0 且游标不存在 → P8
│   │   ├─ organizeFailed > 0（面板显示「失败 N」）→ 子进程非零退出，看下一步
│   │   └─ organizeRuns > 0 → 正常，进闸门 6
│   └─ 手动验证脚本本身是否可用（隔离插件）：
│       node "D:/MyVault/90_Agent/knowledge-organize.js" '{"limit":20}'
│       期望 stdout 形如 {"scanned":N,"created":M,"skipped":K,"cursor":<ts>}
│       · 脚本能跑出 created>0 → **责任在插件接线**（P8 类型）
│       · 脚本报错 → 责任在脚本/Vault 环境
│
├─【闸门 6】游标把新内容跳过了吗？
│   ├─ 游标只处理 `timestamp > lastOrganizedAt` 的 section
│   ├─ 若日志里的时间戳**早于**游标（例如补写历史日志）→ 会被永久跳过
│   └─ 绕过：删掉 90_Agent/knowledge-organize-cursor.json（下次会全量重扫；
│      去重靠 contentHash，不会重复生成已存在的条目）
│
├─【闸门 7】质量门拦下了吗？（预期行为，不是缺陷）
│   ├─ 三道门：①类型门（session-start）②内容门（长度 < 80 字符 / 命中「会话开始」等）
│   │   ③system-prompt 泄漏门（"You are a helpful assistant" 等）
│   ├─ 判据：手动跑脚本看 skipped 值。若 scanned>0 但 created=0，全是质量门拦的
│   └─ 这是**刻意的**：旧 CLI 无质量门时产出过 291 条垃圾条目（见闸门 8）
│
└─【闸门 8】Vault 里已有大量垃圾条目，掩盖了「新增」？
    ├─ 现状：30_Resources/experience/ 下有 **291 条**历史垃圾条目（K-11）
    │   —— 由旧 CLI 无去重地重复生成，标题是乱码
    │   （如 KB-20261019-0520_用户_prompt_最终验证_hook_是否正常工作_---_type_conv.md）
    ├─ 判据：比较「今天新增的 KB-*.md 数量」，而不是总数
    │   Get-ChildItem "D:/MyVault/30_Resources" -Recurse -Filter 'KB-*' |
    │     Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-1) } | Measure-Object
    └─ 处置：1.1.0 会提供清理脚本；临时可手动删除 experience/ 下的乱码条目
```

### 7.3 三分钟自检（复制即用）

```powershell
$VAULT = "D:/MyVault"

# ① 游标文件在不在？（不在 = P8，脚本从未被插件调用）
Test-Path "$VAULT/90_Agent/knowledge-organize-cursor.json"

# ② 最近 1 小时新增的 KB 条目数（0 = 没在增长）
Get-ChildItem "$VAULT/30_Resources" -Recurse -Filter 'KB-*' |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-1) } | Measure-Object

# ③ 面板计数（需启动令牌）——organizeRuns / organizeFailed
#    或直接读快照：设置 → Obsidian 桥接 → 「知识整理」行

# ④ 脚本本身能不能跑（隔离插件）
node "$VAULT/90_Agent/knowledge-organize.js" '{"limit":20}'

# ⑤ 插件是否真的导出了 spawn（1.0.1 回归守卫）
cd "<USER_HOME>\Documents\deepseek-harness\default-workspace\obsidian-bridge"
node test/wiring.mjs      # 第 12 项：createRunner 导出 bridge / memorySync / spawn
```

**判定表**：

| ①游标 | ②新增 | ④脚本 | 结论 |
|---|---|---|---|
| 不存在 | 0 | 能跑出 created>0 | **P8**：插件没调到脚本（1.0.0，或 1.0.1 的 `spawn` 导出缺失） |
| 不存在 | 0 | 报错 | 脚本/Vault 环境问题（nodePath、路径、权限） |
| 存在 | 0 | 能跑 | 闸门 6/7：游标跳过 或 质量门全拦（后者可能是**正常**的） |
| 存在 | >0 | — | ✅ 正常工作 |

### 7.4 为什么这个坑值得单独一节

`runner.spawn` 与 `runner.bridge` 在源码阅读上**完全对称**：都是 `async function` 定义、都被调用。
区别只在 `lib/writer.js` 的 `return {...}` 有没有把它列进去。

- **日志看不到**：异常被 `.catch(() => {})` 吞掉（`index.js:484`），零输出
- **计数器看不到**：`organizeRuns` / `organizeFailed` 都停在 0，而「0 次」与「从未运行」不可区分
- **测试看不到**：没有任何测试断言「知识库增长」（1.0.1 才补了导出表守卫）

**唯一能证伪的是产物**——游标文件是否存在。这也是本文反复强调「锚定外部产物」的原因：
**静默失败不会留下错误信息，只会留下「什么都没发生」。**

---

## 8. 常见错误信息速查

| 错误信息原文 | 对应坑 | 一句话处置 |
|---|---|---|
| `gateway/service-unavailable` | P1 | 挂载真实 Cordis Service，别只写清单 |
| `cannot get property "remote.obsidianBridge" without inject` | P2 | 用 `ctx.inject(['remote.<ns>'], cb)` |
| `TypeError: e.execute.call is not a function` | P3 | 别把 fiber wrapper 传给 `ctx.effect` |
| `ctx.remote.obsidianBridge 不可用（服务未建立）` | P2 | 同上（旧版文案） |
| 面板渲染 `undefined`（无报错） | P2 / P4 | 先确认 `remote.obsidianBridge 已就绪`，再看是否漏 `unwrap` |
| `pending (waiting for service: harness)` | P5 | 移除 `harness` 注入 |
| `pending (waiting for service: webServer)` | — | **1.0.1 已移除该依赖**；仍报说明代码不是 1.0.1 |
| `SdkError: Request timed out`（MCP） | — | MCP server 响应缺 `jsonrpc:"2.0"` |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery` | — | 从 profile 的 `node_modules` 解析，别从工作区直接跑 `run.mjs`/`wiring.mjs` |
| HTTP 403（任意路径） | P6 | **路由已移除**（1.0.1）。面板走 Typert Remote；外部监控直读 Vault |
| `14/14 PASS` 但功能不可用 | P7 | 以 `e2e-verify.mjs` 为准；`wiring.mjs` 是部分连通级断言 |
| **`TypeError: runner.spawn is not a function`**（**通常看不到**） | **P8** | 异常被 `.catch(() => {})` 吞掉。判据是**游标文件不存在**；升级到 1.0.1 |
| 面板「知识整理」恒为 0 | P8 / 闸门 3/4 | 先 `Test-Path` 游标文件；再查 `enabled.stop` 与 `minIntervalMs` |
| 面板「索引构建失败」> 0 | — | `vaultPath` 写错或扫描根缺失（1.0.1 新增该计数，此前伪装成「空 Vault」） |
| 面板「MCP 工具」显示「未知（见 MCP 面板）」 | — | `ctx.tools.schemas()` 无法枚举；不是 0，是「读不到」 |
| `governance.everyStops` 配了不生效 | — | **1.0.1 已删除该字段**（死配置）；治理由 Vault 侧 `bridge.js` 自行触发 |

---

## 9. 提交 issue 时请提供什么

> 缺任何一项，维护者都要来回追问，定位时间会成倍增加。

**必填**

1. **环境与版本**（逐项照抄，不要写「最新版」）：
   - DSH Desktop 版本：`resources/app/package.json` 的 `version`（实测 2.0.18）
   - Cordis 版本：`node_modules/@deepseek-ai/cordis/package.json`
   - Node 版本：`node -v`（实测 v24.15.0）
   - 插件版本：`package.json` 的 `version` + `dsh.manifestVersion`
   - profile 名与 Vault 根目录
2. **完整错误原文**：贴**日志行原文**（含时间戳与 runId），不要转述、不要截图。
3. **DSH 日志摘录**：
   ```powershell
   Select-String -Path "$env:APPDATA\DSH Desktop\logs\dsh-$(Get-Date -Format 'yyyy-MM-dd').log" `
     -Pattern 'obsidian-bridge' | Select-Object -Last 25
   ```
4. **复现步骤**：从「完全退出 DSH」开始写，逐步编号。**不要**写「正常使用时偶尔出现」。
5. **已尝试的处置**：写明你改了什么、结果如何——避免维护者重复建议。

**强烈建议附上**

6. **一键自检输出**：`node test/e2e-verify.mjs` 的完整输出（含 PASS/FAIL/MANUAL 计数）。
7. **Vault 侧证据**：`hook-debug.log` 中相关事件的 `triggered` / `completed` 行。
8. **明确「期望 vs 实际」**：一句话说清你期望发生什么、实际发生了什么。
9. **是否可复现**：每次必现 / 偶发（写明频率）/ 只出现一次。

**不要提供**：❌ HMAC 密钥或任何令牌（`OBSIDIAN_BRIDGE_HMAC_SECRET`、`DSH_LAUNCH_TOKEN`）；
❌ 整份 DSH 日志原文件（几十 MB）——只贴相关行；❌ 无证据的猜测（可作附注，不要当结论）。

---

**相关文档**：[RELEASE-1.0.md](RELEASE-1.0.md)（已知问题 K-01…K-12）｜
[CONFIG.md](CONFIG.md)（配置项与常见配置错误）｜[CHANGELOG.md](CHANGELOG.md)（版本变更）｜
[RETROSPECTIVE.md](RETROSPECTIVE.md)（7 个坑的完整根因与证据链；P8 见 [CHANGELOG.md](CHANGELOG.md) F-08）。
