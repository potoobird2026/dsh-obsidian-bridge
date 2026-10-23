/**
 * 统一测试入口。
 *
 * 按**可执行环境**分层，而不是按文件顺序堆叠 —— 这样在 CI（无 DSH、无 Vault）
 * 和本地（有 DSH、有 Vault）都能给出**诚实**的结果，不会把「跳过」伪装成「通过」。
 *
 * ## 分层
 *
 * | 层 | 名称 | 需要什么 | CI 可跑 |
 * |---|---|---|---|
 * | L1 | 契约 | DSH 安装目录（只读 api-catalog.js） | 需要，缺失则 SKIP |
 * | L2 | 单元/接线 | 仅 Node（mock ctx 加载真实 index.js） | ✅ |
 * | L3 | 端到端 | 运行中的 DSH + 真实 Vault | ❌ 本地专用 |
 *
 * ## 用法
 *   node test/run-all.mjs            # 自动检测环境，跑能跑的
 *   node test/run-all.mjs --ci       # CI 模式：L3 一律 SKIP，不因缺环境失败
 *   node test/run-all.mjs --strict   # 严格模式：任何 SKIP 都算失败
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const CI = process.argv.includes('--ci');
const STRICT = process.argv.includes('--strict');

/** DSH 安装目录。 */
const DSH_APP = process.env.DSH_APP_DIR || '<DSH_APP_DIR>';
const HAS_DSH = fs.existsSync(DSH_APP);

/** 默认 Vault 路径。 */
const VAULT = process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';
const HAS_VAULT = fs.existsSync(VAULT);

/**
 * 解析 L2 套件的运行目录。
 *
 * `lib/config.js` 依赖 `@deepseek-ai/schemastery`，它**已在 npm 上**（实测 `npm view`
 * 返回 `3.18.5`，与 package.json 声明的 `~3.18.5` 一致）。因此优先用仓库自己的
 * `node_modules` —— 这样公开仓库可独立运行：
 *
 *     npm install && node test/run-all.mjs --ci --strict
 *
 * 找不到时才退回 profile 的 node_modules（本机开发环境的既有路径），
 * 两处都没有则返回 null，对应套件标记为 SKIP。
 * @returns `{ dir, mode, cleanup }`；`dir` 为 null 表示无法运行 L2。
 */
function stage() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery'))) {
    // 就地运行：ROOT/lib/config.js 会从 ROOT/node_modules 解析到依赖
    return { dir: ROOT, mode: 'local', cleanup: () => {} };
  }
  const profile = process.env.DSH_PROFILE_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop');
  const nm = path.join(profile, 'node_modules');
  if (!fs.existsSync(nm)) return { dir: null, mode: 'none', cleanup: () => {} };
  const dir = path.join(nm, `ob-testrun-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  // 注意：必须连同 cordis.patch.yml 一起 stage ——
  // `audit-counters.mjs` 的 V9 守卫要读它校验死配置是否清理干净。
  for (const f of ['index.js', 'client.js', 'typert.host.js', 'package.json', 'cordis.patch.yml', 'README.md']) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'docs'))) {
    fs.cpSync(path.join(ROOT, 'docs'), path.join(dir, 'docs'), { recursive: true });
  }
  return { dir, mode: 'profile', cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const { dir: STAGE, mode: STAGE_MODE, cleanup } = stage();
/** L2 的运行前置条件描述，随实际解析结果变化。 */
const L2_NEED = STAGE_MODE === 'local'
  ? '仓库 node_modules（npm install）'
  : STAGE_MODE === 'profile'
    ? 'profile node_modules（解析 schemastery）'
    : 'node_modules —— 请先 `npm install`（或提供 profile）';

/** 测试项定义。 */
const SUITES = [
  {
    layer: 'L1',
    name: '契约：事件处理器签名与平台声明一致',
    file: 'test/contract.mjs',
    needs: () => HAS_DSH,
    needDesc: 'DSH 安装目录（读 api-catalog.js）',
    // 「可选外部设施」：需要 DSH 安装目录 / 真实 Vault 这类**用户侧基础设施**，
    // CI runner 与普通使用者合法地可能没有。缺它而跳过属「按设计」，
    // 严格模式不判失败；缺 node_modules 则属「环境缺失」，严格模式判失败。
    optionalInfra: true,
    pass: /契约测试通过 (\d+)\/(\d+)/,
    cwd: ROOT, // 契约测试只读源码，不需要 stage
  },
  {
    layer: 'L2',
    name: '接线：四个事件处理器触发正确的子进程调用',
    file: 'test/wiring.mjs',
    // 该套件用真实 fs 扫描 Vault 并断言注入命中 —— 没有 Vault 就没有意义
    needs: () => STAGE !== null && HAS_VAULT,
    needDesc: `${L2_NEED} + 真实 Vault（${VAULT}）`,
    optionalInfra: true,
    pass: /接线测试全部通过：(\d+) 项/,
  },
  {
    layer: 'L2',
    name: '状态刷新：计数与快照写入语义',
    file: 'test/status-refresh.mjs',
    needs: () => STAGE !== null,
    needDesc: L2_NEED,
    pass: /通过 (\d+)\/(\d+)/,
  },
  {
    layer: 'L2',
    name: '单元：配置解析与消息构造',
    file: 'test/run.mjs',
    // 末段断言真实 Vault 的扫描结果（条数 > 0），因此同样需要 Vault
    needs: () => STAGE !== null && HAS_VAULT,
    needDesc: `${L2_NEED} + 真实 Vault（${VAULT}）`,
    optionalInfra: true,
    pass: /通过 (\d+)\/(\d+)|全部通过/,
  },
  {
    layer: 'L2',
    name: '计数器审计：11 项可观测性问题回归',
    file: 'test/audit-counters.mjs',
    needs: () => STAGE !== null,
    needDesc: L2_NEED,
    pass: /通过 (\d+)\/(\d+)/,
  },
  {
    layer: 'L2',
    name: '控制流：守卫顺序 / 副作用可见性 / 状态泄漏',
    file: 'test/audit-flow.mjs',
    needs: () => STAGE !== null,
    needDesc: L2_NEED,
    // 输出形如：合计：BUG 0 / WARN 3 / OK 34 / INFO 0（共 37 条）
    // 本套件把「失败」定义为 BUG 数（WARN 不阻断），而 BUG 在**第 1 组**。
    pass: /合计：BUG (\d+) \/ WARN (\d+) \/ OK (\d+) \/ INFO (\d+)（共 (\d+) 条）/,
    failedGroup: 1,
  },
  {
    // 交叉评审 FN-1：此套件此前**未被 run-all 引用**，
    // 也就是说它 16 条断言从未在统一入口里跑过 —— 典型的「隐性失效」。
    layer: 'L2',
    name: '知识整理：质量门 / 分类 / 幂等 / 自指循环',
    file: 'test/knowledge-quality.mjs',
    needs: () => STAGE !== null,
    needDesc: L2_NEED,
    pass: /(\d+) PASS \/ (\d+) FAIL/,
    failedGroup: 2,
  },
  {
    // 配置一致性守卫：让「两处独立声明漂移」变成测试失败而不是用户困惑
    layer: 'L2',
    name: '配置一致性：常量 / 脚本路径 / 文档 vs 实现',
    file: 'test/config-consistency.mjs',
    needs: () => STAGE !== null && HAS_VAULT,
    needDesc: `${L2_NEED} + 真实 Vault（${VAULT}）`,
    optionalInfra: true,
    pass: /配置一致性通过 (\d+)\/(\d+)/,
  },
  {
    // Client 半边运行时测试：用 mock window.__ModuleLoader__ + mock React
    // 在 Node 里**真正执行** client.js（此前覆盖率 0%，Node 触不到浏览器模块）
    layer: 'L2',
    name: 'Client 运行时：bundle 工厂 / 槽位注册 / Panel 渲染 / 解包',
    file: 'test/client-runtime.mjs',
    needs: () => STAGE !== null,
    needDesc: L2_NEED,
    pass: /Client 运行时测试通过 (\d+)\/(\d+)/,
  },
  {
    layer: 'L3',
    name: '端到端：PRD §9 验收（真实 Vault）',
    file: 'test/acceptance.mjs',
    needs: () => HAS_VAULT,
    needDesc: `真实 Vault（${VAULT}）`,
    optionalInfra: true,
    pass: /通过 (\d+)\/(\d+)/,
    cwd: ROOT,
  },
  {
    layer: 'L3',
    name: '端到端：产物与面板数据一致性',
    file: 'test/e2e-verify.mjs',
    needs: () => HAS_VAULT,
    needDesc: `真实 Vault（${VAULT}）`,
    optionalInfra: true,
    pass: /通过 (\d+)\/(\d+)，失败 (\d+)/,
    cwd: ROOT,
  },
];

const results = [];
for (const s of SUITES) {
  // 「按设计跳过」与「环境缺失跳过」必须分开，否则严格模式失去意义：
  //   - 按设计：需要 DSH 安装目录 / 真实 Vault 这类**用户侧基础设施**
  //     （`optionalInfra`），CI runner 与普通使用者合法地可能没有；
  //   - 环境缺失：需要的是**仓库自己能提供的东西**（`npm install` 给
  //     schemastery）—— 这类跳过是配置事故，严格模式必须判失败。
  // 若对所有跳过都判失败，`--ci --strict` 将永远红（L3 必然跳过）。
  if (CI && s.layer === 'L3') {
    results.push({ ...s, status: 'SKIP', expectedSkip: true, detail: 'CI 模式跳过（按设计：需要运行中的 DSH + 真实 Vault）' });
    continue;
  }
  if (!s.needs()) {
    results.push({ ...s, status: 'SKIP', expectedSkip: s.optionalInfra === true, detail: `缺 ${s.needDesc}` });
    continue;
  }
  const cwd = s.cwd ?? STAGE;
  try {
    const out = execFileSync(NODE, [s.file], {
      encoding: 'utf-8',
      timeout: 300000,
      cwd,
      env: {
    ...process.env,
    DSH_APP_DIR: DSH_APP,
    OBSIDIAN_VAULT_PATH: VAULT,
    // 真实工作区根。staging 模式下测试文件跑在 profile 的 node_modules 里，
    // `import.meta.url` 推出的是**暂存路径**，而 junction 指向工作区 ——
    // 不传这个变量，e2e-verify 的 ENV-1 会拿暂存路径去比 junction 目标，必然 FAIL。
    OBSIDIAN_WORKSPACE_ROOT: ROOT,
  },
    });
    const m = out.match(s.pass);
    // 失败数的捕获组位置：默认第 3 组（如 e2e-verify 的「失败 N」）。
    // 各套件输出格式不同（有的把总数放在第 3 组），因此允许用 `failedGroup` 显式指定。
    // 注意：套件自身的 exit(1) 也会被上面的 execFileSync 抛错捕获，这里只是双保险。
    const failedGroup = s.failedGroup ?? 3;
    const failed = m && m[failedGroup] !== undefined ? Number(m[failedGroup]) : 0;
    results.push({
      ...s,
      status: failed === 0 && m ? 'PASS' : 'FAIL',
      detail: m ? m[0] : (out.trim().split('\n').pop() ?? ''),
      output: out,
    });
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '');
    results.push({ ...s, status: 'FAIL', detail: out.trim().split('\n').slice(-3).join(' | ') || String(error.message), output: out });
  }
}

cleanup();

// ---- 输出 ----
console.log('\n' + '='.repeat(72));
console.log(`  obsidian-bridge 测试总览${CI ? '（CI 模式）' : ''}`);
console.log('='.repeat(72));
let lastLayer = '';
for (const r of results) {
  if (r.layer !== lastLayer) {
    const label = { L1: 'L1 契约（平台 API 一致性）', L2: 'L2 单元/接线（mock ctx）', L3: 'L3 端到端（真实环境）' }[r.layer];
    console.log(`\n  ${label}`);
    lastLayer = r.layer;
  }
  const mark = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ' }[r.status];
  const tag = r.status === 'SKIP' ? (r.expectedSkip ? '（按设计跳过）' : '（⚠️ 环境缺失，非设计内）') : '';
  console.log(`    ${mark} ${r.name}${tag}`);
  if (r.detail) console.log(`         ${String(r.detail).slice(0, 150)}`);
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP');
const skipExpected = skipped.filter((r) => r.expectedSkip).length;
const skipUnexpected = skipped.length - skipExpected;
console.log('\n' + '-'.repeat(72));
console.log(`  通过 ${pass} ｜ 失败 ${fail} ｜ 跳过 ${skipped.length}（按设计 ${skipExpected} / 环境缺失 ${skipUnexpected}）（共 ${results.length} 套件）`);
if (skipExpected > 0) {
  console.log('  ℹ️  「按设计跳过」= CI 环境本就没有该依赖（DSH 安装目录 / 真实 Vault），需本地补跑。');
}
if (skipUnexpected > 0) {
  console.log('  ⚠️  「环境缺失」= 本应能跑却缺依赖（如未 npm install）—— 严格模式下判为失败。');
}
console.log('-'.repeat(72) + '\n');

if (fail > 0) process.exit(1);
// 严格模式只对「环境缺失」的跳过判失败。
// 若对**所有**跳过判失败，`--ci --strict` 将永远红（L3 在 CI 下必然跳过），
// 严格模式就失去了意义 —— 那正是「隐性跳过等于不存在」的另一种表现。
if (STRICT && skipUnexpected > 0) {
  console.log(`  严格模式：${skipUnexpected} 个套件因环境缺失被跳过（非设计内），判定为失败\n`);
  process.exit(1);
}
if (STRICT && skipUnexpected === 0) {
  console.log('  严格模式：无「环境缺失」跳过项 ✅（按设计跳过的套件需本地补跑）\n');
}
process.exit(0);
