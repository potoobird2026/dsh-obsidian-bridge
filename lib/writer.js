import { BRIDGE_SCRIPT, MEMORY_SYNC_SCRIPT, scriptPath } from './config.js';

/** 子进程终止宽限期。 */
const GRACE_MS = 8000;
/** 收集输出的上限，仅用于诊断。 */
const OUTPUT_MAX_BYTES = 8192;

/**
 * 构造一个脚本执行器。
 *
 * 所有对 Vault 的写操作都通过 `ctx.subprocess` 交给现有脚本完成：
 * `@deepseek-ai/dsh-fs-sandbox` 会按会话 sandbox 模式围栏 `ctx.fs` 的写操作，
 * 而子进程缝不被 sandbox 消费层围栏，因此这是唯一可靠的写路径。
 * @param ctx - 插件上下文。
 * @param cfg - 解析后的配置。
 * @param onWriteFailure - 写入失败回调（可选）。用于把失败计入 `writeFailures`
 *   计数器 —— 此前失败只写 debug 日志，面板上完全看不到，属于静默失败。
 * @returns 脚本执行器。
 */
export function createRunner(ctx, cfg, onWriteFailure) {
  /**
   * 解析 Node 可执行文件路径。
   * @returns 绝对路径，解析失败时为 null。
   */
  async function resolveNode() {
    const candidate = cfg.nodePath || 'node';
    try {
      return await ctx.subprocess.resolveExecutable(candidate);
    } catch {
      // 配置路径不可用时退回 PATH 中的 node
      if (candidate !== 'node') {
        try {
          return await ctx.subprocess.resolveExecutable('node');
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * 启动一次脚本调用。
   * @param args - 脚本参数（不含可执行文件）。
   * @param stdinData - 写入 stdin 的文本。
   * @returns 子进程句柄的 Promise，失败时为 null。
   */
  async function spawn(args, stdinData) {
    const executable = await resolveNode();
    if (!executable) return null;
    try {
      return ctx.subprocess.spawn({
        argv: [executable, ...args],
        cwd: cfg.vaultPath,
        stdio: {
          stdin: stdinData ? { data: stdinData } : 'ignore',
          stdout: { maxBytes: OUTPUT_MAX_BYTES },
          stderr: { maxBytes: OUTPUT_MAX_BYTES },
        },
        graceMs: GRACE_MS,
        // 子进程环境在父环境基础上叠加（provider 内部合并），无需复制整份 process.env
        env: buildEnv(cfg),
      });
    } catch {
      return null;
    }
  }

  /**
   * 组装子进程环境变量。
   *
   * **必须显式传递 HMAC 密钥** —— `90_Agent/hooks/bridge.js` 用它做交叉认证签名。
   * 此前只传 `OBSIDIAN_VAULT_PATH`，`cfg.hmacSecretEnv` 全仓零消费者，
   * 子进程读不到密钥就静默回落到**硬编码的公开默认值**，
   * 签名等于没有保护（任何人都知道那个密钥）。
   * @param cfg - 解析后的配置。
   * @returns 传给子进程的环境变量对象。
   */
  function buildEnv(cfg) {
    const env = { OBSIDIAN_VAULT_PATH: cfg.vaultPath };
    // hmacSecretEnv 是「环境变量名」，值从宿主进程的 env 里取
    const name = cfg.hmacSecretEnv;
    if (name) {
      const secret = process.env[name];
      if (secret) env[name] = secret;
    }
    return env;
  }

  /**
   * 启动并忽略结果的脚本调用。
   * @param args - 脚本参数。
   * @param stdinData - 写入 stdin 的文本。
   */
  /**
   * 统一的失败上报：计数 + 日志。
   *
   * **四个分支都必须走这里** —— 此前只有 `exit-N` 写了 warn，另三条
   * （`spawn-unavailable` / `spawn-error` / `spawn-throw`）只加计数，
   * 日志零输出，排查时完全看不到（静默失败）。
   * @param reason - 失败原因标签。
   * @param detail - 附加诊断文本。
   * @param args - 本次调用的参数（用于定位是哪个脚本）。
   */
  function reportFailure(reason, detail, args) {
    onWriteFailure?.({ reason, detail, args });
    try {
      ctx.logger?.warn?.(
        `[obsidian-bridge] 写入失败 (${reason}): ${args.join(' ')}${detail ? ' — ' + detail : ''}`,
      );
    } catch {
      // 日志不可用时静默（此时计数仍然生效）
    }
  }

  /**
   * 启动并忽略结果的脚本调用。
   * @param args - 脚本参数。
   * @param stdinData - 写入 stdin 的文本。
   */
  function fire(args, stdinData) {
    void spawn(args, stdinData)
      .then((handle) => {
        if (!handle) {
          // 连子进程都没起来（nodePath 不可解析等）
          reportFailure('spawn-unavailable', 'node 可执行文件解析失败或 spawn 未返回句柄', args);
          return;
        }
        void handle.done.then(
          (outcome) => {
            if (outcome.exitCode === 0) return;
            let stderr = '';
            try {
              stderr = handle.collected.stderr?.readFrom(0)?.text ?? '';
            } catch {
              // 读 stderr 失败不应影响失败上报本身（D14）
            }
            reportFailure(`exit-${outcome.exitCode}`, stderr.slice(0, 400), args);
          },
          (error) => {
            // done 被 reject（脚本失败不阻断对话）
            reportFailure('spawn-error', String(error), args);
          },
        );
      })
      .catch((error) => {
        // spawn 本身抛错（启动失败不阻断对话）
        reportFailure('spawn-throw', String(error), args);
      });
  }

  const bridgeScript = scriptPath(cfg, BRIDGE_SCRIPT);
  const memorySyncScript = scriptPath(cfg, MEMORY_SYNC_SCRIPT);

  return {
    /** 触发一次桥接事件。 @param event - 事件名。 @param payload - 写入 stdin 的 JSON。 */
    bridge(event, payload) {
      fire([bridgeScript, event], payload === undefined ? '' : JSON.stringify(payload));
    },
    /** 执行记忆同步。 */
    memorySync() {
      fire([memorySyncScript, '--vault-path', cfg.vaultPath], '');
    },
    /**
     * 执行任意 Vault 脚本并返回子进程句柄。
     *
     * **必须暴露这个方法** —— 此前 `maybeOrganize()` 调用 `runner.spawn(...)`
     * 但 return 块里没有它，运行期抛 `TypeError: runner.spawn is not a function`，
     * 又被 `.catch(() => {})` 吞掉，导致知识整理**静默从未运行**
     * （游标文件始终不生成、organizeRuns 恒为 0）。
     * 教训：新增对 runner 的调用时，必须核对它真的被导出了。
     * @param args - 脚本参数（不含可执行文件）。
     * @param stdinData - 写入 stdin 的文本。
     * @returns 子进程句柄的 Promise，失败时为 null。
     */
    spawn(args, stdinData) {
      return spawn(args, stdinData);
    },
  };
}
