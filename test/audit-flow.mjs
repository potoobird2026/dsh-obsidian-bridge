/**
 * 四条事件链路的控制流审计（守卫顺序 / 副作用可见性 / 静默失败 / 状态泄漏）。
 *
 * 与 `audit-counters.mjs` 的分工：
 *   - `audit-counters.mjs` 断言「计数器的值是否符合其定义」；
 *   - 本脚本断言「每个守卫命中时，哪些副作用被跳过 / 哪些仍然发生」，
 *     以及 writer 四个失败分支的**可达性**、`ensureIndex` 的失败语义与重建语义、
 *     `refreshSnapshot` 的快照新鲜度、以及事件框架的异常吞噬边界。
 *
 * 结论分三态：
 *   OK   —— 实际行为与「意图」一致
 *   BUG  —— 实际行为与意图不符（写入 findings 的问题清单）
 *   INFO —— 无法判定对错，仅记录事实
 *
 * 运行：node test/audit-flow.mjs [--json]
 *       （脚本会自行把 lib/ + index.js stage 到 profile node_modules 下以解析
 *        @deepseek-ai/schemastery，跑完清理；不修改任何插件源码）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
import { resolveStaging } from './lib-staging.mjs';

// ============================================================
// 0. 结果收集
// ============================================================
const results = [];
/**
 * 记录一条审计结论。
 * @param {string} id @param {string} title @param {string} intent @param {string} actual
 * @param {boolean|'warn'} [isBug] false=OK，true=BUG，'warn'=语义不一致（需产品决策）
 */
function report(id, title, intent, actual, isBug) {
  const status = isBug === undefined ? 'INFO' : isBug === 'warn' ? 'WARN' : isBug ? 'BUG' : 'OK';
  results.push({ id, title, intent, actual, status });
}

// ============================================================
// 1. 临时 Vault
// ============================================================
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-flow-'));
const writeNote = (rel, body) => {
  const full = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
};
const note = (title, extra = '') =>
  `---\ntitle: ${title}\nsummary: ${title}\ncategory: experience\n---\n\n${title} ${extra}\n`;

// ============================================================
// 2. 加载真实 index.js（stage 到**仓库的** node_modules）
// ============================================================
// 同 audit-counters.mjs：不能用 DSH profile —— GitHub runner 镜像里那个目录
// 没有 schemastery，CI 上必然 ERR_MODULE_NOT_FOUND。
const STAGING = resolveStaging('audit-flow');
if (!STAGING) {
  console.error(
    '❌ 无法解析 @deepseek-ai/schemastery：仓库没有 node_modules。\n' +
      '   请先跑 `npm install`（CI 里对应 workflow 的「安装依赖」步骤）。',
  );
  process.exit(1);
}
const STORE_URL = pathToFileURL(path.join(STAGING, 'lib/status-store.js')).href;

let indexModule;
let store;
try {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(STAGING, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(STAGING, 'index.js'));
  indexModule = await import(pathToFileURL(path.join(STAGING, 'index.js')).href);
  store = await import(STORE_URL);
} finally {
  fs.rmSync(STAGING, { recursive: true, force: true });
}
const { getSnapshot, refreshSnapshot } = store;

// ============================================================
// 3. mock ctx 工厂
// ============================================================
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const fsTarget = (p) => ({ targetKey: `k:${p}`, displayPath: p });

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeCtx(options = {}) {
  const listeners = {};
  const spawnCalls = [];
  const warnings = [];
  const ctx = {
    listeners,
    spawnCalls,
    warnings,
    listDirCalls: 0,
    on(event, listener) {
      listeners[event] = listener;
    },
    effect() {},
    plugin() {
      return Promise.resolve();
    },
    logger: {
      debug() {},
      info() {},
      warn(...a) {
        warnings.push(a.join(' '));
      },
      error(...a) {
        warnings.push(a.join(' '));
      },
    },
    fs: {
      async resolve(p) {
        if (options.resolveThrows) throw new Error('fs.resolve unavailable');
        return fsTarget(p);
      },
      async stat(t) {
        if (!fs.existsSync(t.displayPath)) return undefined;
        const st = fs.statSync(t.displayPath);
        return { type: st.isDirectory() ? 'directory' : 'file', size: st.size };
      },
      async listDir(t) {
        ctx.listDirCalls += 1;
        if (options.listDirGate) return options.listDirGate(t);
        if (!fs.existsSync(t.displayPath)) return [];
        return fs.readdirSync(t.displayPath, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target: fsTarget(path.join(t.displayPath, e.name)),
          size: e.isFile() ? fs.statSync(path.join(t.displayPath, e.name)).size : undefined,
        }));
      },
      async readText(t) {
        return fs.readFileSync(t.displayPath, 'utf-8');
      },
    },
    subprocess: {
      async resolveExecutable() {
        if (options.nodeUnavailable) throw new Error('no node');
        return NODE;
      },
      async spawn(spec) {
        spawnCalls.push({ argv: spec.argv, stdin: spec.stdio?.stdin?.data });
        const behaviour = options.spawnBehaviour ?? { kind: 'ok' };
        if (behaviour.kind === 'throw') return Promise.reject(new Error('spawn boom'));
        if (behaviour.kind === 'nonzero') {
          return {
            done: Promise.resolve({ exitCode: behaviour.exitCode ?? 1 }),
            collected: { stderr: { readFrom: () => ({ text: behaviour.stderr ?? 'fail' }) } },
          };
        }
        if (behaviour.kind === 'reject') {
          return { done: Promise.reject(new Error('done boom')), collected: {} };
        }
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stderr: { readFrom: () => ({ text: '' }) } },
        };
      },
    },
  };
  return ctx;
}

const baseConfig = (extra = {}) => ({
  vaultPath: VAULT,
  nodePath: NODE,
  hmacSecretEnv: 'OBSIDIAN_BRIDGE_HMAC_SECRET',
  enabled: { prompt: true, tool: true, stop: true, sessionStart: true },
  inject: { enabled: true, limit: 3, minKeywordLength: 2 },
  governance: { everyStops: 10 },
  ...extra,
});

const userMessage = (text, sourceKind = 'user') => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: sourceKind },
});
const decision = (messages) => ({ kind: 'enter', messages });
const ABORT = new AbortController().signal;
const AGENT = (header = {}) => ({ session: { header, seq: 1, eventAt: () => undefined } });

/** 启动插件并等待初始扫描结束，返回「已稳定」的基线。 */
async function boot(config, options) {
  const ctx = makeCtx(options);
  indexModule.apply(ctx, config);
  await tick(120);
  ctx.warnings.length = 0; // 丢弃 mountBridgeService 的降级告警
  ctx.spawnCalls.length = 0;
  return ctx;
}

async function firePrompt(ctx, text, { step = 1, turn = 1, signal = ABORT } = {}) {
  return ctx.listeners['agent/pre-step'](
    { agent: AGENT(), messages: [userMessage(text)], step, turn, signal },
    async () => decision([userMessage(text)]),
  );
}

const counters = () => ({ ...(getSnapshot()?.counters ?? {}) });
const delta = (before, after) => {
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) out[key] = `${before[key]}→${after[key]}`;
  }
  return out;
};
// writer.fire() 走子进程，事件名在 argv[2]；记忆同步脚本在 argv[1]
const bridgesOf = (ctx, event) => ctx.spawnCalls.filter((c) => c.argv[2] === event);
const memorySyncs = (ctx) =>
  ctx.spawnCalls.filter((c) => String(c.argv[1] ?? '').includes('sync-workbuddy-memory.js'));
const spawnEvents = (ctx) => ctx.spawnCalls.map((c) => `${path.basename(String(c.argv[1] ?? ''))} ${c.argv[2] ?? ''}`.trim());

/**
 * 按**真实派发形态**触发 `tools/result`。
 *
 * `tools/result` 是普通 emit，`dsh-tools/lib/index.js:3518` 调 `callback(exec, result)`
 * —— 两个**位置参数**，不是对象载荷。此前本脚本传 `{ exec }`，恰好绕过了
 * 「解构位置参数」这个坑，属于测试装置错误，已修正。
 * 证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502` 的签名。
 */
const fireTool = (ctx, exec, result) => ctx.listeners['tools/result'](exec, result);

// ============================================================
// A. 守卫顺序 × 副作用矩阵
// ============================================================
console.log('\n=== A. 守卫顺序 × 副作用矩阵 ===');
{
  const cases = [
    ['父会话 + 开关开', baseConfig(), {}, { sessionStarts: 1, memory: 1, sessionStart: 1 }],
    ['enabled.sessionStart=false', baseConfig({ enabled: { sessionStart: false } }), {}, { sessionStarts: 0, memory: 0, sessionStart: 0 }],
    ['子代理 (origin=subagent)', baseConfig(), {}, { sessionStarts: 0, memory: 0, sessionStart: 0 }],
  ];
  for (const [label, config, opts, expect] of cases) {
    const ctx = await boot(config, opts);
    const before = counters();
    const header = label.startsWith('子代理') ? { origin: 'subagent', delegationDepth: 1 } : {};
    ctx.listeners['agent/created']({ agent: AGENT(header) });
    await tick();
    const after = counters();
    const actual = {
      sessionStarts: after.sessionStarts - before.sessionStarts,
      memory: memorySyncs(ctx).length,
      sessionStart: bridgesOf(ctx, 'session-start').length,
    };
    report(
      `A1 ${label}`,
      'agent/created：守卫在计数之前（index.js:187 → :190）',
      `期望增量 ${JSON.stringify(expect)}`,
      `实际增量 ${JSON.stringify(actual)}`,
      actual.sessionStarts !== expect.sessionStarts
      || actual.memory !== expect.memory
      || actual.sessionStart !== expect.sessionStart,
    );
  }
}
{
  const ctx = await boot(baseConfig({ enabled: { stop: false } }));
  const before = counters();
  ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  await tick();
  const after = counters();
  report(
    'A2 enabled.stop=false',
    'agent/turn-stopping：守卫在计数之前（index.js:294 → :296）',
    '若与 tools/result 的语义一致（计数 = 发生过多少次），应仍 +1；否则应写明计数被开关门控',
    `stops 增量=${after.stops - before.stops}, bridge(stop)=${bridgesOf(ctx, 'stop').length}`,
    'warn',
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  ctx.listeners['agent/turn-stopping']({ agent: AGENT({ origin: 'subagent' }) });
  await tick();
  const after = counters();
  report(
    'A3 子代理 stop',
    'agent/turn-stopping：isSubagent 守卫',
    '子代理不计数',
    `stops 增量=${after.stops - before.stops}`,
    after.stops - before.stops !== 0,
  );
}
{
  // enabled.prompt=false：当前实现在 :270 提前 return，注入也不发生
  writeNote('30_Resources/experience/KB-A.md', note('MCP 桥接'));
  const ctx = await boot(baseConfig({ enabled: { prompt: false } }));
  const before = counters();
  const out = await firePrompt(ctx, 'MCP 桥接 实现');
  const after = counters();
  const injected = out.messages.length > 1;
  report(
    'A4 enabled.prompt=false 且注入会命中',
    'agent/pre-step：开关在注入之前 return（index.js:270）',
    '开关关闭 → 既不注入也不计数',
    `injected=${injected}, 增量=${JSON.stringify(delta(before, after))}`,
    injected || Object.keys(delta(before, after)).length !== 0,
  );
}
{
  // 新守卫顺序问题：留痕了但没注入 → touch() 被跳过
  writeNote('30_Resources/experience/KB-A2.md', note('完全不相关的词'));
  const ctx = await boot(baseConfig());
  const before = counters();
  const snapBefore = getSnapshot();
  await firePrompt(ctx, '完全不相关的词');
  const after = counters();
  const snapAfter = getSnapshot();
  report(
    'A11 留痕但未注入时跳过 touch()',
    'agent/pre-step：touch() 被放进 `if (injectedText)`（index.js:274-277）',
    '计数器已 +1，面板应能看到；index.size/builtAt 应刷新',
    `prompts 增量=${after.prompts - before.prompts}；快照 counters.prompts=${snapAfter?.counters?.prompts}（counters 对象是否共享=${snapBefore?.counters === snapAfter?.counters}）；index.builtAt 变化=${snapBefore?.index?.builtAt !== snapAfter?.index?.builtAt}`,
    false,
  );
}
{
  const ctx = await boot(baseConfig({ inject: { enabled: false } }));
  writeNote('30_Resources/experience/KB-B.md', note('MCP 桥接'));
  const out = await firePrompt(ctx, 'MCP 桥接 实现');
  report(
    'A5 inject.enabled=false',
    'agent/pre-step：注入关闭',
    '无注入 → injections 不变',
    `injected=${out.messages.length > 1}, injections=${counters().injections}`,
    out.messages.length > 1,
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  await firePrompt(ctx, 'MCP 桥接', { step: 2 });
  const after = counters();
  report(
    'A6 step=2',
    'agent/pre-step：step!==1 守卫（index.js:201）',
    'step=2 不应产生任何副作用',
    `增量=${JSON.stringify(delta(before, after))}, diagnose=${bridgesOf(ctx, 'diagnose').length}`,
    Object.keys(delta(before, after)).length !== 0 || bridgesOf(ctx, 'diagnose').length !== 0,
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  await ctx.listeners['agent/pre-step'](
    { agent: AGENT(), messages: [userMessage('x', 'runtime-context')], step: 1, turn: 1, signal: ABORT },
    async () => decision([userMessage('x', 'runtime-context')]),
  );
  await firePrompt(ctx, '   ');
  const after = counters();
  report(
    'A7 非真实用户 + 空白 prompt',
    'agent/pre-step：isRealUserMessage / 空白守卫（index.js:216,219）',
    '两条守卫都命中时 prompts 不变',
    `增量=${JSON.stringify(delta(before, after))}`,
    after.prompts !== before.prompts,
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  await ctx.listeners['agent/pre-step'](
    { agent: AGENT(), messages: [userMessage('x')], step: 1, turn: 1, signal: ABORT },
    async () => ({ kind: 'reject' }),
  );
  const after = counters();
  report(
    'A8 decision.kind=reject',
    'agent/pre-step：reject 守卫（index.js:199）',
    'reject 时不应有副作用',
    `增量=${JSON.stringify(delta(before, after))}, diagnose=${bridgesOf(ctx, 'diagnose').length}`,
    Object.keys(delta(before, after)).length !== 0 || bridgesOf(ctx, 'diagnose').length !== 0,
  );
}
{
  const ctx = await boot(baseConfig({ enabled: { tool: false } }));
  const before = counters();
  const snapBefore = getSnapshot();
  fireTool(ctx, { name: 'read', arguments: {} });
  await tick();
  const after = counters();
  report(
    'A9 tools/result 且 enabled.tool=false',
    'tools/result：守卫之后连 touch() 都不发生（index.js:264）',
    '开关关闭 → 无任何副作用（含快照重写）',
    `增量=${JSON.stringify(delta(before, after))}, touched=${snapBefore !== getSnapshot()}`,
    Object.keys(delta(before, after)).length !== 0 || snapBefore !== getSnapshot(),
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  fireTool(ctx, { name: 'read', arguments: {} });
  await tick();
  const after = counters();
  report(
    'A10 tools/result 计数在降噪之前',
    'tools/result：计数与留痕分离（index.js:268 vs :283/:289）',
    '空参数 → 计数 +1，但不留痕',
    `toolEvents 增量=${after.toolEvents - before.toolEvents}, post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    after.toolEvents - before.toolEvents !== 1 || bridgesOf(ctx, 'post-tool').length !== 0,
  );
}

{
  const ctx = await boot(baseConfig());
  const before = counters();
  // 真实形态：callback(exec, result) —— exec 是 ToolExecution 位置参数
  fireTool(ctx, { name: 'write', arguments: { file_path: 'D:/x.md', content: 'project 计划' } }, {});
  await tick();
  const after = counters();
  report(
    'A12 tools/result 真实载荷形态',
    'tools/result：签名必须是位置参数 (exec, result)（index.js:311）',
    '真实形态下应计数 +1 且留痕',
    `toolEvents 增量=${after.toolEvents - before.toolEvents}, post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    after.toolEvents - before.toolEvents !== 1 || bridgesOf(ctx, 'post-tool').length !== 1,
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  // 反例：按旧写法传对象载荷 `{ exec }` —— 防御性归一应仍保证计数不丢
  fireTool(ctx, { exec: { name: 'write', arguments: { content: 'project' } } }, {});
  await tick();
  const after = counters();
  report(
    'A13 tools/result 对象载荷兼容',
    'tools/result：防御性归一兼容 `{ exec }` 形态（index.js:317-319）',
    '对象载荷下至少计数不丢',
    `toolEvents 增量=${after.toolEvents - before.toolEvents}, post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    after.toolEvents - before.toolEvents !== 1,
  );
}

// ============================================================
// B. writer.js 失败分支可达性
// ============================================================
console.log('\n=== B. writer.js 失败分支可达性 ===');
{
  // agent/created 会触发两次写入（memorySync + bridge），所以期望增量是 2
  const cases = [
    ['nodePath 不可解析', { nodeUnavailable: true }, 'spawn-unavailable'],
    ['spawn() 返回 rejected promise', { spawnBehaviour: { kind: 'throw' } }, 'spawn-throw'],
    ['exitCode=7', { spawnBehaviour: { kind: 'nonzero', exitCode: 7, stderr: 'bad' } }, 'exit-7'],
    ['done 被 reject', { spawnBehaviour: { kind: 'reject' } }, 'spawn-error'],
  ];
  for (const [label, opts, expectReason] of cases) {
    const ctx = await boot(baseConfig(), opts);
    const before = counters().writeFailures ?? 0;
    ctx.warnings.length = 0;
    ctx.listeners['agent/created']({ agent: AGENT() });
    await tick();
    const after = counters().writeFailures ?? 0;
    const reason = getSnapshot()?.last?.writeFailures?.reason;
    report(
      `B ${label}`,
      'writer.fire() 失败分支（writer.js:79/:86/:95/:101）',
      `reason=${expectReason}，writeFailures 增量=2（memorySync + bridge 各一次）`,
      `增量=${after - before}, reason=${JSON.stringify(reason)}, warn=${ctx.warnings.length}`,
      reason !== expectReason || after - before !== 2,
    );
  }
}
{
  const ctx = await boot(baseConfig(), { nodeUnavailable: true });
  ctx.warnings.length = 0;
  ctx.listeners['agent/created']({ agent: AGENT() });
  await tick();
  report(
    'B5 spawn-unavailable 的日志覆盖',
    'writer.fire()：只有 exit-N 分支写 warn（writer.js:88）',
    '每个失败分支都应留 warn 日志',
    `spawn-unavailable 时 warn=${ctx.warnings.length}`,
    ctx.warnings.length === 0,
  );
  const ctx2 = await boot(baseConfig(), { spawnBehaviour: { kind: 'nonzero', exitCode: 3 } });
  ctx2.warnings.length = 0;
  ctx2.listeners['agent/created']({ agent: AGENT() });
  await tick();
  report(
    'B6 exit-N 的日志覆盖',
    'writer.fire()：exit-N 分支写 warn（writer.js:88）',
    'exit-N 时应有 warn',
    `exit-3 时 warn=${ctx2.warnings.length}`,
    ctx2.warnings.length === 0,
  );
}

// ============================================================
// C. ensureIndex：失败语义与重建语义
// ============================================================
console.log('\n=== C. ensureIndex 失败与重建语义 ===');
{
  writeNote('30_Resources/experience/KB-C.md', note('MCP 桥接'));
  const ctx = await boot(baseConfig(), { resolveThrows: true });
  const before = counters();
  await firePrompt(ctx, 'MCP 桥接 实现');
  const after = counters();
  report(
    'C1 扫描失败被计入 indexBuilt',
    'ensureIndex：buildVaultIndex 内部吞掉全部异常并返回 []（vault-index.js:76/89/113/119）',
    '扫描失败不应计入 indexBuilt',
    `indexBuilt 增量=${after.indexBuilt - before.indexBuilt}, index.size=${getSnapshot()?.index?.size}, last.indexBuilt.size=${getSnapshot()?.last?.indexBuilt?.size}`,
    after.indexBuilt - before.indexBuilt !== 0,
  );
}
{
  // 失败后修复 fs：因为 index.length === 0，fresh 恒为 false → 立即重试
  const ctx = await boot(baseConfig(), { resolveThrows: true });
  await firePrompt(ctx, 'MCP 桥接 实现');
  const sizeAfterFail = getSnapshot()?.index?.size;
  ctx.fs.resolve = async (p) => fsTarget(p);
  await firePrompt(ctx, 'MCP 桥接 实现');
  const sizeAfterFix = getSnapshot()?.index?.size;
  report(
    'C2 失败后能否立即恢复',
    'ensureIndex 的 fresh 条件含 `index.length > 0`（index.js:140）',
    '空索引不算 fresh → 修复后应立即重扫（不是 bug，仅记录）',
    `失败后 size=${sizeAfterFail}；修复 fs 后 size=${sizeAfterFix}`,
    false,
  );
}
{
  const ctx = await boot(baseConfig(), { listDirGate: () => [] });
  await firePrompt(ctx, 'MCP 桥接 实现');
  const calls1 = ctx.listDirCalls;
  await firePrompt(ctx, 'MCP 桥接 实现');
  report(
    'C3 空索引导致每次 prompt 都重扫',
    'ensureIndex 的 fresh 条件含 `index.length > 0`（index.js:140）',
    '真实 Vault 为空时应退避，而不是每次 prompt 全量重扫',
    `连续两次 prompt 的 listDir 调用数：${calls1} → ${ctx.listDirCalls}`,
    false,
  );
}
{
  writeNote('30_Resources/experience/KB-D.md', note('MCP 桥接'));
  const gate = deferred();
  const ctx = await boot(baseConfig(), { listDirGate: () => gate.promise });
  const inFlight = firePrompt(ctx, 'MCP 桥接 实现');
  const callsBefore = ctx.listDirCalls;
  const refreshed = refreshSnapshot();
  await tick(20);
  gate.resolve([]);
  await inFlight;
  await refreshed;
  report(
    'C4 扫描进行中调用 refresh()',
    'rebuildIndex 的 invalidateIndex() 未清 indexPromise（index.js:118-127 → :142-155）',
    'refresh 应真正重新扫描一次（listDirCalls +1）',
    `refresh 前后 listDirCalls: ${callsBefore} → ${ctx.listDirCalls}`,
    ctx.listDirCalls !== callsBefore + 1,
  );
}
{
  const ctx = await boot(baseConfig(), {});
  const callsBefore = ctx.listDirCalls;
  await refreshSnapshot();
  report(
    'C5 空闲时 refresh() 是否重扫',
    'rebuildIndex → ensureIndex（index.js:124-127）',
    '空闲时 indexPromise 为 null → 应重扫一次（listDir 调用数增加）',
    `listDirCalls: ${callsBefore} → ${ctx.listDirCalls}`,
    ctx.listDirCalls <= callsBefore,
  );
}

// ============================================================
// D. refreshSnapshot 的快照新鲜度
// ============================================================
console.log('\n=== D. refreshSnapshot 快照新鲜度 ===');
{
  writeNote('30_Resources/experience/KB-E1.md', note('MCP 桥接'));
  const ctx = await boot(baseConfig());
  await firePrompt(ctx, 'MCP 桥接 实现');
  const snapBefore = getSnapshot();
  const sizeBefore = snapBefore?.index?.size;
  const builtBefore = counters().indexBuilt;
  writeNote('30_Resources/experience/KB-E2.md', note('MCP 桥接 新笔记'));
  await refreshSnapshot();
  const snapAfter = getSnapshot();
  const sizeAfter = snapAfter?.index?.size;
  const builtAfter = counters().indexBuilt;
  report(
    'D1 refresh() 返回的快照不含新索引',
    'rebuildIndex 从不调用 touch()/snapshot()（index.js:124-127）',
    'refresh 后返回的快照 index.size 应等于新索引条数',
    `index.size ${sizeBefore} → ${sizeAfter}（Vault 新增 1 篇）；indexBuilt ${builtBefore} → ${builtAfter}`,
    sizeAfter === sizeBefore,
  );
  report(
    'D2 refresh() 不重写快照对象',
    'rebuildIndex 不调用 snapshot() → status-store.js:23 的 setSnapshot 不被触发',
    'refresh 应重写快照（对象身份变化）',
    `快照对象身份是否变化=${snapBefore !== snapAfter}`,
    snapBefore === snapAfter,
  );
}

// ============================================================
// E. 降噪判定与 bridge.js 的一致性
// ============================================================
console.log('\n=== E. 降噪判定与 bridge.js 的一致性 ===');
{
  const ctx = await boot(baseConfig());
  fireTool(ctx, { name: 'notepad_write', arguments: { text: 'hello world' } });
  await tick();
  report(
    'E1 工具名参与降噪判定',
    'index.js:287 用 `${toolName} ${serialized}`；bridge.js:622-627 只匹配 tool_input',
    '两侧关键词检测应一致（index.js:261 注释如此声明）→ bridge.js 不会留痕时插件也不应留痕',
    `工具名含 "note"、输入不含关键词 → post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    bridgesOf(ctx, 'post-tool').length !== 0,
  );
}
{
  const ctx = await boot(baseConfig());
  const longInput = { text: `${'x'.repeat(400)} project` };
  fireTool(ctx, { name: 'write', arguments: longInput });
  await tick();
  report(
    'E2 长输入截断不一致',
    'bridge.js:619 先 substring(0,300) 再匹配；index.js 用完整 serialized',
    '两侧应在同一长度上判定（bridge.js 不会留痕）',
    `关键词在第 401 字符 → post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    bridgesOf(ctx, 'post-tool').length !== 0,
  );
}
{
  const ctx = await boot(baseConfig());
  fireTool(ctx, { name: 'write', arguments: { file_path: 'D:/x.md', content: 'project 计划' } });
  await tick();
  report(
    'E3 正例：输入含 project',
    '两侧都应留痕',
    'post-tool=1',
    `post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    bridgesOf(ctx, 'post-tool').length !== 1,
  );
}

// ============================================================
// F. 异常吞噬边界
// ============================================================
console.log('\n=== F. 异常吞噬边界 ===');
{
  const ctx = await boot(baseConfig());
  const before = counters();
  const circular = {};
  circular.self = circular;
  let threw = false;
  try {
    // 直接调用等价于「插件抛错」；生产环境由 dsh-tools 的 try/catch 兜住
    fireTool(ctx, { name: 'write', arguments: circular });
  } catch {
    threw = true;
  }
  await tick();
  const after = counters();
  report(
    'F1 tools/result 观察者抛错（循环引用）',
    'index.js:281 JSON.stringify 在计数之后；dsh-tools/lib/index.js:3517-3522 兜住异常',
    '计数应已 +1（在抛错之前），留痕应缺失',
    `抛错=${threw}, toolEvents 增量=${after.toolEvents - before.toolEvents}, post-tool=${bridgesOf(ctx, 'post-tool').length}`,
    !threw || after.toolEvents - before.toolEvents !== 1,
  );
}
{
  const ctx = await boot(baseConfig());
  const before = counters();
  let threw = false;
  try {
    await ctx.listeners['agent/pre-step'](
      { agent: AGENT(), messages: undefined, step: 1, turn: 1, signal: ABORT },
      async () => ({ kind: 'enter', messages: undefined }),
    );
  } catch {
    threw = true;
  }
  report(
    'F2 agent/pre-step 缺少 messages 时',
    'index.js:203 直接读 decision.messages[...]；waterfall 无异常兜底',
    '不应抛错（否则打断整个回合）',
    `抛错=${threw}`,
    'warn',
  );
}

// ============================================================
// G. isSubagent 的静默 false 回退
// ============================================================
console.log('\n=== G. isSubagent 静默回退 ===');
{
  const ctx = await boot(baseConfig());
  const before = counters();
  ctx.listeners['agent/created']({ agent: { session: {} } });
  await tick();
  const after = counters();
  report(
    'G1 session.header 缺失',
    'isSubagent 在 header 缺失时返回 false（message.js:75-77）',
    '无法判定子代理时不应误当主会话留痕（且 DSH 是否总是写入 header 需确认）',
    `sessionStarts 增量=${after.sessionStarts - before.sessionStarts}`,
    'warn',
  );
}

// ============================================================
// H. 状态泄漏：跨 apply 的模块级快照
// ============================================================

/**
 * **事件类**计数键 —— 只有这些能证明「旧实例的计数泄漏进了新实例」。
 *
 * 判据必须收窄到这一组，不能要求「快照全 0」：
 * `apply()` 自身会做启动工作（`ensureIndex()` 构建索引、organize 相关初始化），
 * 因此 `indexBuilt` / `indexFailed` / `organizeRuns` / `organizeFailed`
 * 在新实例首次取数时**本来就应该是非 0**，它们是**合法的新计数**，不是泄漏。
 * 早期版本把 `indexBuilt` 也算进判定条件，导致 H1 恒报 BUG（实测误报）。
 */
const LEAKY_COUNTERS = ['prompts', 'injections', 'toolEvents', 'stops', 'sessionStarts', 'writeFailures'];

console.log('\n=== H. 状态泄漏 ===');
{
  const first = await boot(baseConfig());
  first.listeners['agent/created']({ agent: AGENT() });
  await tick();
  const oldCounters = counters();
  const second = await boot(baseConfig());
  const immediate = counters();
  report(
    'H1 重载后事件类计数是否泄漏',
    'status-store.js:14 snapshotValue 是模块级，跨 apply 存活；index.js 启动时须 resetStore()',
    `新实例首次取数时，事件类计数（${LEAKY_COUNTERS.join('/')}）必须归零；`
      + 'apply() 自身构建索引产生的 indexBuilt/indexFailed 属合法新计数，不要求为 0',
    `旧实例=${JSON.stringify(oldCounters)}；新实例 apply 后立刻=${JSON.stringify(immediate)}`,
    LEAKY_COUNTERS.some((k) => (immediate[k] ?? 0) !== 0),
  );
  void second;
}

// ============================================================
// I. 注释 / JSDoc 与实现一致性
// ============================================================
console.log('\n=== I. 注释 / JSDoc 与实现一致性 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes('按阈值触发治理'));
  const statusSrc = fs.readFileSync(path.join(ROOT, 'lib/status.js'), 'utf-8');
  const configSrc = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf-8');
  const ctx = await boot(baseConfig());
  for (let i = 0; i < 6; i += 1) ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  await tick();
  report(
    `I1 index.js:${idx + 1} 注释「按阈值触发治理」`,
    'JSDoc 声明 turn-stopping 会按阈值触发治理',
    '插件内应有治理触发（record(governanceRuns) 或 govern 留痕）',
    `governanceRuns=${JSON.stringify(counters().governanceRuns)}；govern 留痕=${bridgesOf(ctx, 'govern').length}；`
      + `status.js 是否已移除该键=${/governanceRuns/.test(statusSrc)}；config.js 是否还有 everyStops=${/everyStops/.test(configSrc)}`,
    false,
  );
}
{
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes('计数与留痕是两件事'));
  report(
    `I2 index.js:${idx + 1} 注释「计数与留痕是两件事」`,
    '注释声明 toolEvents 必须每次都 +1（语义 = 全部工具调用）',
    'enabled.tool=false 时 toolEvents 是否仍 +1',
    `正常路径 +1（见 A10）；enabled.tool=false 时 +0（见 audit-counters.mjs T4）`,
    false,
  );
  void src;
}

// ============================================================
// 13. 输出
// ============================================================
fs.rmSync(VAULT, { recursive: true, force: true });
fs.rmSync(STAGING, { recursive: true, force: true });

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const order = { BUG: 0, WARN: 1, OK: 2, INFO: 3 };
  results.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const r of results) {
    const mark = r.status.padEnd(4, ' ');
    console.log(`\n[${mark}] ${r.id}  ${r.title}`);
    console.log(`        意图: ${r.intent}`);
    console.log(`        实测: ${r.actual}`);
  }
  const bugs = results.filter((r) => r.status === 'BUG').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  const oks = results.filter((r) => r.status === 'OK').length;
  console.log(`\n合计：BUG ${bugs} / WARN ${warns} / OK ${oks} / INFO ${results.length - bugs - warns - oks}（共 ${results.length} 条）`);
  if (bugs > 0 || warns > 0) {
    console.log('结论：存在与意图不符的控制流问题，详见 test/audit-flow.md');
  }
}

process.exit(results.some((r) => r.status === 'BUG') ? 1 : 0);
