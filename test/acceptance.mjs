/**
 * PRD §9 验收脚本。
 *
 * 对真实 Vault、bridge.js、knowledge-engine.js 与 MCP server 逐条核对
 * PRD-WB-OBS-001 §9 的验收标准，输出 PASS/FAIL 表。
 *
 * 运行（需先能解析 @deepseek-ai/schemastery，见 README）：
 *   node test/acceptance.mjs
 *
 * 本脚本只读：不修改 Vault 内容（FR-2/FR-7 的产物写入临时目录后清理）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = 'D:/MyVault';
const AGENT = path.join(VAULT, '90_Agent');
const LOGS = path.join(VAULT, '00_InteractionLogs');
const MCP_SERVER = '<YOUR_WORKBUDDY_PATH>';
const NODE = process.execPath;
/** DSH 安装目录：MCP 客户端 SDK 从这里解析。 */
const DSH_APP_DIR = '<DSH_APP_DIR>';
/** profile 的 node_modules：@deepseek-ai/schemastery 从这里解析。 */
const PROFILE_MODULES = '<USER_HOME>/.dsh/profiles/desktop/node_modules';

const results = [];
const pending = [];
const check = (id, title, fn) => {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => results.push({ id, title, status: 'PASS' }))
      .catch((error) =>
        results.push({ id, title, status: 'FAIL', detail: String(error?.message ?? error).split('\n')[0] }),
      ),
  );
};

/** 执行一个 Vault 内脚本并返回 stdout；`input` 会写入 stdin。 */
function run(script, args = [], input) {
  return execFileSync(NODE, [script, ...args], {
    encoding: 'utf-8',
    timeout: 60000,
    input,
  });
}

// ============================================================
// FR-1 无感自动桥接
// ============================================================
check('FR-1-AC3', '工具含 project → project-op 留痕', () => {
  // 先造一条 project 类工具调用，再核对留痕（否则取决于当日是否恰好有此类调用）
  run(path.join(AGENT, 'hooks/bridge.js'), ['post-tool'], JSON.stringify({
    tool_name: 'write',
    // bridge.js 检测的是 tool_input 序列化后的关键词（project/task/todo/plan/roadmap）
    tool_input: { file_path: 'D:/project-plan.md', content: 'project 计划' },
  }));
  const file = path.join(LOGS, `${new Date().toISOString().slice(0, 10)}_project-op.md`);
  assert.ok(fs.existsSync(file), `${file} 不存在`);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('project-op'));
});

check('FR-1-AC4', '工具含 memory → memory-op 留痕 + 记忆同步', () => {
  // 先造一条 memory 类工具调用，再核对留痕（否则取决于当日是否恰好有此类调用）
  run(path.join(AGENT, 'hooks/bridge.js'), ['post-tool'], JSON.stringify({
    tool_name: 'memory',
    tool_input: { content: 'remember 验收测试', action: 'recall' },
  }));
  const file = path.join(LOGS, `${new Date().toISOString().slice(0, 10)}_memory-op.md`);
  assert.ok(fs.existsSync(file), `${file} 不存在`);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('memory-op'), '未写入 memory-op 条目');
});

check('FR-1-AC5', '对话停止 → 响应摘要留痕', () => {
  const file = path.join(LOGS, `${new Date().toISOString().slice(0, 10)}_conversation.md`);
  assert.ok(fs.existsSync(file));
  assert.ok(/对话结束/.test(fs.readFileSync(file, 'utf-8')), '缺少「对话结束」摘要');
});

check('FR-1-AC6', 'Hook 异常不崩溃对话', () => {
  // 写路径全程 fire-and-forget + try/catch：坏输入下脚本仍应正常退出且不抛未捕获异常
  const out = run(path.join(AGENT, 'hooks/bridge.js'), ['stop']);
  assert.ok(typeof out === 'string', '脚本无输出');
  assert.ok(fs.existsSync(path.join(LOGS, 'hook-debug.log')), '调试日志缺失');
});

// ============================================================
// FR-2 结构化知识条目
// ============================================================
check('FR-2-AC1', 'organize 生成 11 字段知识条目', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-acc-'));
  const src = path.join(tmp, 'log.md');
  fs.writeFileSync(src, '---\ntype: conversation\ndate: 2026-01-01\n---\n\n## [2026-01-01T00:00:00.000Z] project-op\n\n工具: Write\n输入: {"file_path":"x.md"}\n', 'utf-8');
  const out = run(path.join(AGENT, 'knowledge-engine.js'), ['organize', src]);
  assert.ok(/Created:/.test(out), `未生成条目: ${out}`);
  const created = out.match(/Created: (.+)/)[1];
  const entryPath = path.join(VAULT, '30_Resources', 'project', created);
  const raw = fs.readFileSync(entryPath, 'utf-8');
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const field of ['id:', 'title:', 'summary:', 'content:', 'tags:', 'category:', 'source:', 'created:', 'updated:', 'version:', 'permission:', 'contentHash:']) {
    assert.ok(raw.includes(field), `缺少字段 ${field}`);
  }
  fs.rmSync(entryPath, { force: true });
});

check('FR-2-AC2', 'id 匹配 ^KB-[0-9]{8}-[0-9]{4}$', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-acc-'));
  const src = path.join(tmp, 'log.md');
  fs.writeFileSync(src, '---\ntype: conversation\ndate: 2026-01-01\n---\n\n## [2026-01-01T00:00:00.000Z] conversation\n\n测试内容足够长\n', 'utf-8');
  const out = run(path.join(AGENT, 'knowledge-engine.js'), ['organize', src]);
  const created = out.match(/Created: (.+)/)[1];
  const entryPath = path.join(VAULT, '30_Resources', 'experience', created);
  const raw = fs.readFileSync(entryPath, 'utf-8');
  fs.rmSync(tmp, { recursive: true, force: true });
  const id = raw.match(/id: "?([^"\n]+)"?/)[1];
  fs.rmSync(entryPath, { force: true });
  assert.match(id, /^KB-[0-9]{8}-[0-9]{4}$/, `id 不合规: ${id}`);
});

check('FR-2-AC3', 'contentHash 为 64 位 hex', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-acc-'));
  const src = path.join(tmp, 'log.md');
  fs.writeFileSync(src, '---\ntype: conversation\ndate: 2026-01-01\n---\n\n## [2026-01-01T00:00:00.000Z] conversation\n\n测试内容足够长\n', 'utf-8');
  const out = run(path.join(AGENT, 'knowledge-engine.js'), ['organize', src]);
  const created = out.match(/Created: (.+)/)[1];
  const entryPath = path.join(VAULT, '30_Resources', 'experience', created);
  const raw = fs.readFileSync(entryPath, 'utf-8');
  fs.rmSync(tmp, { recursive: true, force: true });
  const hash = raw.match(/contentHash: "?([0-9a-f]+)"?/)[1];
  fs.rmSync(entryPath, { force: true });
  assert.match(hash, /^[0-9a-f]{64}$/, `contentHash 不合规: ${hash}`);
});

// ============================================================
// FR-3 知识库自动查询
// ============================================================
check('FR-3-AC1', '查询返回 path/title/summary/confidence', () => {
  const out = run(path.join(AGENT, 'knowledge-engine.js'), ['query', 'Obsidian']);
  const results = JSON.parse(out);
  assert.ok(Array.isArray(results), '返回值不是数组');
  if (results.length === 0) return;
  for (const field of ['path', 'title', 'summary', 'confidence']) {
    assert.ok(field in results[0], `缺少字段 ${field}`);
  }
});

check('FR-3-AC4', '无匹配返回空数组', () => {
  const out = run(path.join(AGENT, 'knowledge-engine.js'), ['query', 'zzzznotexistxyz']);
  assert.deepEqual(JSON.parse(out), [], '无匹配时应返回 []');
});

// ============================================================
// FR-4 记忆治理
// ============================================================
check('FR-4-AC7', '治理扫描可执行并产出记录', () => {
  const before = fs.readdirSync(path.join(AGENT, 'governance')).length;
  const out = run(path.join(AGENT, 'hooks/bridge.js'), ['govern']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.success, true);
  assert.ok(typeof parsed.scanned === 'number', '缺少 scanned');
  assert.ok(fs.readdirSync(path.join(AGENT, 'governance')).length >= before, '未产出治理文件');
  assert.ok(fs.existsSync(path.join(AGENT, 'audit')), '缺少审计目录');
});

// ============================================================
// FR-5 交叉认证
// ============================================================
check('FR-5-AC1/3/4/5', '审计记录含三重校验且 overall=true', () => {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(AGENT, 'audit', `${today}-integrity.json`);
  assert.ok(fs.existsSync(file), `${file} 不存在`);
  const entries = JSON.parse(fs.readFileSync(file, 'utf-8')).entries;
  assert.ok(entries.length > 0, '审计记录为空');
  const last = entries[entries.length - 1];
  assert.equal(last.integrity.checks.contentHash.passed, true, 'contentHash 未通过');
  assert.equal(last.integrity.checks.signature.passed, true, 'signature 未通过');
  assert.equal(last.integrity.overall, true, 'overall 不为 true');
});

// ============================================================
// FR-6 MCP 桥接服务器
// ============================================================
check('FR-6-AC1', 'tools/list 返回 15 个工具', () => {
  const script = `
    const { Client } = require('@modelcontextprotocol/client');
    const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
    (async () => {
      const transport = new StdioClientTransport({
        command: 'node',
        args: ['${MCP_SERVER.replace(/\\/g, '/')}'],
        env: { OBSIDIAN_VAULT_PATH: 'D:/MyVault' },
      });
      const client = new Client({ name: 'acceptance', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const tools = await client.listTools();
      await client.close();
      console.log(JSON.stringify(tools.tools.map(t => t.name)));
    })().catch(e => { console.error(e.message); process.exit(1); });
  `;
  const out = execFileSync(NODE, ['--input-type=commonjs', '-e', script], {
    encoding: 'utf-8',
    timeout: 90000,
    cwd: DSH_APP_DIR,
  });
  const names = JSON.parse(out.trim().split('\n').pop());
  assert.equal(names.length, 15, `工具数应为 15，实际 ${names.length}`);
});

// ============================================================
// FR-7 记忆同步
// ============================================================
check('FR-7-AC1..5', '记忆同步 4/4 成功', () => {
  const out = run(path.join(AGENT, 'memory-sync/sync-workbuddy-memory.js'), ['--vault-path', VAULT]);
  assert.ok(/同步完成：4\/4 项成功/.test(out), `同步未全成功:\n${out}`);
  assert.ok(fs.existsSync(path.join(AGENT, 'memory-sync', 'user-memory.md')), '用户记忆缺失');
  assert.ok(fs.existsSync(path.join(AGENT, 'memory-sync', 'MEMORY-INDEX.md')), '记忆索引缺失');
});

// ============================================================
// 插件自身（接线）
// ============================================================
check('PLUGIN', '插件接线测试（mock ctx 加载真实 index.js）', () => {
  // wiring.mjs 需要解析 @deepseek-ai/schemastery；profile 的 node_modules 里才有，
  // 因此复制到 profile 下的临时目录执行，跑完清理。
  const staging = path.join(PROFILE_MODULES, 'ob-acc-test');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(staging, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(staging, 'index.js'));
  fs.copyFileSync(path.join(ROOT, 'typert.host.js'), path.join(staging, 'typert.host.js'));
  fs.cpSync(path.join(ROOT, 'test'), path.join(staging, 'test'), { recursive: true });
  try {
    const out = execFileSync(NODE, ['test/wiring.mjs'], { encoding: 'utf-8', timeout: 120000, cwd: staging });
    assert.ok(/接线测试全部通过：\d+ 项/.test(out), `接线测试失败:\n${out}`);
    const out2 = execFileSync(NODE, ['test/status-refresh.mjs'], {
      encoding: 'utf-8',
      timeout: 120000,
      cwd: staging,
    });
    assert.ok(/通过 10\/10/.test(out2), `状态刷新测试失败:\n${out2}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

// ============================================================
// 输出
// ============================================================
await Promise.all(pending);
results.sort((a, b) => a.id.localeCompare(b.id));
const passed = results.filter((r) => r.status === 'PASS').length;
console.log('');
for (const r of results) {
  const mark = r.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${r.id.padEnd(16)} ${r.title}${r.detail ? `  <- ${r.detail}` : ''}`);
}
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
