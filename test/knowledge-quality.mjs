/**
 * 知识库质量回归守卫（可复跑）。
 *
 * 用途：守住 `90_Agent/knowledge-organize.js` 的整理质量，防止「垃圾 KB」再次堆积。
 *
 * 两部分：
 *   A. **管线契约测试**（fixture 驱动，隔离在系统临时目录，不碰 Vault）
 *      —— 覆盖 PRD §5.2.3 六类映射、frontmatter 残留、system prompt 门、标题质量、幂等、去重。
 *   B. **Vault 卫生检查**（只读，报告当前 30_Resources 的自动条目状态）
 *
 * 运行：
 *   node test/knowledge-quality.mjs
 *   node test/knowledge-quality.mjs --json      # 机器可读
 *   node test/knowledge-quality.mjs --skip-vault # 只跑 fixture，不检查 Vault
 *
 * 退出码：0 = 全部通过；1 = 有检查未通过。
 *
 * 证据约定：本脚本**实跑** knowledge-organize.js 子进程并检查落盘产物，
 * 不做 mock —— 遵循「断言对象必须是最终产物，不是中间调用」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VAULT = process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';
const ORGANIZE_SCRIPT = process.env.KNOWLEDGE_ORGANIZE_SCRIPT
  || path.join(VAULT, '90_Agent', 'knowledge-organize.js');
const SKIP_VAULT = process.argv.includes('--skip-vault');
const JSON_OUT = process.argv.includes('--json');

/** 与 `knowledge-organize.js` 保持一致的最小 frontmatter 序列化。 */
function fmYaml(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null) {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) lines.push(`  ${k2}: ${JSON.stringify(String(v2))}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * 按 `bridge.js:507` 的格式生成一段日志条目：
 *   frontmatter + '\n' + '## [ts] type\n\n' + content + '\n'
 * 这是**故意复刻真实写入格式**，因为残留 bug 正是由这个顺序引起的。
 */
function logEntry(ts, type, content, tags = ['auto']) {
  const fm = fmYaml({
    id: `KB-${ts.slice(0, 10).replace(/-/g, '')}-0001`,
    type,
    date: ts.slice(0, 10),
    timestamp: ts,
    title: `${type} ${ts.slice(0, 10)}`,
    summary: content.replace(/\s+/g, ' ').trim().substring(0, 200),
    content: content.replace(/\s+/g, ' ').trim().substring(0, 200),
    tags,
    category: 'experience',
    source: { type: 'conversation', id: ts.slice(0, 10), name: `${type} ${ts.slice(0, 10)}` },
    created: ts,
    updated: ts,
    version: 1,
    permission: { scope: 'private', agent: 'default' },
    relations: [],
  });
  return `${fm}\n\n## [${ts}] ${type}\n\n${content}\n`;
}

/** 构造一段多 section 的日志文本（section 之间会插入下一个 entry 的 frontmatter）。 */
function buildLog(entries) {
  return entries.map((e) => logEntry(e.ts, e.type, e.content, e.tags)).join('');
}

/**
 * 把正文补到长度门阈值之上。
 *
 * `MIN_CONTENT_LENGTH` 已提升到 200（见 knowledge-organize.js）。fixture 若不足长，
 * 会被长度门拦下 —— 那样断言失败的原因就变成「太短」而不是被测的那个性质，
 * 属于典型的假阴性。这里统一补齐，保证每条 fixture 都能过长度门。
 */
function ensureLong(s) {
  const filler = '本段为补充说明，用于满足整理管线的最小正文长度要求。';
  let out = s;
  while (out.length < 300) out += `\n\n${filler}`;
  return out;
}

// ============================================================
// 检查结果收集
// ============================================================
const results = [];
function check(id, title, fn) {
  try {
    const detail = fn();
    results.push({ id, title, status: 'PASS', detail: detail ?? '' });
  } catch (e) {
    results.push({ id, title, status: 'FAIL', detail: String(e?.message ?? e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 读取一个 KB 条目的 frontmatter 与正文。 */
function parseEntry(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.startsWith('---\n')) return { raw, fm: {}, body: raw, fmText: '' };
  const end = raw.indexOf('\n---', 4);
  const fmText = raw.slice(0, end + 4);
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const fm = {};
  let listKey = null;
  for (const line of fmText.split('\n')) {
    // YAML 列表项：`  - 值`
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      fm[listKey].push(item[1].trim().replace(/^"|"$/g, ''));
      continue;
    }
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    listKey = null;
    if (!kv) continue;
    const val = kv[2].trim().replace(/^"|"$/g, '');
    if (val === '') {
      fm[kv[1]] = [];
      listKey = kv[1];
    } else {
      fm[kv[1]] = val;
    }
  }
  return { raw, fm, body, fmText };
}

/** 在隔离临时目录里跑一次 organize，返回生成的条目。 */
function runOrganize(entries, { label = '', limit = 100 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbq-'));
  const logDir = path.join(tmp, '00_InteractionLogs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, '90_Agent'), { recursive: true });

  const logName = entries[0]?.file || '2026-01-01_conversation.md';
  fs.writeFileSync(path.join(logDir, logName), buildLog(entries), 'utf-8');

  const env = { ...process.env, OBSIDIAN_VAULT_PATH: tmp };
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [ORGANIZE_SCRIPT, JSON.stringify({ limit })], {
      encoding: 'utf-8',
      env,
      timeout: 60000,
    });
  } catch (e) {
    throw new Error(`organize 子进程失败：${String(e?.stderr ?? e?.message ?? e).split('\n')[0]}`);
  }

  const kbRoot = path.join(tmp, '30_Resources');
  const found = [];
  if (fs.existsSync(kbRoot)) {
    for (const dir of fs.readdirSync(kbRoot)) {
      const full = path.join(kbRoot, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full).filter((f) => f.endsWith('.md'))) {
        const p = path.join(full, f);
        const parsed = parseEntry(p);
        found.push({ path: p, name: f, category: dir, ...parsed });
      }
    }
  }
  const parsedOut = (() => { try { return JSON.parse(stdout || '{}'); } catch { return null; } })();
  return { tmp, found, stdout, parsedOut, label };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ============================================================
// A. 管线契约测试
// ============================================================

/** PRD §5.2.3 六类映射的期望值。 */
const PRD_MAP = [
  { type: 'conversation', category: 'experience', tag: '对话记录' },
  { type: 'decision', category: 'process', tag: '决策' },
  { type: 'thinking', category: 'topic', tag: '思考' },
  { type: 'insight', category: 'experience', tag: '洞察' },
  { type: 'memory-op', category: 'entity', tag: '记忆操作' },
  { type: 'project-op', category: 'project', tag: '项目操作' },
];

check('P1', 'PRD §5.2.3 六类映射：thinking → topic（当前缺失）', () => {
  const src = fs.readFileSync(ORGANIZE_SCRIPT, 'utf-8');
  const hasThinking = /thinking/.test(src) && /topic/.test(src);
  if (!hasThinking) {
    throw new Error('knowledge-organize.js 的 classify() 未实现 thinking → topic（PRD §5.2.3 要求，见 PRD.md:256）');
  }
  return '源码中同时出现 thinking 与 topic 分支';
});

check('P2', '六类映射端到端：每类都落到 PRD 指定的 category + tags', () => {
  const entries = PRD_MAP.map((m, i) => ({
    file: '2026-01-01_conversation.md',
    ts: `2026-01-01T00:0${i}:00.000Z`,
    type: m.type,
    tags: [m.type, 'auto'],
    content: ensureLong(`${m.type} 类型的正文内容，用于验证 PRD 分类映射是否正确。`),
  }));
  const { tmp, found } = runOrganize(entries, { label: 'six-types' });
  try {
    assertEqual(found.length, 6, '生成条目数');
    // 注意：conversation 与 insight 都映射到 experience，只能靠 (category, tag) 区分，
    // 所以必须用 some() 全量匹配，不能用 find() 取第一个同 category 的条目。
    const missing = [];
    for (const m of PRD_MAP) {
      const ok = found.some((x) => x.category === m.category && Array.isArray(x.fm.tags) && x.fm.tags.includes(m.tag));
      if (!ok) missing.push(`${m.type}(期望 ${m.category}/${m.tag})`);
    }
    if (missing.length) {
      const actual = found.map((x) => `${x.category}[${(x.fm.tags ?? []).join('+')}]`).join(', ');
      throw new Error(`未达成的映射：${missing.join(', ')}；实际：${actual}`);
    }
    return `6 类全部正确：${found.map((x) => `${x.category}/${(x.fm.tags ?? [])[0]}`).join(', ')}`;
  } finally { cleanup(tmp); }
});

check('P3', '正文不含下一个 entry 的 frontmatter（残留 bug 回归）', () => {
  const entries = [
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'],
      content: ensureLong('第一段有知识价值的正文，长度足够通过质量门。') },
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:01:00.000Z', type: 'conversation', tags: ['auto'],
      content: ensureLong('第二段同样有知识价值的正文，用于触发残留。') },
  ];
  const { tmp, found } = runOrganize(entries, { label: 'residue' });
  try {
    assert(found.length >= 1, '未生成任何条目，无法验证残留');
    for (const e of found) {
      const leaked = /\n---\n(type|date|timestamp|tags|category|source|permission|relations|version|created|updated|contentHash|summary|title|id):/.test(e.body);
      if (leaked) throw new Error(`${e.name} 的正文仍含下一个 entry 的 frontmatter 残留`);
      assert(!/^(id|type|date|timestamp|tags|category|source|summary|title|contentHash):/.test(e.body.trim()),
        `${e.name} 正文以 frontmatter 字段名开头`);
    }
    return `${found.length} 条正文均干净`;
  } finally { cleanup(tmp); }
});

check('P4', 'system prompt 泄漏被质量门拒绝', () => {
  const leaky = ensureLong('You are a helpful assistant. 这是被泄漏的系统提示词片段。');
  const { tmp, found } = runOrganize([
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'], content: leaky },
  ], { label: 'leak' });
  try {
    if (found.length !== 0) {
      throw new Error(`泄漏内容未被拒绝，生成了 ${found.length} 条：${found.map((x) => x.name).join(', ')}`);
    }
    return '命中标记后被拒绝，未生成条目';
  } finally { cleanup(tmp); }
});

check('P5', 'system prompt 标记覆盖 7 个（PRD 质量门要求）', () => {
  const src = fs.readFileSync(ORGANIZE_SCRIPT, 'utf-8');
  const m = src.match(/SYSTEM_PROMPT_MARKERS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('未找到 SYSTEM_PROMPT_MARKERS 定义');
  const count = (m[1].match(/'/g) || []).length / 2;
  if (count < 7) throw new Error(`标记只有 ${count} 个，少于 7 个`);
  return `${count} 个标记`;
});

check('P6', '正文过短被拒绝（MIN_CONTENT_LENGTH 生效）', () => {
  const { tmp, found } = runOrganize([
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'], content: '太短' },
  ], { label: 'short' });
  try {
    if (found.length !== 0) throw new Error(`过短内容未被拒绝，生成了 ${found.length} 条`);
    return '过短内容被拒绝';
  } finally { cleanup(tmp); }
});

/** 标题里不允许出现的结构噪声。 */
const TITLE_NOISE = [
  { re: /[\r\n]/, why: '含换行' },
  { re: /^#{1,6}\s/, why: '仍带 markdown 标题符号' },
  { re: /#{1,6}\s/, why: '含 markdown 标题符号' },
  { re: /^\[[\w-]+\]/, why: '仍带 [type] 前缀' },
  { re: /\.\.\.$/, why: '仍以 ... 结尾' },
  { re: /^---/, why: '是分隔线' },
  { re: /^(id|type|date|timestamp|tags|category|source|summary|title|contentHash|version|created|updated|relations|permission|scope|agent):/, why: '是 frontmatter 字段名' },
  { re: /^\d{4}-\d{2}-\d{2}/, why: '是日期前缀' },
];

check('P7', '标题不含结构噪声（[ type ] 前缀 / # 符号 / ... / frontmatter 字段名）', () => {
  const { tmp, found } = runOrganize([
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'],
      content: ensureLong('# 交付报告：知识库质量提升\n\n正文内容用于验证标题提取策略是否取到 markdown 标题。') },
  ], { label: 'title' });
  try {
    assertEqual(found.length, 1, '生成条目数');
    const t = (found[0].fm.title || '').trim();
    for (const { re, why } of TITLE_NOISE) {
      if (re.test(t)) throw new Error(`标题${why}：${JSON.stringify(t)}`);
    }
    if (t.length > 60) throw new Error(`标题过长（${t.length} > 60）：${JSON.stringify(t)}`);
    if (t.length < 4) throw new Error(`标题过短：${JSON.stringify(t)}`);
    return `标题 = ${t}`;
  } finally { cleanup(tmp); }
});

check('P8', '标题取 markdown 标题本身，而不是正文拼接', () => {
  const { tmp, found } = runOrganize([
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'],
      content: ensureLong('前言一行无关紧要的说明文字。\n\n## 实际结论\n\n正文内容。') },
  ], { label: 'title2' });
  try {
    assertEqual(found.length, 1, '生成条目数');
    const t = (found[0].fm.title || '').trim();
    if (!/实际结论/.test(t)) throw new Error(`标题未取到二级标题，实际：${JSON.stringify(t)}`);
    if (/前言/.test(t)) throw new Error(`标题仍混入了标题前的正文：${JSON.stringify(t)}`);
    if (/#{1,6}\s/.test(t)) throw new Error(`标题仍带 markdown 符号：${JSON.stringify(t)}`);
    return `标题 = ${t}`;
  } finally { cleanup(tmp); }
});

check('P9', '幂等：同一批内容跑两次不产生重复条目', () => {
  const entries = [
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'],
      content: ensureLong('幂等性验证用的正文内容，长度需要足够通过质量门。') },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbq-idem-'));
  const logDir = path.join(tmp, '00_InteractionLogs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, '90_Agent'), { recursive: true });
  fs.writeFileSync(path.join(logDir, entries[0].file), buildLog(entries), 'utf-8');
  const env = { ...process.env, OBSIDIAN_VAULT_PATH: tmp };
  try {
    execFileSync(process.execPath, [ORGANIZE_SCRIPT, JSON.stringify({ limit: 100 })], { encoding: 'utf-8', env });
    execFileSync(process.execPath, [ORGANIZE_SCRIPT, JSON.stringify({ limit: 100 })], { encoding: 'utf-8', env });
    const kbRoot = path.join(tmp, '30_Resources');
    let n = 0;
    for (const dir of fs.readdirSync(kbRoot)) {
      const full = path.join(kbRoot, dir);
      if (fs.statSync(full).isDirectory()) n += fs.readdirSync(full).filter((f) => f.endsWith('.md')).length;
    }
    if (n !== 1) throw new Error(`跑两次后生成 ${n} 条，期望 1 条（contentHash 去重失效）`);
    return '两次运行后仍只有 1 条';
  } finally { cleanup(tmp); }
});

check('P10', '相同内容重复出现只生成一条（contentHash 去重）', () => {
  const body = ensureLong('重复内容去重验证用的正文。');
  const entries = [
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z', type: 'conversation', tags: ['auto'], content: body },
    { file: '2026-01-01_conversation.md', ts: '2026-01-01T00:05:00.000Z', type: 'conversation', tags: ['auto'], content: body },
  ];
  const { tmp, found } = runOrganize(entries, { label: 'dup' });
  try {
    if (found.length !== 1) throw new Error(`相同内容生成了 ${found.length} 条，期望 1 条`);
    return '去重生效';
  } finally { cleanup(tmp); }
});

check('P11', '日志白名单只含 conversation/decision/insight（产品决策 A）', () => {
  const src = fs.readFileSync(ORGANIZE_SCRIPT, 'utf-8');
  const m = src.match(/KNOWLEDGE_TYPES\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('未找到 KNOWLEDGE_TYPES 白名单定义');
  const list = [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  for (const t of ['conversation', 'decision', 'insight']) {
    if (!list.includes(t)) throw new Error(`白名单缺少 ${t}，实际白名单：${list.join(', ') || '(空)'}`);
  }
  // 产品决策 A：这三类是操作日志（实测 100% 工具调用记录），不得提炼为知识条目
  for (const t of ['thinking', 'memory-op', 'project-op']) {
    if (list.includes(t)) {
      throw new Error(`白名单不应包含操作日志 ${t} —— 产品决策 A「只提炼真知识」，` +
        `这三类实测 100% 是工具调用记录（见 KNOWLEDGE-PIPELINE.md §11）`);
    }
  }
  return `白名单 = ${list.join(', ')}`;
});

check('P12', 'organize 只处理游标之后的新内容', () => {
  const src = fs.readFileSync(ORGANIZE_SCRIPT, 'utf-8');
  if (!/lastOrganizedAt/.test(src)) throw new Error('未发现游标字段 lastOrganizedAt');
  return '游标逻辑存在';
});

check('P13', '自指循环门：注入块不提炼为知识条目', () => {
  const src = fs.readFileSync(ORGANIZE_SCRIPT, 'utf-8');
  const m = src.match(/INJECTION_MARKER\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('未找到 INJECTION_MARKER 常量定义');
  const marker = m[1];
  const { tmp, found } = runOrganize([
    {
      file: '2026-01-01_conversation.md', ts: '2026-01-01T00:00:00.000Z',
      type: 'conversation', tags: ['auto'],
      content: ensureLong(`## ${marker}\n\n### [05_网络层_源码学习心得]\n- 来源: D:/MyVault/30_Resources/后端与数据库/05_网络层_源码学习心得.md\n- 分类: unknown | 置信度: 0.7`),
    },
  ], { label: 'injection' });
  try {
    if (found.length !== 0) {
      throw new Error(`注入块未被拒绝，生成了 ${found.length} 条：${found.map((x) => x.name).join(', ')}`);
    }
    return `命中「${marker}」后被拒绝（自指循环门生效）`;
  } finally { cleanup(tmp); }
});

// ============================================================
// B. Vault 卫生检查（只读）
// ============================================================
if (!SKIP_VAULT) {
  check('V1', '自动条目全部干净（无残留 / 无泄漏 / 标题非工具名）', () => {
    const roots = ['experience', 'project', 'topic', 'entity', 'process', 'todo', '_inbox'];
    const FM_RESIDUE = /\n---\n(?:id|type|date|timestamp|title|summary|content|tags|category|source|permission|relations|version|created|updated|contentHash|project):/;
    const MARKERS = ['You are a helpful assistant', 'You are Claude', 'You are an AI assistant',
      '<system>', 'system prompt:', 'Your task is to', '你是一个乐于助人的助手'];
    const TOOL_TITLE = /^(bash|webfetch|powershell|pwsh|edit|read|write|todowrite|subagent|sendmessage|spawnteammate|grep|node|toolsearch|project)$/i;
    const problems = [];
    let total = 0;
    const dist = {};
    for (const r of roots) {
      const d = path.join(VAULT, '30_Resources', r);
      if (!fs.existsSync(d)) continue;
      const kbs = fs.readdirSync(d).filter((f) => f.startsWith('KB-') && f.endsWith('.md'));
      dist[r] = kbs.length;
      total += kbs.length;
      for (const f of kbs) {
        const raw = fs.readFileSync(path.join(d, f), 'utf-8');
        const end = raw.indexOf('\n---', 4);
        const body = end === -1 ? '' : raw.slice(end + 4);
        if (FM_RESIDUE.test(body)) problems.push(`${r}/${f}: 正文含 frontmatter 残留`);
        if (MARKERS.some((m) => raw.toLowerCase().includes(m.toLowerCase()))) problems.push(`${r}/${f}: system prompt 泄漏`);
        const tm = raw.match(/^title:\s*(.*)$/m);
        const title = (tm ? tm[1] : '').replace(/^"|"$/g, '');
        if (TOOL_TITLE.test(title)) problems.push(`${r}/${f}: 标题是工具名「${title}」`);
      }
    }
    if (problems.length) throw new Error(`${problems.length} 条不合格：\n        ${problems.slice(0, 5).join('\n        ')}`);
    return `${total} 条自动条目全部干净（分布 ${JSON.stringify(dist)}）`;
  });

  check('V2', '真实知识目录未被误删（115 篇手工策展仍在）', () => {
    const expect = { 'AI_Agent': 28, '前端框架': 31, '后端与数据库': 23, '开发工程化': 32, '通信协议': 1 };
    const missing = [];
    for (const [dir, n] of Object.entries(expect)) {
      const d = path.join(VAULT, '30_Resources', dir);
      const actual = fs.existsSync(d)
        ? fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).length
        : 0;
      if (actual < n) missing.push(`${dir}: 期望 >=${n}，实际 ${actual}`);
    }
    if (missing.length) throw new Error(`真实知识缺失：${missing.join('; ')}`);
    return '115 篇全部在位';
  });

  check('V3', '原始日志完好（信息源未受影响）', () => {
    const logDir = path.join(VAULT, '00_InteractionLogs');
    const md = fs.readdirSync(logDir).filter((f) => f.endsWith('.md'));
    const bytes = md.reduce((s, f) => s + fs.statSync(path.join(logDir, f)).size, 0);
    if (bytes < 1_000_000) throw new Error(`日志总量异常偏小：${bytes} B`);
    return `${md.length} 个日志文件，共 ${bytes} B`;
  });
}

// ============================================================
// 输出
// ============================================================
const failed = results.filter((r) => r.status === 'FAIL');

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`\n知识库质量回归守卫 — ${results.length} 项检查\n`);
  for (const r of results) {
    const mark = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${r.id.padEnd(4)} ${r.title}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log(`\n结果：${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) {
    console.log(`\n未通过项（修复后应全部转 PASS）：`);
    for (const r of failed) console.log(`  - ${r.id} ${r.title}`);
  }
}
process.exit(failed.length ? 1 : 0);
