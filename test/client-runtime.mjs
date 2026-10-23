/**
 * Client 半边运行时测试。
 *
 * ## 为什么需要它
 *
 * `client.js` 是浏览器模块，此前覆盖率 0%（Node 触不到）。
 * 但它的结构是标准的 bundle 工厂：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * ```
 *
 * 因此在 Node 里**可以真正运行它** —— 只要提供：
 * - 一个 mock `window.__ModuleLoader__`
 * - 一个 mock `require`（返回假 React）
 *
 * 这不是「文本级断言」，而是**真的执行了 Client 半边的代码**：
 * 顶层语句、`apply()`、面板组件的渲染、`unwrap()` 解包、错误分支都会跑到。
 *
 * ## 用法
 *   node test/client-runtime.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 每项检查的结果。
 * @type {Array<{title: string, status: string, detail?: string}>}
 */
const results = [];

/**
 * 执行一项检查。
 *
 * **必须 async + await**：此前是同步 `check()`，传 async 函数时断言体
 * 返回的 Promise 从不被等待 —— 断言根本没跑，却立即判 PASS。
 * 这是**假阳性**（本项目踩过两次的同型问题），负向对照会立刻暴露它。
 * @param title - 检查项名称。
 * @param fn - 检查体（可 async）。
 */
async function check(title, fn) {
  try {
    await fn();
    results.push({ title, status: 'PASS' });
  } catch (error) {
    results.push({ title, status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] });
  }
}

// ============================================================
// 最小 React 实现（足够跑通 Panel 的渲染）
// ============================================================

/** 元素树节点。 */
function makeElement(type, props, children) {
  return { type, props: props ?? {}, children: children ?? [] };
}

/**
 * 极简 React：`createElement` 返回普通对象树，hooks 用「当前渲染上下文」实现。
 *
 * 目的不是模拟 React 的全部语义，而是让 Panel 的函数体**真的执行一遍** ——
 * 条件分支、字段访问、字符串拼接都会跑到，抛错就会被捕获。
 */
function createMockReact() {
  const hookState = { index: 0, values: [] };

  const reset = () => {
    hookState.index = 0;
    hookState.values = [];
  };

  /**
   * 只重置索引、保留已存的值。
   *
   * 模拟 React 的重新渲染：组件函数会**从头再执行一遍**，
   * `useState` 按顺序取回上次的值。若用 `reset()`（连值一起清），
   * 第二次渲染会拿到全新的初始值 —— 状态更新就看不到了。
   */
  const resetIndex = () => {
    hookState.index = 0;
  };

  const createElement = (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
    return makeElement(typeof type === 'function' ? type.name || 'anon' : String(type), props, flat);
  };

  const useEffect = (fn) => {
    // 记录 effect，测试按需手动触发
    hookState.values[hookState.index] = { effect: fn };
    hookState.index += 1;
  };

  const useState = (initial) => {
    const i = hookState.index;
    hookState.index += 1;
    if (!(i in hookState.values)) {
      hookState.values[i] = { value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = hookState.values[i];
    const setValue = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
    };
    return [slot.value, setValue];
  };

  return { createElement, useEffect, useState, reset, resetIndex, hookState };
}

// ============================================================
// 加载 Client 半边
// ============================================================

/**
 * 在 vm 里执行 client.js，捕获它注册的 bundle。
 * @returns `{ spec, factory }`
 */
function loadClientBundle() {
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf-8');
  let captured = null;
  const sandboxWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  const context = vm.createContext({
    window: sandboxWindow,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    React: undefined, // 由 require 提供
  });
  vm.runInContext(source, context, { filename: 'client.js' });
  assert.ok(captured, 'client.js 未调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, '@local/obsidian-bridge');
  assert.equal(typeof captured.factory, 'function');
  return captured;
}

// ============================================================
// 测试
// ============================================================

const bundle = loadClientBundle();
const React = createMockReact();

/** 执行 factory，返回 module.exports。 */
function instantiate() {
  let exported = null;
  const fakeRequire = () => React;
  const moduleObj = { exports: {} };
  const result = bundle.factory.call(
    { exports: moduleObj.exports, module: moduleObj },
    fakeRequire,
  );
  exported = result ?? moduleObj.exports;
  return exported;
}

const client = instantiate();

// 检查必须在 async main 里 await，否则异步断言不执行 → 假阳性
async function main() {
  await check('client.js 顶层执行无抛错', () => {
    assert.ok(client, 'factory 应返回 module.exports');
  });

  await check('导出 apply / inject / name', () => {
    assert.equal(typeof client.apply, 'function', '缺少 exports.apply');
    assert.ok(Array.isArray(client.inject), '缺少 exports.inject 数组');
  assert.equal(typeof client.name, 'string', '缺少 exports.name');
});

await check('inject 含 slots 与 remote（缺 remote 会让 ctx.remote 抛 without inject）', () => {
  assert.ok(client.inject.includes('slots'), `inject 缺 "slots"：${client.inject.join(',')}`);
  assert.ok(client.inject.includes('remote'), `inject 缺 "remote"：${client.inject.join(',')}`);
});

await check('inject 不含 webServer（v1.0.0 已移除）', () => {
  assert.ok(!client.inject.includes('webServer'), 'inject 不应含 webServer');
});

// ---- apply()：槽位注册 ----
// 包进 main() 后不再需要独立代码块（否则多一个未闭合的 `{`）。
const sections = [];
const disposers = [];
const mounted = [];
const ctx = {
  effect: (fn) => {
    disposers.push(fn);
    return () => {};
  },
  inject: (keys, cb) => {
    // 模拟 remote.obsidianBridge 就绪
    const scope = { remote: { obsidianBridge: { status: async () => ({ ok: true, value: snapshotFixture() }) } } };
    const out = cb(scope);
    return { then: (resolve) => resolve(out), dispose: () => {} };
  },
    slots: {
      inject: (name, factory) => factory(),
      register: (opts, component) => {
        sections.push({ opts, component });
        return () => {};
      },
    },
    remote: {
      $mount: async (c) => {
        mounted.push(c);
        return () => {};
      },
    },
  };

  /** 构造一份快照 fixture（字段与真实快照一致）。 */
  function snapshotFixture() {
    return {
      vaultPath: 'D:/MyVault',
      enabled: { prompt: true, tool: true, stop: true, sessionStart: true, diagnose: false },
      inject: { enabled: true, limit: 3, minKeywordLength: 2 },
      organize: { enabled: true, batchLimit: 20, minIntervalMs: 300000 },
      governance: { documented: true },
      index: { size: 139, builtAt: 123, ok: true },
      counters: {
        prompts: 3,
        injections: 1,
        toolEvents: 5,
        stops: 1,
        sessionStarts: 4,
        writeFailures: 0,
        indexBuilt: 1,
        indexFailed: 0,
        organizeRuns: 2,
        organizeFailed: 0,
      },
      last: { toolEvents: { at: '2026-10-23T00:00:00.000Z', tool: 'pwsh' } },
      mcpTools: 15,
    };
  }

  const dispose = await client.apply(ctx);
  await check('apply() 返回 disposer', () => {
    assert.equal(typeof dispose, 'function', 'apply 应返回清理函数');
  });

  await check('apply() 注册了 settings.section', () => {
    assert.ok(sections.length > 0, '未注册任何 settings.section');
    const s = sections.find((x) => x.opts.id === 'obsidian-bridge');
    assert.ok(s, `未找到 id=obsidian-bridge 的 section，实际：${sections.map((x) => x.opts.id).join(',')}`);
    assert.equal(typeof s.component, 'function', 'section 应带组件函数');
  });

  await check('apply() 挂载了 Typert Remote 贡献', () => {
    assert.ok(mounted.length > 0, '未调用 ctx.remote.$mount');
    const c = mounted[0];
    assert.equal(c.package, '@local/obsidian-bridge');
    assert.ok(Array.isArray(c.descriptors) && c.descriptors.length > 0, 'descriptors 应为非空数组');
  });

  // ---- 面板渲染 ----
  const section = sections.find((x) => x.opts.id === 'obsidian-bridge');
  await check('Panel 组件可渲染且不抛错', () => {
    assert.equal(typeof section.component, 'function');
    React.reset();
    const tree = section.component({});
    assert.ok(tree && tree.type === 'div', 'Panel 应返回 div 元素树');
  });

  await check('Panel 渲染出标题「Obsidian 桥接」', () => {
    React.reset();
    const tree = section.component({});
    const text = JSON.stringify(tree);
    assert.ok(text.includes('Obsidian'), '渲染树应包含标题文本');
  });

  // ---- 数据解包（unwrap）----
  // Panel 的 useEffect 里会调 loadStatus() → remoteService.status() → unwrap。
  // **必须手动触发 effect 并等微任务**，否则断言跑在「还没取数」的空状态上 ——
  // 那样即使把 unwrap 的逻辑删掉，断言依然会 PASS（假阳性）。
  /**
   * 渲染 Panel，触发 effect，等异步取数完成，再渲染一次。
   * @returns 最终渲染树。
   */
  async function renderAndSettle(component) {
    React.reset();
    let tree = component({});
    // 手动触发 mock React 记录的 effect（真实 React 会在 commit 后调用）
    for (const slot of React.hookState.values) {
      if (slot && typeof slot.effect === 'function') {
        slot.effect();
      }
    }
    // 等 loadStatus() 的 Promise 链走完（status → unwrap → setState）
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 重新渲染：索引归零但保留已存的值（模拟 React 的 state 保留语义）
    React.resetIndex();
    tree = component({});
    return tree;
  }

  await check('Panel 能消费解包后的快照（{ok,value} → value）', async () => {
    React.reset();
    // 让 remoteService 已就绪：重新走一次 inject
    const ctx2 = {
      effect: () => () => {},
      inject: (keys, cb) => {
        cb({
          remote: {
            obsidianBridge: {
              status: async () => ({ ok: true, value: snapshotFixture() }),
            },
          },
        });
        return { then: (r) => r() };
      },
      slots: {
        inject: (name, factory) => factory(),
        register: (opts, component) => () => {},
      },
      remote: { $mount: async () => () => {} },
    };
    await client.apply(ctx2);
    const tree = await renderAndSettle(section.component);
    const text = JSON.stringify(tree);
    // 快照里的字段应出现在渲染树中
    assert.ok(text.includes('D:/MyVault'), '渲染树应包含 vaultPath');
  });

  // ---- 错误分支：unwrap 在 !ok 时应抛错 ----
  await check('Remote 返回 {ok:false} 时 Panel 走错误分支', async () => {
    const ctx3 = {
      effect: () => () => {},
      inject: (keys, cb) => {
        cb({
          remote: {
            obsidianBridge: {
              status: async () => ({
                ok: false,
                error: { code: 'gateway/service-unavailable', message: 'service missing' },
              }),
            },
          },
        });
        return { then: (r) => r() };
      },
      slots: {
        inject: (name, factory) => factory(),
        register: (opts, component) => () => {},
      },
      remote: { $mount: async () => () => {} },
    };
    await client.apply(ctx3);
    const tree = await renderAndSettle(section.component);
    const text = JSON.stringify(tree);
    assert.ok(
      text.includes('gateway/service-unavailable') || text.includes('暂时无法读取'),
      '错误分支应把错误信息渲染出来，而不是静默空白。'
        + '（若这条 PASS 是因为渲染树里根本没有错误文本，说明 effect 没被触发 —— 断言无效）',
    );
  });

  // ---- 输出（必须在所有 await check 之后）----
  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log('');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.title}${r.detail ? `\n           ${r.detail}` : ''}`);
  }
  console.log(`\nClient 运行时测试通过 ${passed}/${results.length}`);
  return results.every((r) => r.status === 'PASS');
}

main().then((ok) => process.exit(ok ? 0 : 1));
