// Obsidian Bridge 插件核心逻辑单元测试。
// 运行：node test/run-all.mjs（推荐，会自动 stage 到 profile 以解析 schemastery）
//       或 node test/run.mjs（需已具备该解析环境，见 README「验证」一节）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(BUNDLE, rel)).href);
const { resolveConfig, scriptPath, DEFAULT_VAULT_PATH } = await mod('lib/config.js');
const { extractKeywords, queryIndex, formatKnowledgeContext } = await mod('lib/query.js');
const {
  createInjectedUserMessage,
  isRealUserMessage,
  isSubagent,
  messageText,
} = await mod('lib/message.js');
const { buildVaultIndex, parseFrontmatter } = await mod('lib/vault-index.js');

// Vault 路径一律 env 驱动：默认取 `lib/config.js` 的 DEFAULT_VAULT_PATH（单一事实来源），
// 部署者可用 OBSIDIAN_VAULT_PATH 覆盖 —— 与 acceptance.mjs / e2e-verify.mjs / run-all.mjs 一致。
// 公开仓库的使用者不应被迫使用作者本机的路径。
const VAULT = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ok - ${label}`);
};

// ---------- Config ----------
{
  const cfg = resolveConfig({});
  // `resolveConfig({})` 不读环境变量，返回的是 config.js 里的默认常量 ——
  // 因此这里必须断言 DEFAULT_VAULT_PATH，而不是上面的 VAULT（后者含 env 覆盖）。
  assert.equal(cfg.vaultPath, DEFAULT_VAULT_PATH);
  assert.equal(cfg.inject.limit, 3);
  // `governance.everyStops` 已在 v1.0.0 移除：治理由 bridge.js 自行在 stop 时触发，
  // 插件侧从未读取该字段（死配置）。见 lib/config.js 的注释。
  assert.equal(cfg.governance.documented, true);
  assert.equal(cfg.enabled.prompt, true);
  ok('resolveConfig 提供完整默认值');
}
{
  const cfg = resolveConfig({ vaultPath: 'E:/Other', inject: { limit: 7 }, enabled: { stop: false } });
  assert.equal(cfg.vaultPath, 'E:/Other');
  assert.equal(cfg.inject.limit, 7);
  assert.equal(cfg.enabled.stop, false);
  assert.equal(cfg.enabled.prompt, true);
  ok('resolveConfig 尊重显式覆盖');
}
{
  const cfg = resolveConfig({ vaultPath: VAULT });
  assert.equal(scriptPath(cfg, '90_Agent/hooks/bridge.js'), `${VAULT}/90_Agent/hooks/bridge.js`);
  ok('scriptPath 拼出 Vault 内绝对路径');
}

// ---------- message ----------
{
  const message = createInjectedUserMessage('正文内容', 3);
  assert.equal(message.role, 'user');
  assert.equal(message.id.length, 36);
  assert.deepEqual(message.content, [{ type: 'text', text: '正文内容' }]);
  assert.equal(message.source.kind, 'runtime-context');
  assert.equal(message.source.form, 'snapshot');
  assert.equal(message.source.sections[0].name, 'obsidian-knowledge');
  assert.ok(Object.isFrozen(message));
  ok('createInjectedUserMessage 形状与不可变性符合 dsh-llm 约定');
}
{
  const real = { role: 'user', source: { kind: 'user' }, content: [] };
  const injected = createInjectedUserMessage('x', 1);
  assert.ok(isRealUserMessage(real));
  assert.ok(!isRealUserMessage(injected));
  assert.ok(!isRealUserMessage({ role: 'user', source: { kind: 'runtime-context' }, content: [] }));
  ok('isRealUserMessage 能区分真实用户输入与注入消息');
}
{
  const subagent = { session: { header: { origin: 'subagent', delegationDepth: 1 } } };
  const parent = { session: { header: { delegationDepth: 0 } } };
  assert.ok(isSubagent(subagent));
  assert.ok(!isSubagent(parent));
  ok('isSubagent 识别子代理');
}
{
  const message = { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] };
  assert.equal(messageText(message), 'hello world');
  ok('messageText 拼接文本块');
}

// ---------- frontmatter ----------
{
  const { data, body } = parseFrontmatter('---\ntitle: 测试\ntags:\n  - a\n  - b\n---\n正文');
  assert.equal(data.title, '测试');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.equal(body, '正文');
  ok('parseFrontmatter 解析键值与列表');
}

// ---------- 关键词 / 检索 ----------
{
  const keywords = extractKeywords('WorkBuddy 无法 hook，需要 MCP 桥接方案', 2);
  assert.ok(keywords.length > 0 && keywords.length <= 5);
  ok(`extractKeywords 提取关键词 -> ${JSON.stringify(keywords)}`);
}
{
  const keywords = extractKeywords('a b c', 2);
  assert.deepEqual(keywords, []);
  ok('extractKeywords 过滤短词');
}
{
  const index = [
    { path: '30_Resources/experience/KB-1_桥接.md', title: 'MCP 桥接方案', summary: '用 MCP 连接', tags: ['MCP'], category: 'experience', created: '2026-10-20T10:00:00Z', updated: '2026-10-20T11:00:00Z', project: 'WorkBuddy-Obsidian-Bridge', permission: { scope: 'private', agent: 'default' }, body: '本文讨论 MCP 桥接与 hook 替代方案。' },
    { path: '30_Resources/topic/KB-2_其他.md', title: '无关笔记', summary: '内容', tags: ['other'], category: 'topic', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', project: '', permission: { scope: 'private', agent: 'default' }, body: '完全无关的内容。' },
  ];
  const results = queryIndex(index, { keywords: ['MCP', '桥接'], limit: 3 });
  assert.equal(results.length, 1);
  assert.ok(results[0].confidence >= 0.6);
  assert.ok(results[0].confidence <= 1);
  ok(`queryIndex 关键词检索 -> confidence=${results[0].confidence}`);

  const empty = queryIndex(index, { keywords: ['不存在的词xyz'], limit: 3 });
  assert.equal(empty.length, 0);
  ok('queryIndex 无匹配返回空数组');

  const byCategory = queryIndex(index, { category: 'topic', limit: 5 });
  assert.equal(byCategory.length, 1);
  assert.equal(byCategory[0].category, 'topic');
  ok('queryIndex 分类过滤');

  const formatted = formatKnowledgeContext(results);
  assert.ok(formatted.startsWith('## 知识库相关笔记（自动注入）'));
  assert.ok(formatted.includes('30_Resources/experience/KB-1_桥接.md'));
  ok('formatKnowledgeContext 生成注入上下文');

  assert.equal(formatKnowledgeContext([]), '');
  ok('formatKnowledgeContext 空结果返回空串');
}

// ---------- 真实 Vault 索引 ----------
{
  const fsTarget = (p) => ({
    targetKey: `key:${p}`,
    displayPath: p,
  });
  const ctx = {
    fs: {
      async resolve(p) {
        return fsTarget(p);
      },
      async stat(t) {
        return fs.existsSync(t.displayPath)
          ? { type: 'directory', size: 0 }
          : undefined;
      },
      async listDir(t) {
        const full = t.displayPath;
        if (!fs.existsSync(full)) return [];
        return fs
          .readdirSync(full, { withFileTypes: true })
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            target: fsTarget(path.join(full, entry.name)),
            size: entry.isFile() ? fs.statSync(path.join(full, entry.name)).size : undefined,
          }));
      },
      async readText(t) {
        return fs.readFileSync(t.displayPath, 'utf-8');
      },
    },
  };
  // v1.0.0 起 buildVaultIndex 返回 { entries, ok, failedRoots }，
  // 以便区分「扫描失败」与「空 Vault」（此前都是 []，面板无法分辨）。
  const built = await buildVaultIndex(ctx, VAULT);
  assert.equal(built.ok, true, `扫描应成功，failedRoots=${JSON.stringify(built.failedRoots)}`);
  assert.ok(Array.isArray(built.entries), 'entries 应为数组');
  const index = built.entries;
  assert.ok(index.length > 0, `索引应有实际条目，实际 ${index.length}`);
  ok(`buildVaultIndex 扫描真实 Vault -> ${index.length} 条（ok=${built.ok}）`);

  const sample = index[0];
  assert.ok(sample.path.endsWith('.md'));
  assert.ok(sample.title.length > 0);
  ok(`索引条目字段完整 -> ${sample.path}`);

  const keywords = extractKeywords('Obsidian 桥接 MCP', 2);
  const results = queryIndex(index, { keywords, limit: 3 });
  console.log(`      真实 Vault 检索「Obsidian 桥接 MCP」-> ${results.length} 条`);
  for (const r of results) console.log(`        - [${r.confidence}] ${r.path}`);
  ok('真实 Vault 关键词检索');

  // ---------- 索引对账：独立复算，不复用 vault-index.js ----------
  //
  // 此前的审计探针（已删除的 audit-vault-count.mjs）只做一次性人工比对，
  // 没有任何常驻断言保证「索引条数」与「Vault 实际 .md 数」一致 ——
  // 过滤规则（SCAN_ROOTS / 隐藏项 / 256KB / 深度上限）一旦漂移，面板会长期显示错数。
  // 这里按同一组规则**独立实现**复算（不复用 lib/vault-index.js），形成对账。
  const recount = (root, depth, acc, skipped) => {
    if (depth > 8 || acc.length >= 5000) return;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (acc.length >= 5000) return;
      if (e.name.startsWith('.')) { skipped.dot += 1; continue; }
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        recount(full, depth + 1, acc, skipped);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (fs.statSync(full).size > 256 * 1024) { skipped.oversize += 1; continue; }
        acc.push(full);
      }
    }
  };
  const recounted = [];
  const skipped = { dot: 0, oversize: 0 };
  for (const root of ['30_Resources', '10_Projects', '00_InteractionLogs', '00_MOC']) {
    const full = path.join(VAULT, root);
    try {
      if (fs.statSync(full).isDirectory()) recount(full, 0, recounted, skipped);
    } catch {
      // 根目录不存在属正常（与 vault-index.js 一致跳过）
    }
  }
  assert.equal(
    index.length,
    recounted.length,
    `索引条数（${index.length}）应与按 SCAN_ROOTS 规则独立复算的 .md 数（${recounted.length}）一致；`
      + `跳过 dot=${skipped.dot} oversize=${skipped.oversize}`,
  );
  ok(`索引条数与独立复算一致（${index.length} 条，跳过 dot=${skipped.dot}/oversize=${skipped.oversize}）`);
}

// ---------- parseEntry 边界（交叉评审 D1）----------
//
// 空值 frontmatter 键（`summary:`）会被 parseFrontmatter 解析成 `[]`，
// 而 `[] || x` 得到的是 `[]`（真值），随后 `[].substring` 抛 TypeError。
// 该异常被 walk() 的 catch 吞掉 → **笔记静默从索引里消失**，日志/计数/面板全无异常。
// 这四条断言锁定修复，防止回归。
{
  const { parseEntry } = await mod('lib/vault-index.js');
  const cases = [
    ['空 summary', '---\ntitle: T\nsummary:\n---\n正文内容', '正文内容'],
    ['缺失 summary', '---\ntitle: T\n---\n正文内容', '正文内容'],
    ['正常 summary', '---\ntitle: T\nsummary: 这是摘要\n---\n正文', '这是摘要'],
    ['数字 summary', '---\ntitle: T\nsummary: 12345\n---\n正文', '12345'],
  ];
  for (const [name, content, expectInSummary] of cases) {
    let entry = null;
    let error = null;
    try {
      entry = parseEntry(content, 'D:/MyVault/30_Resources/_t.md');
    } catch (e) {
      error = e;
    }
    assert.ok(error === null, `${name}：parseEntry 不应抛错（${error?.message ?? ''}）`);
    assert.ok(entry !== null, `${name}：应返回索引记录`);
    assert.ok(
      String(entry.summary).includes(expectInSummary),
      `${name}：summary 应含「${expectInSummary}」，实际 ${JSON.stringify(entry.summary)}`,
    );
  }
  ok('parseEntry 对空/缺失/正常/数字 summary 均不抛错（交叉评审 D1 回归）');
}

console.log(`\n全部通过：${passed} 项`);
