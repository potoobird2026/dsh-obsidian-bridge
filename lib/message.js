import { randomUUID } from 'node:crypto';

/**
 * 递归冻结一个值，等价于 `@deepseek-ai/dsh-llm` 的 `deepFreeze`。
 * 该包在 npm 上只有过期的 `0.0.1-rc.1`，Harness 用的是 `0.2.1-rc.2`，
 * 因此这里不引入它，改为本地构造等价的不可变消息。
 * @param value - 任意值。
 * @returns 同一个已冻结的值。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** 本插件注入消息使用的运行时上下文来源名。 */
export const INJECTION_SOURCE_NAME = 'obsidian-knowledge';

/**
 * 构造一条注入用用户消息。
 *
 * 形状与 `createUserMessage` 一致：`{ id, role, content, source }`，
 * `source.kind` 取 `'runtime-context'`，`form` 取 `'snapshot'`，
 * 因此它不会被后续的 `source.kind === 'user'` 判定误认为真实用户输入。
 * @param text - 注入的正文。
 * @param entryCount - 注入条目数，写入 sections 便于审计。
 * @returns 已冻结的用户消息。
 */
export function createInjectedUserMessage(text, entryCount) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: INJECTION_SOURCE_NAME, text, entryCount }],
    },
  });
}

/**
 * 从一条消息中提取纯文本。
 * @param message - 任意消息。
 * @returns 拼接后的文本，无文本块时为空串。
 */
export function messageText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 判断一条消息是否是真实的用户输入。
 *
 * 插件自身注入的消息来源是 `runtime-context`，其他插件的注入各有来源，
 * 因此只有 `source.kind === 'user'` 才视为本轮的用户 prompt。
 * @param message - 待判断的消息。
 * @returns 是否为真实用户输入。
 */
export function isRealUserMessage(message) {
  return Boolean(message && message.role === 'user' && message.source && message.source.kind === 'user');
}

/**
 * 判断一个 Agent 是否为子代理（子代理不参与留痕，避免与父会话重复）。
 * @param agent - Agent 对象。
 * @returns 是否为子代理。
 */
export function isSubagent(agent) {
  const header = agent?.session?.header;
  if (!header) return false;
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
}
