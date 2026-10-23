/**
 * Obsidian 桥接的 Typert HOST 清单，经 `./typert` 导出。
 *
 * Client 半边没有网络能力（DSH 文档："network belongs to the HOST half"），
 * 因此面板取数走 Typert Remote：Client `ctx.remote.$mount` 挂载本清单的
 * descriptors，再调 `ctx.remote.obsidianBridge.status()`。
 *
 * 实现不在清单里 —— 清单只声明 invocation；`invoke` 从共享存储读取，
 * 由 `index.js` 在运行时写入（见 lib/status-store.js）。
 *
 * @module @local/obsidian-bridge/typert
 */

import { getSnapshot, refreshSnapshot } from './lib/status-store.js';

/**
 * 直通 codec：Typert 要求 strict codec，但这里传输的是普通 JSON。
 * @param typeSymbol - 类型符号。
 * @returns 满足 loader 校验的 codec 对象。
 */
const jsonCodec = (typeSymbol) => ({
  mode: 'strict',
  typeSymbol,
  description: '任意 JSON 值（直通）',
  create: () => ({}),
  decode: (value) => value,
  encode: (value) => value,
});

/**
 * 状态读取 invocation。
 * @type {Readonly<object>}
 */
const STATUS_INVOCATION = Object.freeze({
  id: '@local/obsidian-bridge#obsidianBridge/status',
  service: 'obsidianBridge',
  namespace: 'obsidianBridge',
  method: 'status',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([]),
  result: jsonCodec('@local/obsidian-bridge/types#BridgeStatusSnapshot'),
  input: () => ({}),
  invoke: async () => getSnapshot(),
  sourceLocation: Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 }),
});

/**
 * 强制重建索引后返回快照。
 * @type {Readonly<object>}
 */
const REFRESH_INVOCATION = Object.freeze({
  id: '@local/obsidian-bridge#obsidianBridge/refresh',
  service: 'obsidianBridge',
  namespace: 'obsidianBridge',
  method: 'refresh',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([]),
  result: jsonCodec('@local/obsidian-bridge/types#BridgeStatusSnapshot'),
  input: () => ({}),
  invoke: async () => refreshSnapshot(),
  sourceLocation: Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 }),
});

/** Host Typert 清单（由 `@deepseek-ai/dsh-typert-loader` 校验）。 */
const TYPERT = Object.freeze({
  package: '@local/obsidian-bridge',
  face: 'host',
  schemas: Object.freeze([]),
  invocations: Object.freeze([STATUS_INVOCATION, REFRESH_INVOCATION]),
  model: Object.freeze({
    services: Object.freeze([]),
    events: Object.freeze([]),
    objects: Object.freeze([]),
  }),
});

export { TYPERT };
