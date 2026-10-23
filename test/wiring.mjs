// 端到端接线测试：用 mock Cordis 上下文加载真实 index.js，直接触发四类事件。
// 运行：把本目录与 lib/、index.js 一起复制到 profile node_modules 下执行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { apply } = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const { createRunner } = await import(pathToFileURL(path.join(ROOT, 'lib/writer.js')).href);
const { resolveConfig, DEFAULT_VAULT_PATH } = await import(pathToFileURL(path.join(ROOT, 'lib/config.js')).href);

// Vault 路径 env 驱动：默认取 config.js 的单一事实来源，可用 OBSIDIAN_VAULT_PATH 覆盖。
const VAULT = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
const NODE = 'node';

const calls = [];
const listeners = {};
const disposers = [];
const routes = [];
// 模拟 webServer 缺席与在场两种情况
const optionalServices = {};
const ctx = {
  on(event, listener) {
    listeners[event] = listener;
  },
  effect(disposer) {
    if (typeof disposer === 'function') disposers.push(disposer);
  },
  get(key) {
    return optionalServices[key];
  },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  fs: {
    async resolve(p) {
      return { targetKey: `k:${p}`, displayPath: p };
    },
    async stat(t) {
      return fs.existsSync(t.displayPath) ? { type: 'directory', size: 0 } : undefined;
    },
    async listDir(t) {
      if (!fs.existsSync(t.displayPath)) return [];
      return fs
        .readdirSync(t.displayPath, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          target: { targetKey: `k:${path.join(t.displayPath, entry.name)}`, displayPath: path.join(t.displayPath, entry.name) },
          size: entry.isFile() ? fs.statSync(path.join(t.displayPath, entry.name)).size : undefined,
        }));
    },
    async readText(t) {
      return fs.readFileSync(t.displayPath, 'utf-8');
    },
  },
  subprocess: {
    async resolveExecutable(cmd) {
      calls.push({ kind: 'resolveExecutable', cmd });
      return NODE;
    },
    spawn(spec) {
      calls.push({
        kind: 'spawn',
        argv: spec.argv,
        stdin: spec.stdio?.stdin,
        env: spec.env,
      });
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {},
      };
    },
  },
};

// 必须把 env 驱动的 VAULT 传进 apply —— 否则 cfg.vaultPath 取的是
// lib/config.js 的默认常量，OBSIDIAN_VAULT_PATH 对本测试毫无作用
// （此前正是如此：默认常量恰好是作者本机的真实 Vault，所以本地一直"通过"）。
apply(ctx, { vaultPath: VAULT });
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ok - ${label}`);
};

const makeUserMessage = (text, sourceKind = 'user') => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: sourceKind },
});
// 写路径是 fire-and-forget 的异步子进程，需要等一个事件循环再断言。
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const makeAgent = () => ({ session: { header: {}, seq: 1, eventAt: () => undefined } });
const baseDecision = (messages) => ({ kind: 'enter', messages });
const next = async (messages) => baseDecision(messages);

// ---------- 1. 用户 prompt：注入 + 留痕 ----------
{
  calls.length = 0;
  const prompt = makeUserMessage('Obsidian 桥接 MCP 的实现方式');
  const decision = await listeners['agent/pre-step'](
    { agent: makeAgent(), messages: [prompt], step: 1, turn: 1, signal: new AbortController().signal },
    async () => baseDecision([prompt]),
  );
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[1].source.kind, 'runtime-context');
  assert.ok(decision.messages[1].content[0].text.includes('知识库相关笔记（自动注入）'));
  ok('agent/pre-step 注入知识上下文');

  await tick();
  const spawnCall = calls.find((c) => c.kind === 'spawn' && c.argv[2] === 'user-prompt');
  assert.ok(spawnCall, '应发起 user-prompt 子进程');
  assert.equal(spawnCall.argv[0], NODE);
  assert.ok(spawnCall.argv[1].endsWith('90_Agent/hooks/bridge.js'));
  assert.equal(spawnCall.argv[2], 'user-prompt');
  const payload = JSON.parse(spawnCall.stdin.data);
  assert.ok(payload.prompt.includes('Obsidian 桥接'));
  assert.ok(payload.injected.includes('知识库相关笔记（自动注入）'));
  ok('user-prompt 事件写入 bridge.js stdin');
}

// ---------- 2. 非第一步：不注入 ----------
{
  calls.length = 0;
  const prompt = makeUserMessage('任意内容');
  const decision = await listeners['agent/pre-step'](
    { agent: makeAgent(), messages: [prompt], step: 2, turn: 1, signal: new AbortController().signal },
    async () => baseDecision([prompt]),
  );
  assert.equal(decision.messages.length, 1);
  assert.equal(calls.filter((c) => c.kind === 'spawn').length, 0);  ok('非第一步不注入、不留痕');
}

// ---------- 3. 末条非真实用户消息：不注入 ----------
{
  calls.length = 0;
  const injected = makeUserMessage('已注入内容', 'runtime-context');
  const decision = await listeners['agent/pre-step'](
    { agent: makeAgent(), messages: [injected], step: 1, turn: 2, signal: new AbortController().signal },
    async () => baseDecision([injected]),
  );
  assert.equal(decision.messages.length, 1);
  ok('末条为注入消息时不重复注入');
}

// ---------- 3b. 真实形状：用户消息 + 末尾追加的上下文消息 ----------
//
// **这是 DSH 的真实形状**：`preStep` 的默认 waterfall 返回
// `{ messages: [...claimed, context] }` —— 运行时上下文消息被追加在**末尾**。
// 此前处理器取 `messages[messages.length - 1]`，拿到的永远是上下文消息
// （`source.kind === 'runtime-context'`），`isRealUserMessage` 恒为 false，
// 于是**整条 prompt 留痕与知识注入链路静默失效**。
// 实测症状：会话开始 / 对话结束都有记录，唯独「用户 prompt:」0 条。
{
  calls.length = 0;
  const prompt = makeUserMessage('Obsidian 桥接的实现方式');
  const context = makeUserMessage('知识库相关笔记（自动注入）', 'runtime-context');
  const decision = await listeners['agent/pre-step'](
    { agent: makeAgent(), messages: [prompt, context], step: 1, turn: 3, signal: new AbortController().signal },
    async () => baseDecision([prompt, context]),
  );
  // 应识别出**用户消息**（跳过末尾的上下文消息）并发起 user-prompt 留痕
  await tick();
  const spawnCall = calls.find((c) => c.kind === 'spawn' && c.argv[2] === 'user-prompt');
  assert.ok(spawnCall, '用户消息在末尾有上下文消息时仍应触发 user-prompt 留痕');
  const payload = JSON.parse(spawnCall.stdin.data);
  assert.ok(payload.prompt.includes('Obsidian 桥接'), `payload.prompt 应为用户原文，实际 ${JSON.stringify(payload.prompt)}`);
  ok('用户消息 + 末尾上下文消息（真实形状）仍正确留痕');
}

// ---------- 4. reject 决策：原样返回 ----------
{
  const decision = await listeners['agent/pre-step'](
    { agent: makeAgent(), messages: [], step: 1, turn: 1, signal: new AbortController().signal },
    async () => ({ kind: 'reject' }),
  );
  assert.equal(decision.kind, 'reject');
  ok('reject 决策原样返回');
}

// ---------- 5. 工具调用结束：post-tool ----------
{
  calls.length = 0;
  // ⚠️ 签名是**位置参数** `(exec, result)`，不是对象 `{ exec }`。
  // 证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502`。
  // 此前按对象形态调用，匹配了错误的处理器签名 → 假阳性：
  // 实际运行时处理器解构 `{ exec }` 得 undefined，恒提前 return，留痕全丢。
  listeners['tools/result'](
    { name: 'write', arguments: { file_path: 'D:/x.md', content: 'project 计划' } },
    {},
  );
  await tick();
  const spawnCall = calls.find((c) => c.kind === 'spawn');
  assert.ok(spawnCall, '应触发一次 post-tool 子进程调用');
  assert.equal(spawnCall.argv[2], 'post-tool');
  const payload = JSON.parse(spawnCall.stdin.data);
  assert.equal(payload.tool_name, 'write');
  assert.ok(payload.tool_input.file_path.includes('D:/x.md'));
  ok('tools/result 触发 post-tool 留痕（真实位置参数签名）');
}

// ---------- 5b. 工具名必须被真实读取（签名回归守卫） ----------
{
  const { getSnapshot } = await import(
    pathToFileURL(path.join(ROOT, 'lib/status-store.js')).href
  );
  const snap = getSnapshot();
  assert.equal(
    snap?.last?.toolEvents?.tool,
    'write',
    'toolEvents 的 last.tool 必须是真实工具名；若为空串说明处理器签名又不匹配了',
  );
  ok('toolEvents 记录了真实工具名（防止签名回归）');
}

// ---------- 6. 回合结束：stop ----------
{
  calls.length = 0;
  listeners['agent/turn-stopping']({ agent: makeAgent(), turn: 1 });
  await tick();
  const spawnCall = calls.find((c) => c.kind === 'spawn');
  assert.ok(spawnCall);
  assert.equal(spawnCall.argv[2], 'stop');
  ok('agent/turn-stopping 触发 stop 留痕');
}

// ---------- 7. 会话开始：session-start + 记忆同步 ----------
{
  calls.length = 0;
  listeners['agent/created']({ agent: makeAgent() });
  await tick();
  const events = calls.filter((c) => c.kind === 'spawn').map((c) => c.argv[2]);
  assert.ok(events.includes('session-start'));
  const syncCall = calls.find((c) => c.kind === 'spawn' && String(c.argv[1]).includes('sync-workbuddy-memory.js'));
  assert.ok(syncCall, '应触发记忆同步脚本');
  assert.ok(syncCall.argv.includes('--vault-path'));
  ok('agent/created 触发 session-start 与记忆同步');
}

// ---------- 8. 子代理：会话开始被跳过（避免与父会话重复） ----------
{
  calls.length = 0;
  listeners['agent/created']({ agent: { session: { header: { origin: 'subagent', delegationDepth: 1 } } } });
  assert.equal(calls.filter((c) => c.kind === 'spawn').length, 0);
  ok('子代理的 agent/created 被跳过');
}

// ---------- 10. HTTP 状态路由已移除（因果查询确认无用） ----------
{
  // v1.0.0 曾注册 GET /obsidian-bridge/status，但代码内 0 消费者：
  // Client 半边无 fetch，外部 curl 被启动令牌围栏挡在 403。
  // 本测试锁定「移除是有意的」，防止后续误加回来。
  optionalServices.webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const fresh = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?route=1');
  fresh.apply(ctx, { vaultPath: VAULT });
  assert.equal(routes.length, 0, '不应再注册 HTTP 状态路由');

  // 且不应再依赖 webServer
  assert.ok(
    !fresh.inject.includes('webServer'),
    'inject 不应包含 webServer（路由已移除，依赖应同步清除）',
  );
  assert.equal(fresh.STATUS_ROUTE, undefined, 'STATUS_ROUTE 导出应已移除');

  ok('HTTP 状态路由与 webServer 依赖已移除');
}

// ---------- 12. runner 必须导出 spawn（organize 接线的前提） ----------
//
// P0 回归：`maybeOrganize()` 调用 `runner.spawn(...)`，但 createRunner() 的
// return 块里没有它 → 运行期抛 `TypeError` → 被 `.catch(() => {})` 吞掉 →
// **知识整理静默从未运行**（游标文件始终不生成、organizeRuns 恒为 0）。
// 本测试直接核对导出表，防止同类「调用了未导出的方法」再次发生。
{
  const runner = createRunner(ctx, resolveConfig({ vaultPath: VAULT, nodePath: NODE }));
  const required = ['bridge', 'memorySync', 'spawn'];
  for (const name of required) {
    assert.equal(
      typeof runner[name],
      'function',
      `createRunner() 必须导出 ${name}() —— ` +
      `缺少它会让调用方静默失败（异常被 catch 吞掉，日志零输出）`,
    );
  }
  ok('createRunner 导出 bridge / memorySync / spawn（organize 接线前提）');
}

console.log(`\n接线测试全部通过：${passed} 项`);