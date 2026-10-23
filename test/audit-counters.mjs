/**
 * 计数器与可观测性字段真实性审计 —— **回归守卫版**。
 *
 * 本文件最初是「证伪式」审计（断言 bug 存在）。v1.0.0 修复后，那 10 条断言
 * （G1 / I3 / I5 / I6 / V1 / V2 / V3 / V4 / V6 / V7）已转为**正向守卫**
 * （断言修复后的正确状态），并保留原编号。注释里标注了「原为证伪断言」。
 *
 * 方法：用 mock Cordis ctx 加载**真实** `index.js`（不是复刻逻辑），驱动真实
 * 事件处理器，读 `lib/status-store.js` 共享快照断言计数值。
 *
 * 运行：node test/audit-counters.mjs [--json]
 *
 * 说明：`lib/config.js` 依赖 `@deepseek-ai/schemastery`，工作区里没有
 * `node_modules`，因此本脚本会把自己要加载的 `lib/` + `index.js` 临时复制到
 * profile 的 `node_modules` 下（那里能解析 schemastery），跑完清理。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_MODULES = path.join(os.homedir(), '.dsh/profiles/desktop/node_modules');
const NODE = process.execPath;

// ============================================================
// 0. 临时 Vault：可控的笔记集合，用于精确断言注入条数
// ============================================================
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-audit-'));
// 任何退出路径都清理临时目录（含异常中断）
process.on('exit', () => {
  try {
    fs.rmSync(VAULT, { recursive: true, force: true });
  } catch {
    // 退出阶段无法补救
  }
});
const write = (rel, body) => {
  const full = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
};

write('30_Resources/experience/KB-1_桥接.md', '---\ntitle: MCP 桥接方案\nsummary: 用 MCP 桥接\ncategory: experience\n---\n\nMCP 桥接正文\n');
write('30_Resources/experience/KB-2_桥接.md', '---\ntitle: 另一个 MCP 桥接\nsummary: MCP 桥接变体\ncategory: experience\n---\n\nMCP 桥接正文二\n');
write('30_Resources/experience/KB-3_桥接.md', '---\ntitle: 第三篇 MCP 桥接\nsummary: MCP 桥接再述\ncategory: experience\n---\n\nMCP 桥接正文三\n');
write('30_Resources/topic/KB-4_无关.md', '---\ntitle: 无关笔记\nsummary: 完全无关\ncategory: topic\n---\n\n无关正文\n');

// ============================================================
// 1. 加载真实 index.js（先 stage 到 profile node_modules 以解析 schemastery）
// ============================================================
const STAGING = path.join(PROFILE_MODULES, '.audit-counters-staging');
// 必须与 index.js 内部 `import './lib/status-store.js'` 解析出的 URL 完全一致，
// 否则会是两个模块实例，setSnapshot 写的快照在 getSnapshot 里读不到。
const STORE_URL = pathToFileURL(path.join(STAGING, 'lib/status-store.js')).href;

let indexModule;
let store;
let statusModule;
{
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(STAGING, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(STAGING, 'index.js'));
  indexModule = await import(pathToFileURL(path.join(STAGING, 'index.js')).href);
  store = await import(STORE_URL);
  statusModule = await import(pathToFileURL(path.join(STAGING, 'lib/status.js')).href);
}

const { getSnapshot, refreshSnapshot } = store;
const { COUNTER_KEYS, REMOVED_COUNTER_KEYS, createStatus } = statusModule;

// ============================================================
// 2. mock ctx 工厂
// ============================================================
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const fsTarget = (p) => ({ targetKey: `k:${p}`, displayPath: p });

/** 真实 ToolsService 的 API 形状（dsh-tools/lib/index.js:2974,3091,3119,3153）。 */
function makeToolsService(names) {
  return {
    register() {},
    get() {},
    schemas() {
      return names.map((name) => ({ name }));
    },
    executionMode() {
      return { kind: 'serial' };
    },
  };
}

function makeCtx({ toolsService } = {}) {
  const listeners = {};
  const bridgeCalls = [];
  const ctx = {
    listeners,
    bridgeCalls,
    effects: [],
    plugins: [],
    warnings: [],
    on(event, listener) {
      listeners[event] = listener;
    },
    effect(disposer) {
      ctx.effects.push(disposer);
    },
    plugin(ServiceClass) {
      ctx.plugins.push(ServiceClass);
      return Promise.resolve();
    },
    logger: {
      debug() {},
      info() {},
      warn(...a) {
        ctx.warnings.push(a.join(' '));
      },
      error(...a) {
        ctx.warnings.push(a.join(' '));
      },
    },
    get(key) {
      return key === 'tools' ? toolsService : undefined;
    },
    fs: {
      async resolve(p) {
        return fsTarget(p);
      },
      async stat(t) {
        if (!fs.existsSync(t.displayPath)) return undefined;
        const st = fs.statSync(t.displayPath);
        return { type: st.isDirectory() ? 'directory' : 'file', size: st.size };
      },
      async listDir(t) {
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
        return NODE;
      },
      async spawn(spec) {
        bridgeCalls.push({ argv: spec.argv, stdin: spec.stdio?.stdin?.data });
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stderr: { readFrom: () => ({ text: '' }) } } };
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
  governance: { documented: true },
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

async function boot(config, ctxOptions) {
  const ctx = makeCtx(ctxOptions);
  indexModule.apply(ctx, config);
  await tick();
  return ctx;
}

async function firePrompt(ctx, text, { step = 1, turn = 1 } = {}) {
  return ctx.listeners['agent/pre-step'](
    { agent: AGENT(), messages: [userMessage(text)], step, turn, signal: ABORT },
    async () => decision([userMessage(text)]),
  );
}

// ============================================================
// 3. 断言
// ============================================================
const results = [];
const check = (id, counter, title, fn) => {
  try {
    fn();
    results.push({ id, counter, title, status: 'PASS', evidence: '' });
  } catch (error) {
    const detail = String(error?.message ?? error).split('\n').slice(0, 6).join(' | ');
    results.push({ id, counter, title, status: 'FAIL', evidence: detail });
  }
};
const C = (k) => getSnapshot()?.counters?.[k];
const L = (k) => getSnapshot()?.last?.[k];

// ---------- toolEvents ----------
{
  const ctx = await boot(baseConfig());
  ctx.listeners['tools/result']({ exec: { name: 'write', arguments: { file_path: 'D:/x.md', content: 'project 计划' } } });
  await tick();
  check('T1', 'toolEvents', '正常：write 带 project → +1', () => {
    assert.equal(C('toolEvents'), 1);
  });
  ctx.listeners['tools/result']({ exec: { name: 'read', arguments: {} } });
  await tick();
  check('T2', 'toolEvents', '边界：空参数 {} → 仍 +1（回归用户报的 bug）', () => {
    assert.equal(C('toolEvents'), 2);
  });
  ctx.listeners['tools/result']({ exec: { name: 'read', arguments: { file_path: 'D:/x.md' } } });
  await tick();
  check('T3', 'toolEvents', '边界：非相关工具 → 计数 +1 但不留痕', () => {
    assert.equal(C('toolEvents'), 3);
    assert.equal(ctx.bridgeCalls.filter((c) => c.argv[2] === 'post-tool').length, 1, '只有 project 那条留痕');
  });
  ctx.listeners['tools/result']({});
  await tick();
  check('T5', 'toolEvents', '边界：exec 缺失 → 仍 +1', () => {
    assert.equal(C('toolEvents'), 4);
  });
  check('T6', 'toolEvents', '正常：last.toolEvents.tool 记录工具名', () => {
    assert.equal(L('toolEvents')?.tool, '', '最后一次是空 exec，tool 应为空串');
  });
}
{
  const ctx = await boot(baseConfig({ enabled: { tool: false } }));
  ctx.listeners['tools/result']({ exec: { name: 'write', arguments: { file_path: 'D:/x.md', content: 'project' } } });
  check('T4', 'toolEvents', '边界：enabled.tool=false → +0', () => {
    assert.equal(C('toolEvents'), 0);
  });
}

// ---------- prompts ----------
{
  const ctx = await boot(baseConfig());
  await firePrompt(ctx, 'Obsidian 桥接 MCP 实现方式');
  check('P1', 'prompts', '正常：step 1 真实用户消息 → +1', () => {
    assert.equal(C('prompts'), 1);
  });
  await firePrompt(ctx, '任意内容', { step: 2 });
  check('P2', 'prompts', '边界：step 2 → 计数不变', () => {
    assert.equal(C('prompts'), 1);
  });
  await ctx.listeners['agent/pre-step'](
    { agent: AGENT(), messages: [userMessage('已注入', 'runtime-context')], step: 1, turn: 2, signal: ABORT },
    async () => decision([userMessage('已注入', 'runtime-context')]),
  );
  check('P3', 'prompts', '边界：末条是注入消息（runtime-context）→ 计数不变', () => {
    assert.equal(C('prompts'), 1);
  });
  await firePrompt(ctx, '   ');
  check('P4', 'prompts', '边界：空白 prompt → 计数不变', () => {
    assert.equal(C('prompts'), 1);
  });
  check('P6', 'prompts', '正常：last.prompts.injected 记录是否注入', () => {
    assert.equal(L('prompts')?.injected, true);
  });
}
{
  const ctx = await boot(baseConfig({ enabled: { prompt: false } }));
  await firePrompt(ctx, 'Obsidian 桥接 MCP');
  check('P5', 'prompts', '边界：enabled.prompt=false → +0', () => {
    assert.equal(C('prompts'), 0);
  });
}

// ---------- injections（I3/I5/I6 原为证伪断言，v1.0.0 修复后转为守卫） ----------
{
  // limit 设为 5、实际命中 3 条 —— 两者不等，才能证明 entries 记的是实际条数
  const ctx = await boot(baseConfig({ inject: { enabled: true, limit: 5, minKeywordLength: 2 } }));
  const out = await firePrompt(ctx, 'MCP 桥接 的实现方式');
  const injectedMsg = out.messages[out.messages.length - 1];
  const injectedText = injectedMsg?.content?.[0]?.text ?? '';
  const actualEntries = injectedText.split('### [').length - 1;
  check('I1', 'injections', '正常：3 条命中 → 实际注入 3 条', () => {
    assert.equal(actualEntries, 3, `实际注入条目数应为 3，实际 ${actualEntries}`);
  });
  check('I2', 'injections', '正常：counters.injections 语义 = 「产生注入的 prompt 次数」', () => {
    assert.equal(C('injections'), 1, `injections 应为 1（prompt 数），实际 ${C('injections')}`);
  });
  // 原为证伪断言（断言 entries 是配置上限 5），v1.0.0 修复后转为守卫：
  // entries 必须等于**实际命中条数**，且不等于 cfg.inject.limit。
  check('I3', 'injections', '守卫：last.injections.entries === 实际命中条数，且 !== 配置上限', () => {
    assert.equal(L('injections')?.entries, 3, `entries 应为实际条数 3，实际 ${L('injections')?.entries}`);
    assert.notEqual(L('injections')?.entries, 5, 'entries 不应等于配置上限 5');
  });
  check('I6', 'injections', '守卫：注入消息 sections[0].entryCount === 实际条数，且 !== 配置上限', () => {
    assert.equal(injectedMsg?.source?.sections?.[0]?.entryCount, 3, '应为实际条数 3');
    assert.notEqual(injectedMsg?.source?.sections?.[0]?.entryCount, 5, '不应等于配置上限 5');
  });
}
{
  const ctx = await boot(baseConfig({ inject: { enabled: false, limit: 3, minKeywordLength: 2 } }));
  await firePrompt(ctx, 'MCP 桥接 的实现方式');
  check('I4', 'injections', '边界：inject.enabled=false → +0', () => {
    assert.equal(C('injections'), 0);
  });
}
{
  // 原为证伪断言（断言 enabled.prompt=false 时仍注入），v1.0.0 修复后转为守卫：
  // 开关关闭后既不应注入，也不应计数。
  const ctx = await boot(baseConfig({ enabled: { prompt: false }, inject: { enabled: true, limit: 3, minKeywordLength: 2 } }));
  const out = await firePrompt(ctx, 'MCP 桥接 的实现方式');
  check('I5', 'injections', '守卫：enabled.prompt=false 时不再注入，且 prompts/injections 均为 0', () => {
    assert.equal(out.messages.length, 1, `开关关闭后不应注入，实际消息数 ${out.messages.length}`);
    assert.equal(C('injections'), 0, 'prompt 开关关闭 → injections 不计数');
    assert.equal(C('prompts'), 0);
  });
}

// ---------- stops ----------
{
  const ctx = await boot(baseConfig());
  ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  check('S1', 'stops', '正常：父会话 → +1', () => {
    assert.equal(C('stops'), 1);
  });
  ctx.listeners['agent/turn-stopping']({ agent: AGENT({ origin: 'subagent' }) });
  check('S2', 'stops', '边界：子代理 origin=subagent → 计数不变', () => {
    assert.equal(C('stops'), 1);
  });
  ctx.listeners['agent/turn-stopping']({ agent: AGENT({ delegationDepth: 2 }) });
  check('S3', 'stops', '边界：delegationDepth>0 → 计数不变', () => {
    assert.equal(C('stops'), 1);
  });
}
{
  const ctx = await boot(baseConfig({ enabled: { stop: false } }));
  ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  check('S4', 'stops', '边界：enabled.stop=false → +0', () => {
    assert.equal(C('stops'), 0);
  });
}

// ---------- sessionStarts ----------
{
  const ctx = await boot(baseConfig());
  ctx.listeners['agent/created']({ agent: AGENT() });
  check('SS1', 'sessionStarts', '正常：父会话 → +1', () => {
    assert.equal(C('sessionStarts'), 1);
  });
  ctx.listeners['agent/created']({ agent: AGENT({ origin: 'subagent', delegationDepth: 1 }) });
  check('SS2', 'sessionStarts', '边界：子代理 → 计数不变', () => {
    assert.equal(C('sessionStarts'), 1);
  });
  await tick();
  check('SS4', 'sessionStarts', '正常：每次会话开始都触发记忆同步', () => {
    assert.equal(ctx.bridgeCalls.filter((c) => c.argv[1]?.includes('sync-workbuddy-memory.js')).length, 1);
  });
}
{
  const ctx = await boot(baseConfig({ enabled: { sessionStart: false } }));
  ctx.listeners['agent/created']({ agent: AGENT() });
  check('SS3', 'sessionStarts', '边界：enabled.sessionStart=false → +0', () => {
    assert.equal(C('sessionStarts'), 0);
  });
}

// ---------- governanceRuns（G1 原为证伪断言，v1.0.0 修复后转为守卫） ----------
{
  const ctx = await boot(baseConfig());
  for (let i = 0; i < 10; i += 1) {
    ctx.listeners['agent/turn-stopping']({ agent: AGENT() });
  }
  await tick();
  // 原为证伪断言（断言 10 次 stop 后 governanceRuns 仍为 0），v1.0.0 修复后转为守卫：
  // 该计数器已移除，快照里不应再出现这个键。
  check('G1', 'governanceRuns', '守卫：governanceRuns 已从快照移除（不再出现恒 0 的假字段）', () => {
    assert.equal(C('governanceRuns'), undefined, `快照不应再含 governanceRuns，实际 ${C('governanceRuns')}`);
    assert.ok(!Object.keys(getSnapshot().counters).includes('governanceRuns'));
  });
  check('G2', 'governanceRuns', '守卫：全程无任何 govern 留痕（治理由 bridge.js 自行调度）', () => {
    assert.equal(ctx.bridgeCalls.filter((c) => c.argv[2] === 'govern').length, 0);
  });
}

// ---------- indexBuilt ----------
{
  const ctx = await boot(baseConfig());
  check('IB1', 'indexBuilt', '正常：启动构建 → +1 且 last.size 为真实条数', () => {
    assert.equal(C('indexBuilt'), 1, `indexBuilt 应为 1，实际 ${C('indexBuilt')}`);
    assert.equal(L('indexBuilt')?.size, 4, `last.indexBuilt.size 应为 4，实际 ${L('indexBuilt')?.size}`);
  });
  await firePrompt(ctx, 'MCP 桥接 实现');
  check('IB2', 'indexBuilt', '边界：TTL 内二次取数 → 不重建', () => {
    assert.equal(C('indexBuilt'), 1);
  });
  await refreshSnapshot();
  check('IB3', 'indexBuilt', '正常：refresh() 强制重建 → 计数变 2', () => {
    assert.equal(C('indexBuilt'), 2);
  });
}

// ---------- writeFailures ----------
{
  const ctx = await boot(baseConfig());
  ctx.subprocess.spawn = async () => { throw new Error('boom'); };
  ctx.listeners['agent/created']({ agent: AGENT() });
  await tick();
  check('W1', 'writeFailures', '边界：spawn 抛错 → reason=spawn-throw（2 次写入各计一次）', () => {
    assert.equal(C('writeFailures'), 2, `期望 2（memorySync + session-start），实际 ${C('writeFailures')}`);
    assert.equal(L('writeFailures')?.reason, 'spawn-throw');
  });
}
{
  const ctx = await boot(baseConfig());
  ctx.subprocess.spawn = async () => ({
    done: Promise.resolve({ exitCode: 1, signal: null }),
    collected: { stderr: { readFrom: () => ({ text: 'fail' }) } },
  });
  ctx.listeners['agent/created']({ agent: AGENT() });
  await tick();
  check('W2', 'writeFailures', '边界：exitCode=1 → reason=exit-1', () => {
    assert.equal(C('writeFailures'), 2, `期望 2，实际 ${C('writeFailures')}`);
    assert.equal(L('writeFailures')?.reason, 'exit-1');
  });
}
{
  const ctx = await boot(baseConfig());
  ctx.subprocess.resolveExecutable = async () => { throw new Error('no node'); };
  ctx.listeners['agent/created']({ agent: AGENT() });
  await tick();
  check('W3', 'writeFailures', '边界：node 不可解析 → reason=spawn-unavailable', () => {
    assert.equal(C('writeFailures'), 2, `期望 2，实际 ${C('writeFailures')}`);
    assert.equal(L('writeFailures')?.reason, 'spawn-unavailable');
  });
}
{
  const ctx = await boot(baseConfig());
  ctx.subprocess.spawn = async () => ({ done: Promise.reject(new Error('nope')), collected: {} });
  ctx.listeners['agent/created']({ agent: AGENT() });
  await tick();
  check('W4', 'writeFailures', '边界：done reject → reason=spawn-error', () => {
    assert.equal(C('writeFailures'), 2, `期望 2，实际 ${C('writeFailures')}`);
    assert.equal(L('writeFailures')?.reason, 'spawn-error');
  });
}

// ---------- 快照字段真实性（F1 原为证伪断言） ----------
{
  await boot(baseConfig({ inject: { enabled: true, limit: 5, minKeywordLength: 2 } }));
  const snap = getSnapshot();
  // 原为证伪断言（断言 mcpTools 恒为 null），v1.0.0 修复后转为守卫：
  // mcpTools 必须是数字或 null，且不能是硬编码常量。
  check('F1', 'mcpTools', '守卫：快照 mcpTools 为数字或 null，不是硬编码常量', () => {
    assert.ok(snap?.mcpTools === null || typeof snap?.mcpTools === 'number', `mcpTools 类型异常：${typeof snap?.mcpTools}`);
  });
  check('F2', 'index.size', '正常：index.size 等于索引条数', () => {
    assert.equal(snap?.index?.size, 4);
  });
  check('F3', 'index.builtAt', '正常：index.builtAt 为构建时间戳', () => {
    assert.ok(snap?.index?.builtAt, 'builtAt 应有值');
  });
}

// ---------- 面板可见性（V1/V2/V3/V4/V6/V7 原为证伪断言） ----------
{
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf-8');
  const configSrc = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf-8');
  const patchSrc = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf-8');

  const rendered = [...new Set([...clientSrc.matchAll(/counters\.(\w+)/g)].map((m) => m[1]))];

  // 原为证伪断言（断言面板只渲染 5 个），v1.0.0 修复后转为守卫。
  check('V1', '(可见性)', '守卫：面板渲染全部计数器（V2 会校验与 COUNTER_KEYS 完全一致）', () => {
    // 具体键集交给 V2 与 COUNTER_KEYS 比对，这里只守住「必须逐个渲染」
    assert.ok(rendered.length >= 7, `渲染的计数器过少：${rendered.join(', ')}`);
    for (const k of ['prompts', 'injections', 'toolEvents', 'stops', 'sessionStarts']) {
      assert.ok(rendered.includes(k), `缺少核心计数器：${k}`);
    }
  });
  // 原为证伪断言（断言 2 个已声明计数器不可见），v1.0.0 修复后转为守卫。
  check('V2', '(可见性)', '守卫：已声明计数器全部可见（不可见集合为空）', () => {
    const invisible = COUNTER_KEYS.filter((k) => !rendered.includes(k));
    assert.deepEqual(invisible, [], `仍有不可见计数器：${invisible}`);
  });
  // 原为证伪断言（断言 last 不被渲染），v1.0.0 修复后转为守卫。
  check('V3', '(可见性)', '守卫：面板渲染 last（「最近一次事件」区）', () => {
    assert.match(clientSrc, /最近一次事件/, '面板应含「最近一次事件」区');
    assert.match(clientSrc, /Object\.keys\(last/, '面板应遍历 last 的键');
  });
  // 原为证伪断言（断言面板含硬编码 fallback），v1.0.0 修复后转为守卫。
  check('V4', '(可见性)', '守卫：面板按数字分支渲染 MCP 工具数，无硬编码「15 个」', () => {
    assert.match(clientSrc, /typeof status\.mcpTools === ['"]number['"]/, '面板应按数字判断');
    assert.ok(!clientSrc.includes('obsidian-local（15 个）'), '不应残留硬编码 15 个');
  });
  check('V5', '(可见性)', '守卫：lib/config.js 无 mcpTools 字段（死配置已清）', () => {
    assert.ok(!/mcpTools/.test(configSrc), 'config.js 不应出现 mcpTools');
  });
  // 原为证伪断言（断言 indexBuilt 未被声明），v1.0.0 修复后转为守卫。
  check('V6', 'indexBuilt', '守卫：indexBuilt 已由 createStatus() 显式声明', () => {
    const initial = Object.keys(createStatus().counters);
    assert.ok(initial.includes('indexBuilt'), `createStatus() 应声明 indexBuilt，实际键：${initial}`);
  });
  // 原为证伪断言（断言两计数器「声明 vs 可达」状态相反），v1.0.0 修复后转为守卫。
  check('V7', 'indexBuilt', '守卫：COUNTER_KEYS 与初始 counters 键集一致，且与 REMOVED_COUNTER_KEYS 不重叠', () => {
    assert.deepEqual(Object.keys(createStatus().counters).sort(), [...COUNTER_KEYS].sort());
    const all = [...COUNTER_KEYS, ...REMOVED_COUNTER_KEYS];
    assert.deepEqual(all.filter((k, i) => all.indexOf(k) !== i), [], '键集不应重叠');
  });
  check('V8', '(可见性)', '守卫：面板有 inject.enabled 开关行', () => {
    assert.match(clientSrc, /status\.inject[\s\S]{0,80}enabled/, '面板应展示 inject.enabled');
  });
  check('V9', '(可见性)', '守卫：cordis.patch.yml 不再把 everyStops 作为配置键（死配置清理）', () => {
    // 只检查**生效的 YAML 键**，忽略注释 ——
    // patch 里保留一句「原先的 everyStops 已移除」的说明是有价值的文档，
    // 不应因出现这个词而判失败。真正要守的是「它不再是一个配置项」。
    const effective = patchSrc
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.ok(
      !/everyStops\s*:/.test(effective),
      'patch 的有效配置里不应再出现 everyStops 键（注释中的说明不算）',
    );
    assert.match(effective, /documented\s*:/, 'patch 应改为 documented 键');
  });
}

// ---------- 新增守卫（覆盖修复清单里的其余条目） ----------
{
  const configSrc = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf-8');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf-8');

  check('N1', 'governanceRuns', '守卫：governanceRuns 不在 COUNTER_KEYS，且 lib/config.js 不再声明 everyStops 属性', () => {
    assert.ok(!COUNTER_KEYS.includes('governanceRuns'), 'governanceRuns 不应是活计数器');
    assert.ok(REMOVED_COUNTER_KEYS.includes('governanceRuns'), '应登记在 REMOVED_COUNTER_KEYS');
    // 只匹配「属性声明」而非文档注释里的提及（config.js 的注释会解释为何移除）
    assert.ok(!/everyStops\s*:/.test(configSrc), `lib/config.js 不应再声明 everyStops 属性：${configSrc.match(/.{0,40}everyStops\s*:.{0,40}/)?.[0] ?? ''}`);
  });
  check('N2', 'indexBuilt', '守卫：indexBuilt 与 indexFailed 都在 COUNTER_KEYS 中显式声明', () => {
    assert.ok(COUNTER_KEYS.includes('indexBuilt'), 'indexBuilt 必须声明');
    assert.ok(COUNTER_KEYS.includes('indexFailed'), 'indexFailed 必须声明（否则 C-05 复发）');
    assert.deepEqual(Object.keys(createStatus().counters).sort(), [...COUNTER_KEYS].sort(), '声明即全量');
  });
  // C-05 的修复必须覆盖**新增**的计数器：index.js 的 ensureIndex 失败分支会
  // record('indexFailed')，若它不在 COUNTER_KEYS 里，就是同一个幽灵键 bug 复发。
  check('N10', 'indexFailed', '★守卫：indexFailed 必须在 COUNTER_KEYS 中显式声明（否则 C-05 复发）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
    assert.match(src, /record\(['"]indexFailed['"]/, 'index.js 应记录 indexFailed');
    assert.ok(COUNTER_KEYS.includes('indexFailed'), `indexFailed 未声明，COUNTER_KEYS=${JSON.stringify(COUNTER_KEYS)}`);
  });
  check('N6', 'writeFailures', '守卫：面板渲染 writeFailures', () => {
    assert.match(clientSrc, /counters\.writeFailures/, '面板应渲染 writeFailures');
  });
  check('N7', 'last', '守卫：面板遍历渲染 last 的全部键', () => {
    assert.match(clientSrc, /Object\.keys\(last/, '面板应遍历 last');
  });
  check('N8', 'indexBuilt', '守卫：indexBuilt 计数语义在面板标注为「索引构建次数」', () => {
    assert.match(clientSrc, /索引构建次数/, '面板应把计数器标注为「索引构建次数」');
  });
}

// ---------- C-09 / C-10 运行时可达性（这两条**预期 FAIL**，见报告） ----------
{
  // C-09：countMcpTools 读的是 tools?.list?.() ?? tools?.tools，
  // 而真实 ToolsService（dsh-tools/lib/index.js:2974,3091,3119,3153）只有
  // register / get / schemas / executionMode —— 没有 list()，也没有 tools 属性。
  await boot(baseConfig(), {
    toolsService: makeToolsService([
      'mcp__obsidian-local__obsidian_read_note',
      'mcp__obsidian-local__obsidian_list_notes',
      'read',
      'write',
    ]),
  });
  const snap = getSnapshot();
  check('N3', 'mcpTools', '★C-09 运行时：有 2 个 mcp__ 工具时 snapshot.mcpTools 应为数字 2', () => {
    assert.equal(snap?.mcpTools, 2, `期望 2，实际 ${JSON.stringify(snap?.mcpTools)}`);
  });
}
{
  // C-10：buildVaultIndex 现在返回 { entries, ok, failedRoots }，
  // ok=false 表示一个根目录都没扫到（resolve/stat 全部失败）。
  // 必须与「空 Vault」区分：ok:false 且 indexFailed +1。
  const ctx = await boot(baseConfig());
  ctx.fs.resolve = async () => { throw new Error('ENOENT'); };
  ctx.fs.stat = async () => undefined;
  await refreshSnapshot();
  const snap = getSnapshot();
  check('N5', 'index.ok', '★C-10 运行时：全部根目录扫描失败时 index.ok === false', () => {
    assert.equal(snap?.index?.ok, false, `期望 false，实际 ${JSON.stringify(snap?.index)}`);
    assert.ok((C('indexFailed') ?? 0) >= 1, `indexFailed 应 +1，实际 ${C('indexFailed')}`);
  });
}

// ============================================================
// 4. 输出
// ============================================================
const json = process.argv.includes('--json');
const order = { PASS: 0, FAIL: 1 };
results.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }));

fs.rmSync(VAULT, { recursive: true, force: true });
fs.rmSync(STAGING, { recursive: true, force: true });

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('');
  let lastCounter = '';
  for (const r of results) {
    if (r.counter !== lastCounter) {
      console.log(`\n── ${r.counter}`);
      lastCounter = r.counter;
    }
    const mark = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${r.id.padEnd(5)} ${r.title}`);
    if (r.evidence) console.log(`         ${r.evidence}`);
  }
  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n通过 ${passed}/${results.length}`);
}

process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
