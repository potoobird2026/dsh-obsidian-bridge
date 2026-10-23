import z from '@deepseek-ai/schemastery';

/**
 * Obsidian 桥接插件配置。
 *
 * 所有字段都是必需的；`cordis.patch.yml` 提供完整值，`resolveConfig` 另外给出
 * 防御性回退，避免用户漏填一个字段就导致插件激活失败。
 */
export const Config = z.object({
  /** Obsidian Vault 根目录。 */
  vaultPath: z.string(),
  /** 用于执行桥接脚本的 Node 可执行文件（绝对路径或 PATH 中的裸名）。 */
  nodePath: z.string(),
  /** 读取 HMAC 密钥的环境变量名（FR-5 / PRD Q5）。 */
  hmacSecretEnv: z.string(),
  /** 事件开关。 */
  enabled: z.object({
    prompt: z.boolean(),
    tool: z.boolean(),
    stop: z.boolean(),
    sessionStart: z.boolean(),
    /**
     * 诊断探针开关，**默认关闭**。
     *
     * 它每轮 `agent/pre-step` 都写一条 `bridge-diagnostics.jsonl`，
     * 无界增长（实测已 24 KB）。只是排查工具，需要时再开。
     */
    diagnose: z.boolean(),
  }),
  /** 知识注入（G2）。 */
  inject: z.object({
    enabled: z.boolean(),
    /** 单次注入的最大条目数。 */
    limit: z.number(),
    /** 参与关键词提取的最短词长。 */
    minKeywordLength: z.number(),
  }),
  /**
   * 知识条目整理（v1.0.0 新增）。
   *
   * 把交互日志提炼为结构化知识条目（`30_Resources/{category}/KB-*.md`）。
   * 此前这一步只能手动跑 `knowledge-engine.js organize`，**没有任何自动调用方**，
   * 因此知识库从不增长；且该 CLI 无去重、无游标、无质量门（跑两遍条目翻倍）。
   */
  organize: z.object({
    /** 是否启用自动整理。 */
    enabled: z.boolean(),
    /** 每次整理最多生成多少条目（防单回合写爆）。 */
    batchLimit: z.number(),
    /** 两次整理的最小间隔（毫秒）。 */
    minIntervalMs: z.number(),
  }),
  /**
   * 记忆治理（FR-4）。
   *
   * 治理扫描**不由此插件调度** —— 它由 `90_Agent/hooks/bridge.js` 的
   * `runGovernance()` 在 `stop` 时自行触发（实测日志 59 次 govern 事件）。
   * 原先的 `everyStops` 字段在插件侧从未被读取，属死配置，已移除。
   */
  governance: z.object({
    /** 是否在面板展示治理配置区（仅用于文档化，不影响调度）。 */
    documented: z.boolean(),
  }),
});

export const DEFAULT_VAULT_PATH = 'D:/MyVault';

/** Vault 内参与检索的目录（相对路径）。 */
export const SCAN_ROOTS = ['30_Resources', '10_Projects', '00_InteractionLogs', '00_MOC'];

export const BRIDGE_SCRIPT = '90_Agent/hooks/bridge.js';
export const MEMORY_SYNC_SCRIPT = '90_Agent/memory-sync/sync-workbuddy-memory.js';

/**
 * 合并用户配置与内置默认值。
 * @param config - Loader 传入的原始配置。
 * @returns 解析后的配置对象。
 */
export function resolveConfig(config) {
  const enabled = config?.enabled ?? {};
  const inject = config?.inject ?? {};
  const organize = config?.organize ?? {};
  const governance = config?.governance ?? {};
  return {
    vaultPath: config?.vaultPath || DEFAULT_VAULT_PATH,
    nodePath: config?.nodePath || '',
    hmacSecretEnv: config?.hmacSecretEnv || 'OBSIDIAN_BRIDGE_HMAC_SECRET',
    enabled: {
      prompt: enabled.prompt !== false,
      tool: enabled.tool !== false,
      stop: enabled.stop !== false,
      sessionStart: enabled.sessionStart !== false,
      // 诊断探针默认关闭（D7：无界增长）
      diagnose: enabled.diagnose === true,
    },
    inject: {
      enabled: inject.enabled !== false,
      limit: inject.limit ?? 3,
      minKeywordLength: inject.minKeywordLength ?? 2,
    },
    organize: {
      enabled: organize.enabled !== false,
      batchLimit: organize.batchLimit ?? 20,
      minIntervalMs: organize.minIntervalMs ?? 5 * 60 * 1000,
    },
    governance: {
      documented: governance.documented !== false,
    },
  };
}

/**
 * 解析 Vault 内的脚本绝对路径。
 * @param cfg - 解析后的配置。
 * @param relPath - 相对 Vault 的路径。
 * @returns 绝对路径。
 */
export function scriptPath(cfg, relPath) {
  return `${cfg.vaultPath.replace(/\/+$/, '')}/${relPath}`;
}
