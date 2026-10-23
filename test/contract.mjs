/**
 * 平台契约测试：核对本插件的事件处理器签名与 DSH 声明一致。
 *
 * ## 为什么需要这个测试
 *
 * `tools/result` 的处理器曾写成 `({ exec }) => {}`（解构对象），但 DSH 派发的是
 * **位置参数** `(exec, result)`。后果是解构得到 `undefined` → 处理器**静默失效**
 * （计数恒 0、`post-tool` 留痕全丢），而所有单元测试因为**按错误签名调用**而一直
 * "通过" —— 属于假阳性测试的第二种形态：**按错误的调用约定调用被测代码**。
 *
 * 本测试从 DSH 的 `api-catalog.js` 读取每个事件的 `signature` 字段（平台权威声明），
 * 与 `index.js` 里实际的处理器形参做比对。平台升级改变签名时会立即失败。
 *
 * ## 覆盖范围
 * - 只核对**本插件实际监听**的事件。
 * - 目录文件不存在时**跳过并明确报告**（不伪装成通过）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** DSH 安装目录（含各包的 api-catalog.js）。 */
const DSH_APP = process.env.DSH_APP_DIR
  || '<DSH_APP_DIR>';

/** 本插件监听的事件。 */
const LISTENED_EVENTS = ['agent/created', 'agent/pre-step', 'tools/result', 'agent/turn-stopping'];

/**
 * 在 DSH 各包里查找某个事件的签名声明。
 *
 * 目录里的声明形如（注意整体是一个**转义过的单引号字符串**）：
 *   signature: '\'tools/result\'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined',
 * 因此不能直接匹配 `signature: 'tools/result'(`，要先把字符串内容取出来再解析。
 * @param event - 事件名。
 * @returns `{ params, source }`；找不到时返回 null。
 */
function findSignature(event) {
  const root = path.join(DSH_APP, 'node_modules', '@deepseek-ai');
  if (!fs.existsSync(root)) return null;
  for (const pkg of fs.readdirSync(root)) {
    const catalog = path.join(root, pkg, 'lib', 'types', 'api-catalog.js');
    if (!fs.existsSync(catalog)) continue;
    const text = fs.readFileSync(catalog, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.includes('signature:')) continue;
      // 取出 signature 的字符串内容（含 \' 转义）
      const m = line.match(/signature:\s*'((?:[^'\\]|\\.)*)'/);
      if (!m) continue;
      const decoded = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (!decoded.startsWith(`'${event}'`)) continue;
      const paren = decoded.match(/\(([^)]*)\)/);
      if (!paren) continue;
      return { params: paren[1], source: `${pkg}/lib/types/api-catalog.js` };
    }
  }
  return null;
}

/**
 * 解析形参列表，正确处理解构里的逗号与嵌套括号。
 * @param raw - 括号内的原始文本。
 * @returns 形参名数组（保留解构原文）。
 */
function splitParams(raw) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 解析 index.js 里某个事件处理器的形参列表。
 * @param event - 事件名。
 * @returns 形参名数组；未找到时返回 null。
 */
function findHandlerParams(event) {
  const text = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
  const re = new RegExp(`ctx\\.on\\(\\s*'${event.replace(/[/\\]/g, '\\$&')}'\\s*,\\s*(?:async\\s*)?\\(([^)]*)\\)`);
  const m = text.match(re);
  if (!m) return null;
  return splitParams(m[1]);
}

/** 签名里的业务参数（去掉 `this`），保留类型信息。 */
function businessParams(signatureParams) {
  return splitParams(signatureParams)
    .filter((s) => s && !s.startsWith('this'))
    .map((s) => ({ name: s.split(':')[0].trim(), type: s.slice(s.indexOf(':') + 1).trim() }));
}

const results = [];
const check = (title, fn) => {
  try {
    fn();
    results.push({ title, status: 'PASS' });
  } catch (error) {
    results.push({ title, status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] });
  }
};

const skipped = [];
for (const event of LISTENED_EVENTS) {
  const sig = findSignature(event);
  const params = findHandlerParams(event);

  if (!sig) {
    skipped.push(`${event}：api-catalog 未声明（平台目录缺失或事件为内部事件）`);
    continue;
  }
  if (!params) {
    check(`${event}：index.js 应注册处理器`, () => {
      throw new Error(`未在 index.js 找到 ctx.on('${event}', ...)`);
    });
    continue;
  }

  const expected = businessParams(sig.params);
  check(`${event}：处理器形参数 = ${expected.length}（${expected.map((p) => p.name).join(', ')}）`, () => {
    assert.equal(
      params.length,
      expected.length,
      `形参数不匹配：index.js 写的是 (${params.join(', ')})，`
      + `平台声明 (${sig.params}) [${sig.source}]。`,
    );
  });

  /**
   * 解构合法性：**逐个形参**按其平台声明类型判断。
   *
   * - 平台把该参数声明为**对象类型**（`payload: { ... }`）→ 解构安全。
   * - 平台把它声明为标量/实例（`exec: Readonly<ToolExecution>`）→ 解构会得到
   *   `undefined`，处理器静默失效。这正是 `tools/result` 曾经的 bug。
   */
  check(`${event}：解构用法与平台声明类型一致`, () => {
    params.forEach((p, i) => {
      const isDestructuring = p.startsWith('{') || p.startsWith('[');
      if (!isDestructuring) return;
      const declared = expected[i];
      const declaredType = declared?.type ?? '';
      const isObjectType = /^\{[\s\S]*\}$/.test(declaredType)
        || /^Readonly\s*\{/.test(declaredType);
      assert.ok(
        isObjectType,
        `第 ${i + 1} 个形参 "${p}" 是解构形式，但平台把该位置声明为`
        + ` "${declared?.name}: ${declaredType}"（非对象类型）。`
        + `\n平台完整签名：(${sig.params}) [${sig.source}]`
        + '\n解构非对象参数会得到 undefined，处理器将静默失效。',
      );
    });
  });
}

// ---- 反向检查：位置参数事件必须真的能取到工具名 ----
check('tools/result 是位置参数事件（防回归）', () => {
  const sig = findSignature('tools/result');
  if (!sig) return; // 平台目录缺失时跳过
  assert.ok(
    businessParams(sig.params).length >= 2,
    `tools/result 应声明至少 2 个业务参数，实际 (${sig.params})`,
  );
});

const passed = results.filter((r) => r.status === 'PASS').length;
console.log('');
for (const r of results) {
  console.log(`  [${r.status}] ${r.title}${r.detail ? `\n           ${r.detail}` : ''}`);
}
if (skipped.length > 0) {
  console.log('\n  [SKIP] 以下事件未在平台目录找到声明（不计入通过数，也不伪装成通过）：');
  for (const s of skipped) console.log(`         ${s}`);
}
console.log(`\n契约测试通过 ${passed}/${results.length}`);

// **SKIP 不能是免费的**（交叉评审 FP-1）。
//
// 此前只要平台目录缺失，4 条签名检查就全部静默消失，输出
// 「契约测试通过 1/1」+ exit 0 —— 一个断言都没跑，却是绿灯。
// 这正是本项目反复出现的「隐性失效等于不存在」。
// 规则：本插件**监听的每一个事件**都必须在平台目录里找到声明；
// 找不到就是失败（平台目录配错 / 事件改名 / 拼写错误），不是跳过。
const missingDeclarations = LISTENED_EVENTS.filter((e) => !findSignature(e));
if (missingDeclarations.length > 0) {
  console.error(
    `\n❌ 以下监听的事件在平台目录里找不到签名声明：${missingDeclarations.join(', ')}`
    + `\n   DSH_APP_DIR=${DSH_APP_DIR}`
    + '\n   这通常意味着平台目录配错、事件被改名、或本插件监听了不存在的事件。',
  );
  process.exit(1);
}
if (skipped.length > 0) {
  // 走到这里说明 skipped 里只有「内部事件」类，但 LISTENED_EVENTS 已全部命中，
  // 因此正常情况下 skipped 必为空；若非空则属异常，同样失败。
  console.error(`\n❌ 存在未预期跳过的检查：${skipped.join(' | ')}`);
  process.exit(1);
}
console.log(`  平台声明核对：${LISTENED_EVENTS.length}/${LISTENED_EVENTS.length} 个监听事件全部找到声明 ✅`);
process.exit(results.every((r) => r.status === 'PASS') ? 0 : 1);
