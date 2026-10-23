import { Config, resolveConfig, scriptPath } from './lib/config.js';
import {
  createInjectedUserMessage,
  isRealUserMessage,
  isSubagent,
  messageText,
} from './lib/message.js';
import { buildVaultIndex } from './lib/vault-index.js';
import { extractKeywords, formatKnowledgeContext, queryIndex } from './lib/query.js';
import { createRunner } from './lib/writer.js';
import { buildSnapshot, createStatus } from './lib/status.js';
import { resetStore, setRefreshHook, setSnapshot, setSnapshotBuilder } from './lib/status-store.js';
import { mountBridgeService } from './lib/bridge-service.js';

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'obsidian-bridge';

/**
 * 依赖的服务。
 *
 * **不要**注入 `harness` —— 它只存在于动态包的沙箱上下文；在普通 Cordis 插件里
 * 注入会让插件永久 pending（实测日志 "pending (waiting for service: harness)"，
 * 整个插件停摆）。
 *
 * **不要**注入 `webServer` —— v1.0.0 曾用它注册 HTTP 状态路由，但因果查询确认：
 * 代码内 0 个消费者，唯一潜在消费者（Client 面板）没有 fetch 能力，外部 curl
 * 又被启动令牌围栏挡在 403（`dsh-client-connection/lib/index.js:742-743`）。
 * 累计 `status-hit` 仅 1 次（还是自测打的）。该路由与依赖已于 v1.0.0 移除。
 * 面板取数统一走 Typert Remote（见 `typert.host.js` + `lib/bridge-service.js`）。
 */
export const inject = ['agents', 'fs', 'subprocess'];

export { Config };

/** 索引重建的最小间隔。 */
const INDEX_TTL_MS = 5 * 60 * 1000;
/** Host 调用方法名：读取状态快照。 */
export const HOST_METHOD_STATUS = 'obsidianBridge.status';
/** Host 调用方法名：强制重建索引后返回快照。 */
export const HOST_METHOD_REFRESH = 'obsidianBridge.refresh';

/**
 * 本插件统计工具数时针对的 MCP server 名。
 *
 * 必须与 `cordis.patch.yml` 里 `obsidian-mcp` 行的 `config.serverName` 一致。
 * MCP 工具命名规则为 `mcp__<serverName>__<toolName>`。
 *
 * **导出它是为了让测试能核对这份一致性**（交叉评审 FN-4）：
 * 此前这个常量与 patch 里的 `serverName` 是两处独立声明，一旦漂移，
 * `countMcpTools()` 的前缀匹配会静默返回 0，面板显示「未加载」却不报错 ——
 * 没有任何信号提示配置不一致。
 */
export const OBSIDIAN_MCP_SERVER = 'obsidian-local';

/**
 * 从会话日志尾部向前找到本轮最后一条助手消息的文本。
 * @param session - 会话对象。
 * @returns 助手消息文本，找不到时为空串。
 */
function lastAssistantText(session) {
  // 第一档：从会话日志尾部向前找本轮的助手消息。
  // 注意 agent/turn-stopping 在回合关闭前触发，本轮消息可能尚未落盘，
  // 因此这一档有时会取不到。
  try {
    for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq);
      if (!event) continue;
      if (event.type === 'assistant/message') {
        const message = event.data?.message;
        if (message) {
          const text = messageText(message);
          if (text) return text;
        }
      }
      if (event.type === 'turn/start') break;
    }
  } catch {
    // 读取失败时走第二档
  }
  // 第二档：派生消息列表，覆盖第一档取不到的情况
  try {
    const messages = session.deriveMessages();
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'assistant') continue;
        const text = messageText(message);
        if (text) return text;
      }
    }
  } catch {
    // 两档都失败时退化为空摘要
  }
  return '';
}

/**
 * 注册 Obsidian 桥接插件。
 *
 * 四类事件与 PRD §5.1.2 的映射：
 * - `agent/pre-step`  → `user-prompt`：检索知识库并注入上下文，同时留痕
 * - `tools/result`    → `post-tool`：检测项目/记忆操作并留痕
 * - `agent/turn-stopping` → `stop`：记录响应摘要，按阈值触发治理
 * - `agent/created`   → `session-start`：同步 WorkBuddy 记忆并记录会话开始
 * @param ctx - Cordis 上下文。
 * @param config - Loader 提供的配置。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const status = createStatus();

  // 清空共享状态：这些是模块级变量，会跨 apply() 存活。
  // HMR 重载 / 同进程重新激活时若不清理，新实例在首次 touch() 前会读到
  // **上一个实例**的快照（实测泄漏 sessionStarts:1）。
  resetStore();

  // 写入失败此前只写 debug 日志，面板完全看不到（静默失败）。接进计数器。
  const runner = createRunner(ctx, cfg, (failure) => {
    status.record('writeFailures', failure);
  });

  // 挂载 Typert Remote 服务：网关按 ctx.get('obsidianBridge') 解析 invocation，
  // 服务不存在时 strict 分发直接抛 gateway/service-unavailable。
  // 后台挂载，不阻塞 apply（事件处理器必须同步注册）。
  // 挂载失败不影响核心桥接（G1/G2），面板会显示不可用提示。
  //
  // **失败必须可见**（D9）：`mountBridgeService` 内部已 warn 一次，
  // 这里的 `.catch(() => {})` 是第二层吞异常 —— 若内部逻辑改动导致 reject，
  // 日志里只剩一条语焉不详的 warn，无法判断是「包解析失败」还是「plugin 抛错」。
  void mountBridgeService(ctx)
    .then((mounted) => {
      if (!mounted) ctx.logger?.warn?.('obsidian-bridge: Typert Remote 服务挂载失败，面板将不可用');
    })
    .catch((error) => {
      ctx.logger?.warn?.(`obsidian-bridge: Typert Remote 服务挂载异常 — ${error?.message ?? error}`);
    });

  /**
   * 最近一次知识整理的时间戳（用于节流）。
   * 进程内存，每次 DSH 启动重置为 0 —— 首次 stop 会立即整理一次。
   */
  let lastOrganizeAt = 0;

  let index = [];
  let indexPromise = null;
  let indexBuiltAt = null;
  /**
   * 最近一次见到的 agent。
   *
   * 用于 `ctx.tools.schemas(scope)` —— 该 API 需要 agent 作用域才能枚举工具表
   * （官方用法见 `dsh-tool-cordis/lib/types/providers.js:52`）。
   */
  let lastAgent = null;

  /**
   * 强制丢弃缓存，下次 ensureIndex 会重建。
   *
   * **必须同时清 `indexPromise`**：否则扫描进行中调用 `refresh()` 时，
   * `ensureIndex` 会直接返回在飞的那次 Promise，**重建变成空操作**
   * （实测 `listDirCalls 1 → 1`，应为 +1）。
   */
  function invalidateIndex() {
    index = [];
    indexBuiltAt = null;
    indexPromise = null;
  }

  /**
   * 强制重建索引、刷新快照并返回新索引。
   *
   * **必须调 `snapshot()`**：否则 `refresh()` 返回的快照里 `index.size` /
   * `builtAt` 仍是旧值，而 `indexBuilt` 计数器已 +1 —— 同一份状态自相矛盾。
   * @param signal - 取消信号。
   * @returns 新的索引数组。
   */
  async function rebuildIndex(signal) {
    invalidateIndex();
    const built = await ensureIndex(signal);
    // 重建后立即同步快照，保证 refresh() 的返回值与计数器一致
    snapshot();
    return built;
  }

  // Typert Remote 的 invoke / 服务方法从这里读快照；刷新走上面的重建函数。
  // 兜底构建器保证首次取数不会拿到 null（面板可能在激活完成前就轮询）。
  setRefreshHook(() => rebuildIndex());
  setSnapshotBuilder(() => snapshot());

  /**
   * 取得内存索引，必要时重建。
   *
   * **失败不能伪装成成功**：`buildVaultIndex` 内部会吞掉扫描异常并返回 `[]`，
   * 若此处照样 `record('indexBuilt', { size: 0 })`，面板会把「扫描失败」显示成
   * 「空 Vault」。因此区分两种情形：
   * - 成功：记录 `indexBuilt` + `size`
   * - 失败：记录 `indexFailed`，且**不**设置 `indexBuiltAt`（快照里 `ok: false`）
   *
   * **fresh 判定必须看时间戳而不是条数**（D6）：此前条件含 `index.length > 0`，
   * 导致**空 Vault 或首次扫描返回 0 条时永不 fresh** —— 每次 prompt 都全量重扫，
   * 而 `indexBuilt` 计数照涨，面板显示「已构建 139 条」的同时其实在反复重扫。
   * 现在只要成功构建过（`indexBuiltAt !== null`）且在 TTL 内即视为 fresh。
   * @param signal - 取消信号。
   * @returns 索引数组（失败时为空数组）。
   */
  async function ensureIndex(signal) {
    const fresh = indexBuiltAt !== null && Date.now() - indexBuiltAt < INDEX_TTL_MS;
    if (fresh) return index;
    if (!indexPromise) {
      indexPromise = buildVaultIndex(ctx, cfg.vaultPath, signal)
        .then((built) => {
          // buildVaultIndex 返回 { entries, ok, failedRoots }；
          // ok=false 表示一个根目录都没扫到（配置或权限问题），
          // 此时**不能**记成成功的 indexBuilt，否则面板把故障显示成「空 Vault」。
          if (!built.ok) {
            status.record('indexFailed', { reason: 'no-root-scanned', failedRoots: built.failedRoots });
            return index;
          }
          index = built.entries;
          indexBuiltAt = Date.now();
          status.record('indexBuilt', { size: built.entries.length, failedRoots: built.failedRoots });
          return index;
        })
        .catch((error) => {
          // 扫描抛错：保留旧索引，标记失败，不更新 indexBuiltAt
          status.record('indexFailed', { reason: String(error?.message ?? error) });
          return index;
        })
        .finally(() => {
          indexPromise = null;
        });
    }
    return indexPromise;
  }

  /**
   * 统计 `obsidian-local` MCP server 暴露的工具数。
   *
   * 原先快照里传的是 `cfg.mcpTools`，但该字段在 Config schema 与 resolveConfig
   * 里都不存在（死配置）→ 恒为 null → 面板永远显示写死的 `'obsidian-local（15 个）'`。
   * 那是常量，不是观测值：MCP server 换版本后数字不会变。
   *
   * **API 形状**：`ToolsService` 上没有 `list()` 方法，也没有 `tools` 属性
   * （枚举 `dsh-tools/lib/index.js` 类体确认）。官方读取工具表的方式是
   * `ctx.tools.schemas(scope)` —— 见 `dsh-tool-cordis/lib/types/providers.js:52`
   * 的 `ctx.tools.schemas(context.agent)`，实现为
   * `[...this.view(scope).visible.values()].map((d) => this.schemaOf(d, true))`。
   * 因此本插件记录**最近一次见到的 agent** 作为 scope。
   *
   * **必须按具体 server 过滤**：`schemas()` 返回**全部**可见工具的 schema，
   * 而 `mcp__` 前缀会匹配所有 MCP server 的工具。实测本会话有 222 个跨 server
   * 的 MCP 工具，导致面板把「obsidian-local（15 个）」显示成「222 个」。
   * 工具命名规则是 `mcp__<serverName>__<toolName>`，故按 server 名精确匹配。
   *
   * @returns obsidian-local 的工具数；无法枚举时返回 null
   *   （面板据此显示「未知」，而不是编一个数）。
   */
  function countMcpTools() {
    try {
      const tools = ctx.get('tools');
      if (!tools || typeof tools.schemas !== 'function') return null;
      // scope 用最近一次见到的 agent；没有 agent 时传 undefined（由服务自行处理）
      const schemas = tools.schemas(lastAgent ?? undefined);
      if (!Array.isArray(schemas)) return null;
      const names = schemas.map((t) => (typeof t === 'string' ? t : (t?.name ?? t?.function?.name ?? '')));
      const prefix = `mcp__${OBSIDIAN_MCP_SERVER}__`;
      const mcp = names.filter((n) => typeof n === 'string' && n.startsWith(prefix));
      // 该 server 一个工具都没有时返回 0（而不是 null）——0 也是真实观测值
      return mcp.length;
    } catch {
      return null;
    }
  }

  /**
   * 组装当前快照。
   * @returns 可 JSON 序列化的状态快照。
   */
  function snapshot() {
    const value = buildSnapshot(
      cfg,
      status,
      {
        size: index.length,
        builtAt: indexBuiltAt,
        // 构建失败与「空 Vault」此前不可区分（都是 size:0）——用 ok 标记区分
        ok: indexBuiltAt !== null,
      },
      { mcpTools: countMcpTools() },
    );
    // 同步给 Typert Remote 的 invoke（Client 面板从这里取数）
    setSnapshot(value);
    return value;
  }

  /**
   * 刷新共享存储里的快照。
   *
   * `snapshot()` 原本只在 HTTP 路由里被调用，而该路由在 Client 半边拿不到
   * （浏览器半没有 fetch），导致面板一直读到旧值。每个事件后调用一次，
   * 保证 Typert invoke 读到的是最新状态。
   */
  function touch() {
    snapshot();
  }

  /** 会话开始：同步 WorkBuddy 记忆并记录会话开始。 */
  ctx.on('agent/created', ({ agent }) => {
    // 记录 agent 作用域，供 `ctx.tools.schemas(scope)` 枚举工具表
    if (agent && !isSubagent(agent)) lastAgent = agent;
    if (!cfg.enabled.sessionStart || isSubagent(agent)) return;
    runner.memorySync();
    runner.bridge('session-start', {});
    status.record('sessionStarts');
    touch();
  });

  /** 用户 prompt：检索知识库并注入上下文，同时留痕。 */
  ctx.on(
    'agent/pre-step',
    async ({ agent, step, turn, signal }, next) => {
      // 记录 agent 作用域（pre-step 每回合都触发，比 agent/created 更及时）
      if (agent && !isSubagent(agent)) lastAgent = agent;
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;
      // 只有每轮的第一步才是用户 prompt 步骤
      if (step !== 1) return decision;

      // `decision.messages` 可能缺失或为空（其他监听者返回的决策形状不受本插件控制），
      // waterfall 无异常兜底 —— 抛错会打断整个回合，因此这里必须防御。
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      if (messages.length === 0) return decision;

      // **不能取 `messages[messages.length - 1]`** ——
      // `preStep` 的默认 waterfall 返回 `{ messages: [...claimed, context] }`，
      // 运行时上下文消息（`source.kind === 'runtime-context'`）被**追加在末尾**。
      // 取末位拿到的是上下文消息，`isRealUserMessage` 永远为 false，
      // 于是**整个 prompt 留痕与知识注入链路静默失效**（实测：会话开始/对话结束
      // 都有记录，唯独「用户 prompt:」0 条 —— E2 就是抓这条的）。
      // 正确做法：取**最后一条真实用户消息**（跳过注入的上下文消息）。
      let last = null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const candidate = messages[i];
        if (isRealUserMessage(candidate)) {
          last = candidate;
          break;
        }
      }
      if (!last) return decision;

      // 诊断探针：记录注入闸门的现场，用于定位「用户 prompt」判定。
      //
      // **受 `enabled.diagnose` 控制**（D7）：此前无条件执行，每轮都写一条，
      // `bridge-diagnostics.jsonl` 实测已 24 KB 且随对话无界增长。
      // 它只是排查工具，默认关闭；需要排查时打开即可。
      if (cfg.enabled.diagnose) {
        runner.bridge('diagnose', {
          step,
          turn,
          messageCount: decision.messages.length,
          lastRole: last?.role ?? null,
          lastSource: last?.source?.kind ?? null,
          decisionKind: decision.kind,
          aborted: signal.aborted,
        });
      }

      const promptText = messageText(last);
      if (!promptText.trim()) return decision;

      let injectedText = '';
      let injectedCount = 0;
      // 索引构建必须与 `enabled.prompt` 门控一致（D5）：
      // 此前索引构建写在开关检查**之前**，关掉 prompt 开关后仍会全量扫描 Vault
      // 并计入 `indexBuilt`，而实际上一条都不会注入 —— 白扫一遍还计数。
      if (cfg.inject.enabled && cfg.enabled.prompt) {
        try {
          const entries = await ensureIndex(signal);
          const keywords = extractKeywords(promptText, cfg.inject.minKeywordLength);
          const results = queryIndex(entries, { keywords, limit: cfg.inject.limit });
          if (results.length > 0) {
            injectedText = formatKnowledgeContext(results);
            // 记录**实际注入条数**，而不是配置上限
            injectedCount = results.length;
          }
        } catch {
          // 检索失败时跳过注入，仍记录对话
        }
      }

      // `enabled.prompt` 的语义是「本插件的 prompt 处理总开关」：
      // 留痕、计数、注入三者必须一起受它控制。此前注入返回写在该块之外，
      // 导致关掉开关后面板显示「已停用」但知识仍被注入（开关欺骗用户）。
      if (!cfg.enabled.prompt) return decision;

      runner.bridge('user-prompt', { prompt: promptText, injected: injectedText });
      status.record('prompts', { injected: injectedText.length > 0 });
      if (injectedText) status.record('injections', { entries: injectedCount });
      // `touch()` 必须在条件之外：留痕/计数已完成，快照就该刷新。
      // 此前把它放进 `if (injectedText)`，导致「留痕了但没注入」时快照不更新，
      // 面板上的 index.size / builtAt / mcpTools 会停在旧值。
      touch();

      if (!injectedText) return decision;
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createInjectedUserMessage(injectedText, injectedCount),
        ],
      };
    },
    { prepend: true },
  );

  /**
   * 工具调用结束：计数 + 按相关性留痕。
   *
   * **签名必须是位置参数 `(exec, result)`** —— `tools/result` 是普通 emit，
   * 派发两个位置参数；写成 `({ exec })` 解构会得到 `undefined`，进而
   * `exec?.arguments ?? {}` → `'{}'` → 恒判定「无内容」→ **整个处理器静默失效**
   * （计数恒 0、`post-tool` 留痕全丢）。
   *
   * 证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502`
   *       `'tools/result'(this, exec: ToolExecution, result: ToolExecutionResult)`
   *       `dsh-tools/lib/types/index.js:1079` `dispatch('emit', [scope, 'tools/result', exec, result])`
   *       `cordis/lib/index.js:281` `cb(...args)`
   *
   * 对比：`agent/*` 系列是 waterfall/serial，载荷是对象，所以用 `({ agent })`。
   * **两类事件的签名不同，不能照抄。**
   *
   * **计数与留痕是两件事，不能合并判断**：
   * - `toolEvents` 语义是「发生过多少次工具调用」，必须**每次**都 +1。
   * - Vault 留痕才需要降噪（空参数产生 `工具:  输入: {}` 噪声，实测累积 1600+ 条）。
   */
  ctx.on('tools/result', (execArg, resultArg) => {
    if (!cfg.enabled.tool) return;

    // 防御性归一：兼容位置参数（现行）与对象载荷（若平台改回）两种形态。
    // 这样即使未来派发形态变化，也只是退化为「计数正常、留痕可能失准」，
    // 而不是整个处理器静默失效。
    const exec = execArg && typeof execArg === 'object' && !('name' in execArg) && 'exec' in execArg
      ? execArg.exec
      : execArg;
    void resultArg;

    const toolName = exec?.name ?? '';

    // ---- 1. 计数：每次工具调用都算 ----
    status.record('toolEvents', { tool: toolName });
    touch();

    // ---- 2. 留痕：只写有内容且相关的 ----
    //
    // **判定规则必须与 `90_Agent/hooks/bridge.js:618-627` 完全一致**，
    // 否则插件过滤掉的事件与脚本会留痕的事件出现分歧：
    // - bridge.js 只匹配 `tool_input` 的序列化串（**不含工具名**），
    //   且先 `substring(0, 300)` 截断再匹配。
    // - 此前插件把工具名也拼进匹配串、且用完整序列化串，
    //   导致「工具名含 note 但输入不含关键词」这类事件在两边判定相反。
    // 判定规则必须与 `90_Agent/hooks/bridge.js:618-627` **逐字段一致**，
    // 否则插件过滤掉的事件与脚本会留痕的事件出现分歧：
    // - bridge.js 只匹配 `tool_input` 的序列化串（**不含工具名**），
    //   且先 `substring(0, 300)` 截断再匹配。
    // - 此前插件把工具名也拼进匹配串、且用完整序列化串、且对非对象参数包一层
    //   `{value: ...}`（bridge.js 是 `tool_input || {}`），三处不一致。
    //
    // 这里改为**复用同一套逻辑**：参数缺省 `{}`、序列化后截断 300、只看输入。
    let args = exec?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // 非 JSON 参数按原样传递（与 bridge.js 行为一致：它同样直接 stringify）
      }
    }
    const toolInput = args ?? {};
    const serialized = JSON.stringify(toolInput).substring(0, 300);
    const hasContent = serialized !== '{}' && serialized !== '{"value":""}' && serialized !== '{"value":null}';
    if (!hasContent) return;

    // 与 bridge.js:622-627 相同的词表与匹配方式（只看 tool_input）
    const projectOps = ['project', 'task', 'todo', 'plan', 'roadmap'];
    const memoryOps = ['memory', 'remember', 'recall', 'forget', 'knowledge', 'note'];
    const text = serialized.toLowerCase();
    const isRelevant = [...projectOps, ...memoryOps].some((op) => text.includes(op));
    if (!isRelevant) return;

    runner.bridge('post-tool', { tool_name: toolName, tool_input: toolInput });
  });
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!cfg.enabled.stop || isSubagent(agent)) return;
    runner.bridge('stop', { response: lastAssistantText(agent?.session) });
    status.record('stops');
    touch();
    // 知识条目整理：只在新回合结束后触发，且受最小间隔节流。
    // 这一步此前完全缺失 —— knowledge-engine.js 是独立 CLI，没有任何自动调用方，
    // 所以知识库从不增长（用户实测「数据增长但知识库不增加」）。
    maybeOrganize();
  });

  /**
   * 触发知识条目整理（带节流）。
   *
   * 整理逻辑在 `90_Agent/knowledge-organize.js`，它做了三件原 CLI 没做的事：
   * 游标只处理新增内容、按 contentHash 去重、质量门过滤（跳过 session-start
   * 与 system prompt 泄漏）。
   */
  function maybeOrganize() {
    if (!cfg.organize.enabled) return;
    const now = Date.now();
    if (now - lastOrganizeAt < cfg.organize.minIntervalMs) return;
    lastOrganizeAt = now;

    /**
     * 上报整理失败。
     *
     * **三条失败出口都必须可见** —— 此前 `if (!handle) return;` 与
     * `.catch(() => {})` 把它们全吞了：node 不可解析、`ctx.subprocess.spawn`
     * 抛错、`handle.done` reject。结果是 `organizeRuns`/`organizeFailed`
     * 恒为 0、日志零输出，**整理是否真的在跑无法判断**。
     * 这是「坑 8：静默失败」的同型复发 —— 四个事件处理器走 `fire()`（内部
     * 有 `reportFailure`），唯独这里走 `spawn()`，失败上报能力没上移。
     * @param reason - 失败原因标签。
     * @param detail - 附加诊断文本。
     */
    const fail = (reason, detail) => {
      status.record('organizeFailed', { reason, detail });
      try {
        ctx.logger?.warn?.(`[obsidian-bridge] 知识整理失败 (${reason}): ${detail}`);
      } catch {
        // 日志不可用时，计数器仍然生效
      }
    };

    void (async () => {
      let script;
      try {
        const { scriptPath } = await import('./lib/config.js');
        script = scriptPath(cfg, '90_Agent/knowledge-organize.js');
      } catch (error) {
        fail('resolve-script', String(error?.message ?? error));
        return;
      }

      let handle;
      try {
        handle = await runner.spawn(
          [script, JSON.stringify({ limit: cfg.organize.batchLimit })],
          '',
        );
      } catch (error) {
        fail('spawn-throw', String(error?.message ?? error));
        return;
      }
      if (!handle) {
        // node 可执行文件解析失败，spawn 未返回句柄
        fail('spawn-unavailable', 'node 可执行文件解析失败或 spawn 未返回句柄');
        return;
      }

      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        fail('spawn-error', String(error?.message ?? error));
        return;
      }
      if (outcome?.exitCode === 0) {
        status.record('organizeRuns', { ok: true });
      } else {
        fail(`exit-${outcome?.exitCode ?? -1}`, '');
      }
      touch();
    })().catch((error) => {
      fail('unexpected', String(error?.message ?? error));
    });
  }

  // 启动即构建索引并刷一次快照，让面板立刻显示笔记数与计数。
  //
  // `.catch(() => {})` 与 `.finally()` 的顺序很重要（D11）：
  // `finally` 里的 `touch()` 若抛错，会变成一个**未处理的 rejection**。
  // 这里显式兜底，保证启动路径不会因快照刷新失败而产生噪音。
  ensureIndex()
    .catch((error) => {
      status.record('indexFailed', { reason: `startup: ${error?.message ?? error}` });
    })
    .finally(() => {
      try {
        touch();
      } catch {
        // touch 内部已防错；这里再兜一层，确保不产生 unhandled rejection
      }
    });

  // ---- 启动自检 ----
  //
  // 插件模块在 Host 启动时加载一次，出错往往只在日志里一闪而过。
  // 这里把「本次启动的关键前提」集中打一条 info，重启后一眼就能确认
  // 配置、脚本路径、依赖都正常 —— 比事后翻日志快得多。
  try {
    const probes = [
      `vaultPath=${cfg.vaultPath}`,
      `bridgeScript=${scriptPath(cfg, '90_Agent/hooks/bridge.js')}`,
      `organizeScript=${scriptPath(cfg, '90_Agent/knowledge-organize.js')}`,
      `enabled.prompt=${cfg.enabled.prompt}`,
      `enabled.diagnose=${cfg.enabled.diagnose}`,
      `organize.enabled=${cfg.organize.enabled}`,
      `inject.limit=${cfg.inject.limit}`,
      `hmacSecretEnv=${cfg.hmacSecretEnv}`,
    ];
    ctx.logger?.info?.(`[obsidian-bridge] 启动自检 OK —— ${probes.join(' | ')}`);
  } catch (error) {
    ctx.logger?.warn?.(`[obsidian-bridge] 启动自检失败: ${error?.message ?? error}`);
  }
}
