/**
 * 配置一致性守卫。
 *
 * 背景（交叉评审 FN-4）：插件里有些值必须与 `cordis.patch.yml` 保持一致，
 * 但此前它们是**两处独立声明**，漂移后不会报错，只会静默失效：
 *
 * - `OBSIDIAN_MCP_SERVER`（`index.js`）vs patch 的 `serverName`
 *   → 漂移后 `countMcpTools()` 前缀匹配恒为空，面板显示「未加载」却不报错
 *
 * 本测试把这类「必须一致」的配对显式列出来并断言，让漂移变成**测试失败**
 * 而不是**用户困惑**。
 *
 * ## 用法
 *   node test/config-consistency.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];

/**
 * 执行一项检查。
 *
 * **必须 await**：`check` 是 async，不加 await 时断言体根本不会执行，
 * 会立即判 PASS —— 那是**假阳性**（本项目踩过两次的那类）。
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

/** 粗提取 `cordis.patch.yml` 里 `obsidian-mcp` 段的 `serverName`。 */
function readPatchServerName() {
  const text = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf-8');
  const idx = text.indexOf('id: obsidian-mcp');
  assert.ok(idx >= 0, 'cordis.patch.yml 缺少 id: obsidian-mcp 段');
  const section = text.slice(idx, idx + 800);
  const m = section.match(/serverName:\s*([^\s#]+)/);
  assert.ok(m, 'cordis.patch.yml 的 obsidian-mcp 段缺少 serverName');
  return m[1];
}

/** 读插件导出的 MCP server 常量。 */
async function readPluginServerName() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  return mod.OBSIDIAN_MCP_SERVER;
}

/** Vault 根目录。 */
function vaultRoot() {
  return process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';
}

async function main() {
  // ---- 1. MCP server 名一致 ----
  await check('index.js 的 OBSIDIAN_MCP_SERVER === patch 的 serverName', async () => {
    const fromPatch = readPatchServerName();
    const fromPlugin = await readPluginServerName();
    assert.equal(
      fromPlugin,
      fromPatch,
      `插件常量 "${fromPlugin}" 与 cordis.patch.yml 的 serverName "${fromPatch}" 不一致。`
        + '\n漂移后 countMcpTools() 的前缀匹配会恒为空，面板显示「未加载」却不报错。',
    );
  });

  // ---- 2. 整理脚本存在 ----
  // `index.js` 用 scriptPath(cfg, '90_Agent/knowledge-organize.js') 调整理脚本，
  // 该文件不存在会让整理静默失败（D2 的同型问题）。
  await check('knowledge-organize.js 存在于 Vault', () => {
    const rel = '90_Agent/knowledge-organize.js';
    assert.ok(fs.existsSync(path.join(vaultRoot(), rel)), `整理脚本不存在：${rel}`);
  });

  // ---- 3. 桥接脚本存在 ----
  await check('90_Agent/hooks/bridge.js 存在于 Vault', () => {
    const rel = '90_Agent/hooks/bridge.js';
    assert.ok(fs.existsSync(path.join(vaultRoot(), rel)), `桥接脚本不存在：${rel}`);
  });

  // ---- 4. 文档 vs 实现的配置键一致 ----
  // `docs/CONFIG.md` 里描述的配置项必须在 Config schema 里真实存在，
  // 否则文档会描述一个不生效的开关（D3 的 HMAC 就是这类问题）。
  await check('docs/CONFIG.md 提到的配置键在 schema 中可解析', async () => {
    const { resolveConfig } = await import(pathToFileURL(path.join(ROOT, 'lib/config.js')).href);
    const cfg = resolveConfig({});
    const doc = fs.readFileSync(path.join(ROOT, 'docs/CONFIG.md'), 'utf-8');

    const requiredPaths = [
      ['organize', 'enabled'],
      ['organize', 'batchLimit'],
      ['organize', 'minIntervalMs'],
      ['enabled', 'diagnose'],
      ['hmacSecretEnv', undefined],
    ];
    for (const [a, b] of requiredPaths) {
      const value = b === undefined ? cfg[a] : cfg[a]?.[b];
      assert.ok(
        value !== undefined,
        `docs/CONFIG.md 描述了 ${a}${b ? `.${b}` : ''}，但 resolveConfig() 不产出它 —— 文档与实现不一致`,
      );
    }
    for (const key of ['enabled', 'batchLimit', 'minIntervalMs']) {
      assert.ok(doc.includes(key), `docs/CONFIG.md 未提及 organize.${key}`);
    }
  });

  // ---- 5. 计数器声明 vs 使用 ----
  // `lib/status.js` 的 COUNTER_KEYS 里每个键都应该至少在 index.js 里被 record 过。
  // 反向：index.js 里 record 的键必须已声明（否则快照键集会在运行时变化）。
  await check('COUNTER_KEYS 与 index.js 的 record 调用一致', async () => {
    const statusSrc = fs.readFileSync(path.join(ROOT, 'lib/status.js'), 'utf-8');
    const declared = [...statusSrc.matchAll(/^\s*'([a-zA-Z]+)',$/gm)].map((m) => m[1]);
    assert.ok(declared.length > 0, '未能从 lib/status.js 解析出 COUNTER_KEYS');

    const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf-8');
    const used = [...indexSrc.matchAll(/status\.record\('([a-zA-Z]+)'/g)].map((m) => m[1]);

    const undeclared = [...new Set(used)].filter((k) => !declared.includes(k));
    assert.deepEqual(
      undeclared,
      [],
      `index.js 记录了未声明的计数器：${undeclared.join(', ')}`
        + '\n这会让快照的 counters 键集在运行时变化（启动时 N 键、首次事件后 N+1 键）。',
    );
  });

  // ---- 输出 ----
  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log('');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.title}${r.detail ? `\n           ${r.detail}` : ''}`);
  }
  console.log(`\n配置一致性通过 ${passed}/${results.length}`);
  return results.every((r) => r.status === 'PASS');
}

// await 必须在 main 里 —— 否则异步检查的断言体根本不会执行
main().then((ok) => process.exit(ok ? 0 : 1));
