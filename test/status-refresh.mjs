/**
 * 状态快照刷新自测。
 *
 * 复现并验证「面板读到旧值」的修复：`snapshot()` 过去只在 HTTP 路由里被调用，
 * 而该路由在 Client 半边拿不到，导致共享存储永不更新。现在每个事件后调用
 * `touch()`，本测试用 mock ctx 加载真实 index.js 验证这一点。
 *
 * 注意：`index.js` 每次导入都是新实例（计数状态在模块闭包里），因此每个断言
 * 都要在同一个实例上连续进行，不能跨实例比较。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const results = [];
const check = (title, fn) => {
  try {
    fn();
    results.push({ title, status: 'PASS' });
  } catch (error) {
    results.push({ title, status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] });
  }
};

/** 造一个最小 mock ctx（fs 走真实文件系统）。 */
function makeCtx() {
  const listeners = {};
  return {
    listeners,
    get: () => undefined,
    on: (event, fn) => {
      listeners[event] = fn;
      return () => {};
    },
    effect: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
    fs: {
      resolve: (p) => p,
      async stat(t) {
        return fs.statSync(t.displayPath);
      },
      async listDir(t) {
        return fs.readdirSync(t.displayPath, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          target: {
            targetKey: `k:${path.join(t.displayPath, entry.name)}`,
            displayPath: path.join(t.displayPath, entry.name),
          },
          size: entry.isFile() ? fs.statSync(path.join(t.displayPath, entry.name)).size : undefined,
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
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {},
        };
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * 触发一个事件并等待异步写入完成。
 *
 * `rest` 用于传递**位置参数** —— `tools/result` 的签名是 `(exec, result)`，
 * 不是对象载荷，必须按真实派发形态调用，否则测试会变成假阳性。
 * @param ctx - mock 上下文。
 * @param event - 事件名。
 * @param args - 传给处理器的参数（按真实派发形态）。
 */
async function fire(ctx, event, ...args) {
  const fn = ctx.listeners[event];
  if (!fn) throw new Error(`没有注册 ${event} 处理器`);
  await fn(...args);
  await tick();
}

async function main() {
  const store = await import(pathToFileURL(path.join(ROOT, 'lib/status-store.js')).href);
  const index = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  // `apply(ctx, {})` 传空配置，vaultPath 由 config.js 的默认常量决定。
  // 断言必须引用该常量，而不是写死作者本机的路径。
  const { DEFAULT_VAULT_PATH } = await import(pathToFileURL(path.join(ROOT, 'lib/config.js')).href);

  store.setSnapshot(null);
  const ctx = makeCtx();
  index.apply(ctx, {});
  await tick();

  const before = store.getSnapshot();
  check('激活后即有快照（启动即构建索引）', () => {
    assert.ok(before, '激活后快照为 null');
    assert.equal(before.counters.sessionStarts, 0, '初始计数应为 0');
  });

  await fire(ctx, 'agent/created', { agent: { session: { header: {} } } });
  const afterSessionStart = store.getSnapshot();
  check('agent/created 后 sessionStarts 计数 +1', () => {
    assert.equal(afterSessionStart.counters.sessionStarts, 1);
  });

  // ⚠️ `tools/result` 的签名是**位置参数** `(exec, result)`，不是对象 `{ exec }`。
  // 证据：`dsh-tool-cordis/lib/types/api-catalog.js:4502`。
  // 本测试此前按对象形态调用（匹配了错误的处理器签名），因此一直是假阳性 ——
  // 处理器解构 `{ exec }` 得到 undefined，实际运行时恒提前 return。
  const fireTool = (exec) => fire(ctx, 'tools/result', exec, {});

  // 计数与留痕分离：相关的调用既计数也留痕
  await fireTool({ name: 'write', arguments: { file_path: 'D:/project-plan.md' } });
  const afterTool = store.getSnapshot();
  check('tools/result（相关）后 toolEvents 计数 +1', () => {
    assert.equal(afterTool.counters.toolEvents, 1);
  });

  // 关键回归：不相关的调用**也必须计数**（面板「工具调用事件」是全部调用的语义）。
  // 曾经把降噪的 return 放在计数之前，导致该计数长期显示 0。
  await fireTool({ name: 'read', arguments: { file_path: 'D:/readme.md' } });
  const afterIrrelevant = store.getSnapshot();
  check('tools/result（不相关）后 toolEvents 仍 +1（计数不受降噪影响）', () => {
    assert.equal(afterIrrelevant.counters.toolEvents, 2);
  });

  // 空参数的调用同样要计数（它也是一次真实的工具调用）
  await fireTool({ name: 'glob', arguments: {} });
  const afterEmpty = store.getSnapshot();
  check('tools/result（空参数）后 toolEvents 仍 +1', () => {
    assert.equal(afterEmpty.counters.toolEvents, 3);
  });

  // 关键回归：工具名必须被真实读取（此前因签名错误恒为空串）
  check('toolEvents 的 last.tool 记录了真实工具名（非空）', () => {
    assert.equal(afterEmpty.last.toolEvents.tool, 'glob');
  });

  // 防御性归一：若平台改回对象载荷，计数仍应工作（不静默失效）
  await fire(ctx, 'tools/result', { exec: { name: 'compat-probe', arguments: {} } }, {});
  const afterCompat = store.getSnapshot();
  check('兼容对象载荷（防御性归一）仍计数', () => {
    assert.equal(afterCompat.counters.toolEvents, 4);
  });

  await fire(ctx, 'agent/turn-stopping', {
    agent: { session: { header: {}, seq: 1, eventAt: () => undefined } },
  });
  const afterStop = store.getSnapshot();
  check('agent/turn-stopping 后 stops 计数 +1', () => {
    assert.equal(afterStop.counters.stops, 1);
  });

  check('快照字段完整（vaultPath / counters / enabled）', () => {
    assert.equal(afterStop.vaultPath, DEFAULT_VAULT_PATH);
    assert.ok(afterStop.counters && typeof afterStop.counters === 'object');
    assert.ok(afterStop.enabled && typeof afterStop.enabled === 'object');
  });

  const refreshed = await store.refreshSnapshot();
  check('refreshSnapshot 返回最新快照', () => {
    assert.ok(refreshed, 'refreshSnapshot 返回 null');
    assert.equal(refreshed.counters.sessionStarts, 1);
  });

  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log('');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.title}${r.detail ? `  <- ${r.detail}` : ''}`);
  }
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
