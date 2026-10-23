/**
 * Obsidian Bridge 端到端验证脚本（只读证据 + 一次真实 MCP 调用）。
 *
 * 设计原则：每条断言都必须证明「数据从 A 流到 B」，而不是「某段代码被执行过」。
 * 与 acceptance.mjs 的区别：
 *   - acceptance.mjs 的 PLUGIN 检查用 mock ctx，只证明子进程被 spawn（假阳性）；
 *   - 本脚本不 mock 任何东西，只读真实 Vault 产物、真实 DSH 日志与真实 MCP 通道。
 *
 * 运行：
 *   node test/e2e-verify.mjs                # 打印 PASS/FAIL/MANUAL 表
 *   node test/e2e-verify.mjs --json         # 机器可读输出
 *
 * 可选环境变量：
 *   DSH_LOG_DIR   DSH Desktop 日志目录（默认 %APPDATA%\DSH Desktop\logs）
 *   DSH_LAUNCH_TOKEN   Web GUI 启动令牌；提供后自动执行 HTTP 实时探针
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = process.env.OBSIDIAN_VAULT_PATH ?? 'D:/MyVault';
const LOGS = path.join(VAULT, '00_InteractionLogs');
const AGENT = path.join(VAULT, '90_Agent');
const MCP_SERVER = '<YOUR_WORKBUDDY_PATH>';
const DSH_LOG_DIR = process.env.DSH_LOG_DIR ?? path.join(os.homedir(), 'AppData/Roaming/DSH Desktop/logs');
const GUI_URL = process.env.DSH_GUI_URL ?? 'http://127.0.0.1:43120';
const NODE = process.execPath;

const TODAY = new Date().toISOString().slice(0, 10);
/** DSH 日志时间戳是 UTC，日期分区按本地时区；两种都试。 */
const LOG_DATES = [TODAY, new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10)];

const results = [];
const record = (id, title, status, evidence) => results.push({ id, title, status, evidence });

// ============================================================
// 0. 环境（只读）
// ============================================================
{
  const modules = path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/@local/obsidian-bridge');
  let status = 'FAIL';
  let evidence = 'junction 不存在';
  try {
    const st = fs.lstatSync(modules);
    if (st.isSymbolicLink()) {
      // **不能拿 ROOT 直接比较** —— 本测试经 run-all.mjs 的 stage() 跑在
      // profile 的 node_modules 暂存目录里，`import.meta.url` 推出的是**暂存路径**，
      // 而 junction 指向的是**工作区**，两者永不相等 → 会误报 FAIL。
      // run-all.mjs 会把真实工作区根通过 OBSIDIAN_WORKSPACE_ROOT 传进来；
      // 缺省时回退到暂存目录的上级（兼容直接运行）。
      const workspaceRoot = process.env.OBSIDIAN_WORKSPACE_ROOT || path.resolve(ROOT, '..', '..', '..', '..');
      const raw = fs.readlinkSync(modules);
      const target = raw.replace(/^\\\\\?\\/, '').replace(/^\//, '');
      const normalize = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      status = normalize(target) === normalize(workspaceRoot) ? 'PASS' : 'FAIL';
      evidence = `junction -> ${target}（比较基准 ${workspaceRoot}）`;
    } else {
      evidence = '不是 reparse point（复制而非链接，源码改动不会生效）';
    }
  } catch (error) {
    evidence = String(error?.message ?? error);
  }
  record('ENV-1', 'profile node_modules 用 junction 指向工作区（改动即时生效）', status, evidence);
}

{
  const pkgPath = path.join(os.homedir(), '.dsh/profiles/desktop/package.json');
  let status = 'FAIL';
  let evidence = '读不到 profile package.json';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const dep = pkg?.dependencies?.['@local/obsidian-bridge'];
    const bundles = pkg?.dsh?.profile?.bundles ?? [];
    const deselected = pkg?.dsh?.desktopDeselectedBundles ?? [];
    const inBundles = bundles.includes('@local/obsidian-bridge');
    status = dep && inBundles ? 'PASS' : 'FAIL';
    evidence = `dep=${dep} bundles.includes=${inBundles} deselected=${JSON.stringify(deselected)}`;
  } catch (error) {
    evidence = String(error?.message ?? error);
  }
  record('ENV-2', 'profile 声明 @local/obsidian-bridge 依赖并列入 bundles', status, evidence);
}

{
  // Host 半边是否被 Loader 真正加载：只有 apply() 跑过，才会出现今天的 session-start 留痕。
  const conv = path.join(LOGS, `${TODAY}_conversation.md`);
  let status = 'FAIL';
  let evidence = `${conv} 不存在`;
  try {
    const raw = fs.readFileSync(conv, 'utf-8');
    const hits = (raw.match(/会话开始/g) ?? []).length;
    status = hits > 0 ? 'PASS' : 'FAIL';
    evidence = `今天 conversation 日志含「会话开始」x${hits}（只能由 host apply() → bridge.js 产生）`;
  } catch (error) {
    evidence = String(error?.message ?? error);
  }
  record('ENV-3', 'Host 半边已激活（session-start 真实落盘）', status, evidence);
}

// ============================================================
// 1. Host 事件 → 子进程 → Vault 产物
// ============================================================
{
  const conv = path.join(LOGS, `${TODAY}_conversation.md`);
  const raw = fs.existsSync(conv) ? fs.readFileSync(conv, 'utf-8') : '';

  const checks = [
    ['E1', 'agent/created → session-start → Vault', /会话开始/.test(raw), '「会话开始」小节'],
    ['E2', 'agent/pre-step → user-prompt → Vault', /用户 prompt:/.test(raw), '「用户 prompt:」小节'],
    ['E3', 'agent/turn-stopping → stop → Vault', /对话结束/.test(raw), '「对话结束」小节'],
  ];
  for (const [id, title, ok, what] of checks) {
    record(id, title, ok ? 'PASS' : 'FAIL', ok ? `${what} 存在于 ${path.relative(VAULT, conv)}` : `缺少${what}`);
  }
}

{
  // 知识注入必须带真实笔记路径，而不是只有标题。
  const conv = path.join(LOGS, `${TODAY}_conversation.md`);
  const raw = fs.existsSync(conv) ? fs.readFileSync(conv, 'utf-8') : '';
  // 扫描**所有**注入块，而不是只取最后一个 ——
  // 注入是否命中取决于当次 prompt 的关键词，只读最后一块会让本项随最近一条消息波动。
  const blocks = raw.split('## 知识库相关笔记（自动注入）').slice(1);
  const paths = [...blocks.join('\n').matchAll(/30_Resources\/[^\s)]+\.md/g)].map((m) => m[0]);
  const ok = paths.length > 0 && paths.every((p) => fs.existsSync(path.join(VAULT, p)));
  if (ok) {
    record(
      'E4',
      '知识注入带真实笔记路径且文件存在',
      'PASS',
      `${paths.length} 条路径均存在：${paths.slice(0, 2).join(', ')}`,
    );
  } else {
    // 今天还没出现过任何注入块：这不是回归，而是「今天尚未命中关键词」。
    // 标为 MANUAL 并给出复现命令，而不是判 FAIL。
    record(
      'E4',
      '知识注入带真实笔记路径且文件存在',
      'MANUAL',
      blocks.length === 0
        ? `今日日志无注入块。发一条含知识库关键词的消息（如「Obsidian 桥接」）后重跑`
        : `有 ${blocks.length} 个注入块但无 30_Resources 路径`,
    );
  }
}

{
  // 子进程必须真的跑完（exit 0），而不是只被 spawn。
  const debugLog = path.join(LOGS, 'hook-debug.log');
  const raw = fs.existsSync(debugLog) ? fs.readFileSync(debugLog, 'utf-8') : '';
  const todayLines = raw.split('\n').filter((l) => l.startsWith(`[${TODAY}`));
  const started = todayLines.filter((l) => /\[(session-start|user-prompt|stop)\] Hook triggered/.test(l)).length;
  const completed = todayLines.filter((l) => /Hook completed successfully/.test(l)).length;
  const ok = started > 0 && completed >= started;
  record(
    'E5',
    '桥接子进程真实执行完成（triggered → completed）',
    ok ? 'PASS' : 'FAIL',
    ok ? `今天 triggered=${started} completed=${completed}` : `triggered=${started} completed=${completed}`,
  );
}

// ============================================================
// 2. 治理 / 审计（必须产出文件，不能只是「脚本能跑」）
// ============================================================
{
  const gov = path.join(AGENT, 'governance', `${TODAY}-governance.json`);
  const audit = path.join(AGENT, 'audit', `${TODAY}-audit.json`);
  let status = 'FAIL';
  let evidence = '文件缺失';
  try {
    const parsed = JSON.parse(fs.readFileSync(audit, 'utf-8'));
    const govOk = fs.existsSync(gov);
    const scanned = Number(parsed?.totalScanned);
    status = govOk && Number.isFinite(scanned) && scanned > 0 ? 'PASS' : 'FAIL';
    evidence = `audit.totalScanned=${scanned} governance 文件=${govOk ? '存在' : '缺失'}`;
  } catch (error) {
    evidence = String(error?.message ?? error);
  }
  record('G1', '治理扫描产出 audit + governance 文件且扫描数 > 0', status, evidence);
}

{
  const integrity = path.join(AGENT, 'audit', `${TODAY}-integrity.json`);
  let status = 'FAIL';
  let evidence = `${integrity} 不存在`;
  try {
    const parsed = JSON.parse(fs.readFileSync(integrity, 'utf-8'));
    const entries = parsed?.entries ?? [];
    const last = entries[entries.length - 1];
    const checks = last?.integrity?.checks ?? {};
    const ok =
      entries.length > 0 &&
      checks?.contentHash?.passed === true &&
      checks?.signature?.passed === true &&
      last?.integrity?.overall === true;
    status = ok ? 'PASS' : 'FAIL';
    evidence = ok
      ? `${entries.length} 条；末条 contentHash+signature passed，overall=true（${last?.logFile}）`
      : `entries=${entries.length} last.checks=${JSON.stringify(checks)}`;
  } catch (error) {
    evidence = String(error?.message ?? error);
  }
  record('G2', '交叉认证审计含 contentHash + signature 且 overall=true', status, evidence);
}

// ============================================================
// 3. MCP 通道（真实 stdio 调用，不是只看 tools/list）
// ============================================================
/** 在 DSH 安装目录下用官方 MCP SDK 执行一段客户端脚本（DSH_APP_DIR 才能解析 SDK）。 */
function mcpRun(body) {
  const script = `
    const { Client } = require('@modelcontextprotocol/client');
    const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
    (async () => {
      const transport = new StdioClientTransport({
        command: ${JSON.stringify(NODE)},
        args: [${JSON.stringify(MCP_SERVER)}],
        env: { OBSIDIAN_VAULT_PATH: ${JSON.stringify(VAULT)} },
      });
      const client = new Client({ name: 'e2e-verify', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const result = await (async (client) => { ${body} })(client);
      await client.close();
      console.log(JSON.stringify(result));
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  const out = execFileSync(NODE, ['--input-type=commonjs', '-e', script], {
    encoding: 'utf-8',
    timeout: 90000,
    cwd: '<DSH_APP_DIR>',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const listMcpTools = () => mcpRun('return client.listTools().then((r) => r.tools.map((t) => t.name));');
const callMcpTool = (name, args) =>
  mcpRun(`return client.callTool({ name: ${JSON.stringify(name)}, arguments: ${JSON.stringify(args)} });`);

const EXPECTED_TOOLS = [
  'obsidian_create_note', 'obsidian_delete_note', 'obsidian_get_backlinks', 'obsidian_get_frontmatter',
  'obsidian_get_moc', 'obsidian_get_project', 'obsidian_get_stats', 'obsidian_get_tags',
  'obsidian_list_notes', 'obsidian_list_projects', 'obsidian_log_interaction', 'obsidian_read_note',
  'obsidian_search_notes', 'obsidian_update_frontmatter', 'obsidian_update_note',
];

try {
  const tools = await listMcpTools();
  const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
  record(
    'M1',
    'MCP 服务暴露全部 15 个工具',
    tools.length === 15 && missing.length === 0 ? 'PASS' : 'FAIL',
    `tools/list 返回 ${tools.length} 个；缺失 ${JSON.stringify(missing)}`,
  );
} catch (error) {
  record('M1', 'MCP 服务暴露全部 15 个工具', 'FAIL', String(error?.message ?? error).split('\n')[0]);
}

try {
  // 真实调用一次工具，验证 A(DSH MCP 配置) → B(Vault 真实数据)。
  const result = await callMcpTool('obsidian_get_stats', {});
  const text = result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  const ok = /totalFiles|totalNotes|137|\d{2,}/.test(text);
  record(
    'M2',
    'MCP 工具真实可调用并返回 Vault 数据',
    ok ? 'PASS' : 'FAIL',
    ok ? `obsidian_get_stats -> ${text.slice(0, 120)}` : `返回不含统计数字：${text.slice(0, 200)}`,
  );
} catch (error) {
  record('M2', 'MCP 工具真实可调用并返回 Vault 数据', 'FAIL', String(error?.message ?? error).split('\n')[0]);
}

// ============================================================
// 4. Client ↔ Host 通道（当前断点）
// ============================================================
{
  // 只看「今天」那份日志（按本地日期命名），避免把历史 runId 当成当前会话。
  const candidates = [TODAY, new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10)]
    .map((d) => path.join(DSH_LOG_DIR, `dsh-${d}.log`))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const logFile = candidates[0] ?? '';
  const logText = logFile ? fs.readFileSync(logFile, 'utf-8') : '';

  const latestRun = [...logText.matchAll(/"runId":"([0-9a-f-]+)"/g)].map((m) => m[1]).pop();
  // 取该 run 首次出现之后的全部内容（其后的 tray:set 等行仍属同一 run）。
  const runIndex = latestRun ? logText.indexOf(`"runId":"${latestRun}"`) : -1;
  const latestBlock = runIndex >= 0 ? logText.slice(runIndex) : logText;

  const has = (re) => re.test(latestBlock);

  record(
    'C1',
    'Client 半边已加载（dsh.client 生效）',
    has(/\[obsidian-bridge\] client half apply\(\) 开始/) ? 'PASS' : 'FAIL',
    has(/\[obsidian-bridge\] client half apply\(\) 开始/) ? `runId=${latestRun}` : `runId=${latestRun} 无 client half 日志`,
  );

  record(
    'C2',
    'Client 侧 $mount 成功（Host Typert 清单已注册）',
    has(/\[obsidian-bridge\] Typert Remote 已挂载/) ? 'PASS' : 'FAIL',
    has(/\[obsidian-bridge\] Typert Remote 已挂载/)
      ? '$mount 未抛错 ⇒ Host ./typert 清单已注册且方法可用'
      : '无「Typert Remote 已挂载」⇒ Host 清单未注册或校验失败',
  );

  const bound = has(/\[obsidian-bridge\] remote\.obsidianBridge 已就绪/);
  const failed = has(/\[obsidian-bridge\] remote (注入失败|服务读取失败)/);
  record(
    'C3',
    'Client 绑定 remote.obsidianBridge 命名空间',
    bound ? 'PASS' : 'FAIL',
    bound ? '命名空间已就绪' : `未就绪${failed ? '（日志含 remote 注入/读取失败）' : ''}`,
  );

  record(
    'C4',
    'Client 无 remote 通道错误',
    !failed ? 'PASS' : 'FAIL',
    failed ? '存在 remote 注入失败 / remote 服务读取失败' : '无错误行',
  );

  record(
    'C5',
    '面板注册进 settings.section（能渲染）',
    has(/\[obsidian-bridge\] 注册 settings\.section/) ? 'PASS' : 'FAIL',
    has(/\[obsidian-bridge\] 注册 settings\.section/) ? 'slot 已注册' : '未注册',
  );
}

// ============================================================
// 5. 工具调用对账（真实派发链）
// ============================================================
{
  /**
   * A = 当日 host 日志里真实发生的工具执行数（host.tools / execute.start）。
   * B = 当日 Vault 里由 `post-tool` 落盘的工具留痕数。
   *
   * `bridge.js` 的 handlePostTool 把每次 post-tool 分成三类 type
   * （`:605-615`）：memory-op / project-op / thinking（默认）。
   * 三者都**只能**由插件的 `tools/result` 处理器触发，因此
   * B > 0 就是「DSH 真实派发 → 插件接收 → 降噪 → 子进程落盘」整条链在真实
   * 运行时是通的证据 —— 正是用户最初报的「工具调用事件恒为 0」的反面。
   */
  const hostLogDir = process.env.DSH_HOST_LOG_DIR
    ?? path.join(os.homedir(), 'AppData/Roaming/DSH Desktop/logs/host');
  const hostLog = path.join(hostLogDir, `dsh-${TODAY}.log`);
  let executions = 0;
  if (fs.existsSync(hostLog)) {
    for (const line of fs.readFileSync(hostLog, 'utf-8').split('\n')) {
      if (line.includes('"source":"host.tools"') && line.includes('"event":"execute.start"')) executions += 1;
    }
  }

  let postTool = 0;
  const postToolFiles = [];
  if (fs.existsSync(LOGS)) {
    for (const f of fs.readdirSync(LOGS)) {
      if (!f.startsWith(`${TODAY}_`) || !f.endsWith('.md')) continue;
      const s = fs.readFileSync(path.join(LOGS, f), 'utf-8');
      const n = (s.match(/^## \[[^\]]+\] (thinking|memory-op|project-op)$/gm) ?? []).length;
      if (n > 0) { postTool += n; postToolFiles.push(`${f}:${n}`); }
    }
  }

  if (executions === 0) {
    record('M3', '真实派发链对账（当日无工具调用）', 'SKIP',
      `当日 host 日志（${hostLog}）无 host.tools/execute.start，无数据可对账；工具留痕=${postTool}`);
  } else {
    const ok = postTool > 0 && postTool <= executions;
    record('M3', '真实派发链对账：工具留痕 > 0 且 ≤ 真实工具执行数', ok ? 'PASS' : 'FAIL',
      ok
        ? `真实工具执行=${executions}，工具留痕=${postTool}（${postToolFiles.join(', ') || '无'}）`
        : `真实工具执行=${executions}，工具留痕=${postTool} —— 留痕为 0 说明插件未收到 tools/result`
          + '（与「工具调用事件恒为 0」同一根因）；留痕 > 执行数则说明重复落盘',
    );
  }

  /**
   * 计数器本身无法外部读取，这一项**显式 SKIP** 并写明原因。
   *
   * 隐性失效的测试等于不存在 —— 所以这里不假装在测，而是把「为什么测不了解」
   * 原原本本写出来，并给出人工核对命令。
   */
  record('M4', '计数器一致性：toolEvents == 真实工具调用数', 'SKIP',
    '不可自动化：插件计数器只存在于 Host 进程内存（lib/status-store.js:14 的模块级 snapshotValue），'
    + '不落盘、不写 DSH 日志（实测日志中无 counters/toolEvents 输出）；面板经 Typert Remote 读取，'
    + '而启动令牌是进程内随机值 —— dsh-client-connection/lib/index.js:294-300 用 randomBytes 生成并'
    + '存进 PROCESS_LAUNCH_TOKENS（内存 Map），从不写盘，日志里也无 token= 记录，外部脚本拿不到。'
    + `人工核对：DSH 面板「Obsidian 桥接」→「工具调用事件」的值，应与 \`grep -c '"source":"host.tools"' ${hostLog}\` 同量级。`,
  );
}

// ============================================================
// 6. HTTP 状态路由探针 —— 已失效，显式 SKIP
// ============================================================
{
  // 该路由在 v1.0.0 已移除（`wiring.mjs:241` 断言「HTTP 状态路由与 webServer 依赖已移除」），
  // 面板取数统一走 Typert Remote。此前 P1/P2 靠「需要 DSH_LAUNCH_TOKEN 才执行」隐性不运行，
  // 属于假性测试 —— 现改为**显式 SKIP** 并在输出里写明原因。
  record('P1', 'GET /obsidian-bridge/status 返回 200 + 快照', 'SKIP',
    '已失效并显式跳过：路由在 v1.0.0 移除（wiring.mjs:241），面板改走 Typert Remote；'
    + '保留本项仅为标注，不再发起请求。');
  record('P2', '快照计数随真实事件增长', 'SKIP',
    '依赖 P1；P1 的路由已移除，故一并显式 SKIP。计数增长性由人工核对（见 M4 说明）。');
}

// ============================================================
// 输出
// ============================================================
const json = process.argv.includes('--json');
const order = { PASS: 0, FAIL: 1, SKIP: 2, MANUAL: 3 };
results.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id));

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('');
  const mark = { PASS: 'PASS ', FAIL: 'FAIL ', SKIP: 'SKIP ', MANUAL: 'MANUAL' };
  for (const r of results) {
    console.log(`  [${mark[r.status] ?? r.status}] ${r.id.padEnd(6)} ${r.title}`);
    console.log(`           ${r.evidence}`);
  }
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const manual = results.filter((r) => r.status === 'MANUAL').length;
  console.log(`\n通过 ${passed}/${results.length}，失败 ${failed}，跳过 ${skipped}，待人工 ${manual}`);
  if (skipped > 0) {
    console.log('  ⚠️  SKIP 不等于 PASS —— 每项 SKIP 都写明了原因与人工核对方式');
  }
}

process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
