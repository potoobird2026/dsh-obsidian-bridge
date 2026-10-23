/**
 * Obsidian 桥接的 Client 半边。
 *
 * 在 DSH Web UI 的 Settings 里追加一个「Obsidian 桥接」页面，展示桥接状态。
 * 数据来自 Host 插件注册的 HTTP 路由（同源请求，随浏览器会话携带鉴权）。
 *
 * 该文件是浏览器模块（经 window.__ModuleLoader__ 加载），不是 ESM，
 * 因此不能 import Harness Client 包——React 由浏览器模块表提供。
 */
window.__ModuleLoader__.load({
  id: '@local/obsidian-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    // 取数走 Typert Remote（Client 半边无 fetch 能力）。
    // 原先的 HTTP 状态路由已确认无用并移除，见 index.js 顶部说明。
    const REFRESH_MS = 5000;

    /**
     * 直通 codec：Typert 要求 codec，但这里传输的是普通 JSON。
     * @param typeSymbol - 类型符号。
     */
    const jsonCodec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      description: '任意 JSON 值（直通）',
      create: () => ({}),
      decode: (value) => value,
      encode: (value) => value,
    });

    /** 本包的 Typert Remote 贡献 descriptors（与 Host 清单一致）。 */
    const BRIDGE_REMOTE = Object.freeze({
      package: '@local/obsidian-bridge',
      descriptors: Object.freeze([
        Object.freeze({
          id: '@local/obsidian-bridge#obsidianBridge/status',
          service: 'obsidianBridge',
          namespace: 'obsidianBridge',
          method: 'status',
          invocation: Object.freeze({ kind: 'direct' }),
          parameters: Object.freeze([]),
          result: jsonCodec('@local/obsidian-bridge/types#BridgeStatusSnapshot'),
        }),
        Object.freeze({
          id: '@local/obsidian-bridge#obsidianBridge/refresh',
          service: 'obsidianBridge',
          namespace: 'obsidianBridge',
          method: 'refresh',
          invocation: Object.freeze({ kind: 'direct' }),
          parameters: Object.freeze([]),
          result: jsonCodec('@local/obsidian-bridge/types#BridgeStatusSnapshot'),
        }),
      ]),
    });

    const style = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 16,
        padding: '7px 0',
        borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.25))',
        fontSize: 'var(--dsw-alias-font-size-body, 13px)',
      },
      label: { color: 'var(--dsw-alias-text-secondary, #8a8a8a)' },
      value: { color: 'var(--dsw-alias-text-primary, inherit)', textAlign: 'right', wordBreak: 'break-all' },
      title: {
        fontSize: 'var(--dsw-alias-font-size-title, 15px)',
        fontWeight: 600,
        margin: '4px 0 10px',
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      hint: { color: 'var(--dsw-alias-text-secondary, #8a8a8a)', fontSize: 'var(--dsw-alias-font-size-small, 12px)', marginTop: 12 },
      on: { color: 'var(--dsw-alias-status-success, #2f9e44)' },
      off: { color: 'var(--dsw-alias-text-secondary, #8a8a8a)' },
    };

    function Row({ label, value }) {
      return h('div', { style: style.row },
        h('span', { style: style.label }, label),
        h('span', { style: style.value }, value));
    }

    function Flag({ on }) {
      return h('span', { style: on ? style.on : style.off }, on ? '已启用' : '已停用');
    }

    // Host RPC 句柄，由 apply 注入（Typert Remote 服务）
    let remoteService = null;

    /**
     * 解包 Typert Remote 的调用结果。
     *
     * Remote 方法**不返回原始值**，而是 `{ok:true, value}` 或 `{ok:false, error}`
     * （见 `dsh-api-gateway/lib/client.browser.js:1829-1836`）。直接把包装对象当数据用
     * 会让面板渲染出 `undefined`。官方参照同款解包：
     * `dsh-mcp-panel/lib/client.js:7768-7772`。
     * @param result - Remote 调用返回的包装对象。
     * @param method - 方法名，用于错误信息。
     * @returns 解包后的业务值。
     */
    function unwrap(result, method) {
      if (result === null || result === undefined) {
        throw new Error(`obsidianBridge.${method} 返回空结果`);
      }
      if (result.ok === false) {
        const code = result.error?.code ?? 'unknown';
        const message = result.error?.message ?? String(result.error);
        throw new Error(`obsidianBridge.${method} 失败: ${code}: ${message}`);
      }
      // 兼容未来可能出现的直接返回值
      return result.ok === true ? result.value : result;
    }

    /**
     * 取一次状态快照。
     *
     * Client 半边没有网络能力（DSH 文档："network belongs to the HOST half"，
     * 浏览器半拿不到 fetch），因此走 Typert Remote：apply 里 `ctx.remote.$mount`
     * 挂载本包贡献后，`remote.obsidianBridge.status()` 直达 Host 半边。
     * @returns 状态快照；失败时抛出可读错误。
     */
    async function loadStatus() {
      const service = remoteService;
      if (!service || typeof service.status !== 'function') {
        throw new Error('Typert Remote 未挂载（Host 半边不可达）');
      }
      return unwrap(await service.status(), 'status');
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);

      useEffect(() => {
        let alive = true;
        let logged = false;
        function load() {
          loadStatus()
            .then((data) => {
              if (!alive) return;
              // 解包后必须拿到对象，否则说明 Host 侧返回了非预期结构
              if (data === null || typeof data !== 'object') {
                throw new Error(`快照结构异常: ${JSON.stringify(data)}`);
              }
              setStatus(data);
              setError(null);
              if (!logged) {
                logged = true;
                console.log('[obsidian-bridge] 面板首次取数成功，vaultPath=' + data.vaultPath);
              }
            })
            .catch((err) => {
              if (!alive) return;
              setError(String(err));
              // 只记一次，避免 5 秒轮询刷屏；便于从 DSH 日志定位真实报错
              if (!logged) {
                logged = true;
                console.error('[obsidian-bridge] 面板取数失败: ' + err);
              }
            });
        }
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (error) {
        return h('div', { style: style.wrap },
          h('h3', { style: style.title }, 'Obsidian 桥接'),
          h('div', { style: style.hint }, '暂时无法读取桥接状态：' + error),
          h('div', { style: style.hint },
            '面板通过 Typert Remote 从 Host 取数。若持续不可用，请查看 DSH 日志中的 '
            + '[obsidian-bridge] 行，确认 remote.obsidianBridge 是否就绪。'));
      }

      if (!status) {
        return h('div', { style: style.wrap },
          h('h3', { style: style.title }, 'Obsidian 桥接'),
          h('div', { style: style.hint }, '正在读取桥接状态…'));
      }

      const counters = status.counters ?? {};
      const index = status.index ?? {};
      const last = status.last ?? {};

      return h('div', { style: style.wrap },
        h('h3', { style: style.title }, 'Obsidian 桥接'),

        h('div', { style: style.row },
          h('span', { style: style.label }, 'Vault 路径'),
          h('span', { style: style.value }, status.vaultPath ?? '未知')),

        h('div', { style: style.row },
          h('span', { style: style.label }, '知识索引'),
          h('span', { style: style.value },
            index.ok === false || index.size == null
              ? '尚未构建'
              : index.size + ' 条')),

        h('div', { style: style.row },
          h('span', { style: style.label }, 'MCP 工具'),
          h('span', { style: style.value },
            typeof status.mcpTools === 'number'
              ? (status.mcpTools > 0
                ? 'obsidian-local（' + status.mcpTools + ' 个）'
                : 'obsidian-local（未加载）')
              : '未知（见 MCP 面板）')),

        h('h3', { style: { ...style.title, marginTop: 18 } }, '事件开关'),
        h('div', { style: style.row },
          h('span', { style: style.label }, '用户 prompt（查询注入 + 留痕）'),
          h(Flag, { on: !status.enabled || status.enabled.prompt !== false })),
        h('div', { style: style.row },
          h('span', { style: style.label }, '工具调用（项目/记忆留痕）'),
          h(Flag, { on: !status.enabled || status.enabled.tool !== false })),
        h('div', { style: style.row },
          h('span', { style: style.label }, '回合结束（摘要 + 治理）'),
          h(Flag, { on: !status.enabled || status.enabled.stop !== false })),
        h('div', { style: style.row },
          h('span', { style: style.label }, '会话开始（记忆同步）'),
          h(Flag, { on: !status.enabled || status.enabled.sessionStart !== false })),
        h('div', { style: style.row },
          h('span', { style: style.label }, '知识注入（检索 + 注入上下文）'),
          h(Flag, { on: !status.inject || status.inject.enabled !== false })),

        h('h3', { style: { ...style.title, marginTop: 18 } }, '运行计数'),
        h('div', { style: style.row },
          h('span', { style: style.label }, '用户 prompt'),
          h('span', { style: style.value }, String(counters.prompts ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '产生注入的 prompt'),
          h('span', { style: style.value }, String(counters.injections ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '工具调用事件'),
          h('span', { style: style.value }, String(counters.toolEvents ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '回合结束事件'),
          h('span', { style: style.value }, String(counters.stops ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '记忆同步'),
          h('span', { style: style.value }, String(counters.sessionStarts ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '索引构建次数'),
          h('span', { style: style.value }, String(counters.indexBuilt ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '索引构建失败'),
          h('span', { style: (counters.indexFailed ?? 0) > 0 ? style.off : style.value },
            String(counters.indexFailed ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '写入失败'),
          h('span', { style: (counters.writeFailures ?? 0) > 0 ? style.off : style.value },
            String(counters.writeFailures ?? 0))),
        h('div', { style: style.row },
          h('span', { style: style.label }, '知识整理'),
          h('span', { style: (counters.organizeFailed ?? 0) > 0 ? style.off : style.value },
            String(counters.organizeRuns ?? 0)
              + ((counters.organizeFailed ?? 0) > 0
                ? '（失败 ' + (counters.organizeFailed ?? 0) + '）'
                : ''))),

        h('h3', { style: { ...style.title, marginTop: 18 } }, '最近一次事件'),
        h('div', { style: style.hint },
          '用于诊断：显示每个事件的最后发生时间与关键上下文。'),
        ...Object.keys(last || {}).sort().map((kind) => {
          const item = last[kind] || {};
          const detail = Object.entries(item)
            .filter(([k]) => k !== 'at')
            .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
            .join(' ');
          return h('div', { style: style.row, key: 'last-' + kind },
            h('span', { style: style.label }, kind),
            h('span', { style: style.value },
              String(item.at || '').replace('T', ' ').slice(0, 19) + (detail ? '  ' + detail : '')));
        }),

        h('div', { style: style.hint },
          '每 5 秒自动刷新。写操作经子进程完成，不经过会话沙箱。'));
    }

    async function apply(ctx) {
      console.log('[obsidian-bridge] client half apply() 开始');

      // 挂载本包的 Typert Remote 贡献，让 remote.obsidianBridge 可用
      try {
        if (ctx.remote && typeof ctx.remote.$mount === 'function') {
          await ctx.remote.$mount(BRIDGE_REMOTE);
          console.log('[obsidian-bridge] Typert Remote 已挂载');
        } else {
          console.error('[obsidian-bridge] ctx.remote.$mount 不可用');
        }
      } catch (error) {
        console.error('[obsidian-bridge] Typert Remote 挂载失败: ' + error);
      }

      // 服务就绪后取命名空间（必须用 ctx.inject —— 直接读 ctx.remote.<ns>
      // 会抛 "cannot get property \"remote.obsidianBridge\" without inject"）
      //
      // 注意：ctx.inject 返回的是 **fiber wrapper**（cordis/lib/index.js:1600-1606
      // 经 this.plugin(...) → Object.create(fiber)，只有 .then / .dispose），不是函数。
      // 把它直接传给 ctx.effect 会触发 runner.execute.call 报错（cordis/lib/index.js:1142），
      // 且 disposer 从未注册造成卸载泄漏。正确写法见 dsh-api-remote-access/lib/client.js:666,674-675。
      try {
        const follow = ctx.inject(['remote.obsidianBridge'], (scope) => {
          remoteService = scope.remote.obsidianBridge;
          console.log('[obsidian-bridge] remote.obsidianBridge 已就绪');
        });
        follow.then(() => {
          ctx.effect(() => follow.dispose());
        });
      } catch (error) {
        console.error('[obsidian-bridge] remote 服务读取失败: ' + error);
      }

      try {
        const dispose = ctx.slots.inject('settings.section', () => {
          console.log('[obsidian-bridge] 注册 settings.section');
          return ctx.slots.register({
            name: 'settings.section',
            id: 'obsidian-bridge',
            order: 90,
            label: 'Obsidian 桥接',
          }, Panel);
        });
        console.log('[obsidian-bridge] settings.section 注入完成');
        return dispose;
      } catch (error) {
        console.error('[obsidian-bridge] 注册失败: ' + error);
      }
    }

    exports.apply = apply;
    // `remote` 必须注入，否则 ctx.remote 抛 "cannot get property \"remote\" without inject"
    exports.inject = ['slots', 'remote'];
    exports.name = 'obsidian-bridge';
    return module.exports;
  },
});
