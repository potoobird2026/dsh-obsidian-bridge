/**
 * 桥接运行状态与计数。
 *
 * Host 侧累计，通过 Typert Remote 暴露给 Client 面板；写操作全部经由
 * `ctx.subprocess` 完成，这里的计数只反映插件自身的调度行为。
 *
 * **每个计数器都必须显式声明**：此前 `indexBuilt` 未声明，靠 `record()` 的
 * `?? 0` 动态创建，导致启动时快照 7 键、首次构建后 8 键，结构不稳定。
 */

/**
 * 计数器的完整键集与语义。新增计数器必须同时加进 `createStatus()`。
 *
 * | 键 | 语义 |
 * |---|---|
 * | `prompts` | 进入 `agent/pre-step` 并通过闸门的真实用户消息数 |
 * | `injections` | **产生了注入的 prompt 次数**（不是注入条目数，条目数见 `last.injections.entries`） |
 * | `toolEvents` | 工具调用次数（**全部**，不受留痕降噪影响） |
 * | `stops` | 回合结束次数 |
 * | `sessionStarts` | 会话开始次数（不含子代理） |
 * | `writeFailures` | Vault 写入失败次数（子进程启动失败/非零退出） |
 * | `indexBuilt` | 索引**成功**重建次数（TTL 过期或显式 refresh） |
 * | `indexFailed` | 索引重建**失败**次数（一个根目录都没扫到，或扫描抛错） |
 */
export const COUNTER_KEYS = [
  'prompts',
  'injections',
  'toolEvents',
  'stops',
  'sessionStarts',
  'writeFailures',
  'indexBuilt',
  'indexFailed',
  'organizeRuns',
  'organizeFailed',
];

/**
 * 已废弃的计数器键。保留常量是为了让「为什么没有它」可被检索到。
 *
 * `governanceRuns` —— 曾在 v1.0.0 前声明，但插件侧从未 `+1`：
 * 治理扫描实际由 `90_Agent/hooks/bridge.js` 的 `runGovernance()` 在 `stop`
 * 时自行触发（实测日志 59 次 govern 事件），插件不参与调度。
 * 配套的 `cfg.governance.everyStops` 同为死配置，已一并移除。
 */
export const REMOVED_COUNTER_KEYS = ['governanceRuns'];

/** 创建一份空的状态表。 */
export function createStatus() {
  const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
  const last = {};
  return {
    counters,
    last,
    /**
     * 记录一次事件。
     * @param kind - 事件名，必须是 `COUNTER_KEYS` 之一。
     * @param extra - 附加上下文。
     */
    record(kind, extra = {}) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      last[kind] = { at: new Date().toISOString(), ...extra };
    },
  };
}

/**
 * 组装给 Client 面板的快照。
 * @param cfg - 解析后的配置。
 * @param status - `createStatus` 的状态表。
 * @param indexInfo - 索引信息 `{ size, builtAt }`。
 * @param extras - 额外字段。
 * @returns 可 JSON 序列化的快照。
 */
export function buildSnapshot(cfg, status, indexInfo, extras = {}) {
  return {
    vaultPath: cfg.vaultPath,
    enabled: cfg.enabled,
    inject: cfg.inject,
    governance: cfg.governance,
    index: indexInfo,
    counters: status.counters,
    last: status.last,
    ...extras,
  };
}
