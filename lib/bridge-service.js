/**
 * Obsidian 桥接的 Typert Remote 服务挂载。
 *
 * Typert Gateway 的 strict 分发**不读** invocation 描述符里的 `invoke`，而是：
 *   `ctx.get(descriptor.service)` → 校验 `typertRemote` 绑定 → `Reflect.get(receiver, method)`
 * 因此 Host 侧必须提供一个真实的 Cordis Service，否则网关抛
 * `gateway/service-unavailable`（实测：`ctx.get('obsidianBridge')` 返回 undefined）。
 *
 * 实现方式与官方 bundle `dsh-mcp-panel` 一致：
 * `class McpPanelService extends TypertRemoteService` + `ctx.plugin(McpPanelService)`。
 *
 * 证据：`dsh-api-gateway/lib/index.js:1224-1229`、`:1191-1194`、`:1698-1706`；
 *       `dsh-typert-protocol/lib/index.js:326-352`（bindTypertRemote）；
 *       `dsh-mcp-panel/lib/index.js:2399-2425`、`:2896`。
 *
 * **为什么用动态导入**：`@deepseek-ai/dsh-typert-protocol` 不在 profile 的
 * `node_modules` 里（实测 `ERR_MODULE_NOT_FOUND`），但官方 bundle 能解析它，
 * 说明 Host 会回退到安装目录。这里动态导入 + 失败降级，保证**即使服务挂载失败，
 * 核心桥接功能（G1/G2 留痕与注入）也不受影响**。
 */
import { getSnapshot, refreshSnapshot } from './status-store.js';

/** 服务名，必须与 `typert.host.js` 里 invocation 的 `service` / `namespace` 一致。 */
export const BRIDGE_SERVICE_KEY = 'obsidianBridge';

/**
 * 挂载 Typert Remote 服务。
 * @param ctx - Cordis 上下文。
 * @returns 是否挂载成功。
 */
export async function mountBridgeService(ctx) {
  try {
    const { TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol');
    if (typeof TypertRemoteService !== 'function') {
      ctx.logger?.warn?.('obsidian-bridge: TypertRemoteService 不是函数，服务未挂载');
      return false;
    }

    class ObsidianBridgeService extends TypertRemoteService {
      constructor(context) {
        super(context, BRIDGE_SERVICE_KEY);      }

      /** 读取当前状态快照。 */
      async status() {
        return getSnapshot();
      }

      /** 强制重建索引后返回最新快照。 */
      async refresh() {
        return refreshSnapshot();
      }
    }

    await ctx.plugin(ObsidianBridgeService);
    ctx.logger?.info?.('obsidian-bridge: Typert Remote 服务已挂载 (obsidianBridge)');
    return true;
  } catch (error) {
    // 服务挂载失败不影响核心功能；面板会显示不可用提示
    ctx.logger?.warn?.(
      `obsidian-bridge: Typert Remote 服务挂载失败 — ${error?.message ?? error}`,
    );
    return false;
  }
}
