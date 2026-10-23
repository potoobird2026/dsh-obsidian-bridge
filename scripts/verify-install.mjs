/**
 * 安装后自检：重启 DSH 后跑这一条命令，一次性确认全部关键项。
 *
 * ## 为什么需要它
 *
 * 插件模块在 Host 启动时加载一次，改动后必须重启才能生效。
 * 但「重启后是否正常」此前只能靠翻日志判断 —— 本脚本把它变成一条命令。
 *
 * ## 用法
 *   node scripts/verify-install.mjs            # 完整自检
 *   node scripts/verify-install.mjs --quick    # 只跑静态检查（不需要 DSH 运行中）
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

/** DSH 安装与 profile。 */
const DSH_APP = process.env.DSH_APP_DIR || '<DSH_APP_DIR>';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';

/** 本地日期（`YYYY-MM-DD`）—— 日志文件名用本地时区。 */
function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
};

// ============================================================
// A. 静态检查（不需要 DSH 运行）
// ============================================================

/** A1. 语法 */
{
  let bad = 0;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'release-staging' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  const { execFileSync } = await import('node:child_process');
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    } catch {
      bad += 1;
    }
  }
  check(`A1 语法检查（${files.length} 个文件）`, bad === 0, bad === 0 ? '' : `${bad} 个文件语法错误`);
}

/** A2. 清单字段 */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const need = ['name', 'version', 'main', 'exports', 'dsh'];
  const missing = need.filter((k) => pkg[k] === undefined);
  const ok = missing.length === 0 && pkg.private === false && pkg.dsh.manifestVersion === 1;
  check(
    'A2 package.json 清单字段',
    ok,
    ok ? `v${pkg.version}` : `缺失：${missing.join(', ')}`,
  );
}

/** A3. 发布树无真实密钥 */
{
  const staging = path.join(ROOT, 'release-staging');
  let hits = 0;
  let note = '';
  if (fs.existsSync(staging)) {
    // **必须检查发布树本身**，而不是跑 `--scan` ——
    // `--scan` 扫的是工作树（含 D:/MyVault 等本地路径，123 处属正常），
    // 发布树才是真正要上传的东西。
    // 密钥**赋值**才危险（`KEY: value` / `KEY=value`）；
    // **比较表达式不算** —— `OBSIDIAN_BRIDGE_HMAC_SECRET === 's3cret'` 是测试夹具
    // （test/cross-review-host.md L480），值是假的。
    // 把 `=` 加进否定类可排除 `===`：否则第 2 个 `=` 被 `[:=]` 匹配、
    // 第 3 个被 `[^'"\s]` 匹配 —— 实测就是这么误报的。
    const SENSITIVE =
      /D:\/MyLibrary|C:\\Users|<USER>|\.workbuddy|OBSIDIAN_BRIDGE_HMAC_SECRET\s*[:=]\s*[^'"\s=]/;
    // 脱敏与自检脚本自身**合法地**包含这些模式（它们就是靠匹配它们工作的），
    // 把它们算进去只会得到误报 —— 它们的正则字面量就是 `.workbuddy` / `C:\Users`。
    const SKIP = new Set(['scripts/prepare-github.mjs', 'scripts/verify-install.mjs']);
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(staging, p).replace(/\\/g, '/');
        if (e.isDirectory()) walk(p);
        else if (SKIP.has(rel)) continue;
        else if (/\.(js|mjs|json|yml|md|svg)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf-8');
          for (const line of text.split('\n')) {
            if (SENSITIVE.test(line)) {
              hits += 1;
              if (!note) note = `${rel}: ${line.trim().slice(0, 80)}`;
            }
          }
        }
      }
    };
    walk(staging);
  }
  check('A3 发布树敏感命中', hits === 0, hits === 0 ? '0 处' : `${hits} 处，例：${note}`);
}

/** A4. Vault 知识条目 */
{
  const kbDir = path.join(VAULT, '30_Resources');
  let kb = 0;
  let real = 0;
  if (fs.existsSync(kbDir)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) {
          if (e.name.startsWith('KB-')) kb += 1;
          else real += 1;
        }
      }
    };
    walk(kbDir);
  }
  check('A4 Vault 知识条目', kb > 0 && real > 0, `知识条目 ${kb} 条 / 真实知识 ${real} 篇`);
}

/** A6. profile 是否注册了本插件（最致命的故障类） */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const profilePkgPath = path.join(PROFILE_DIR, 'package.json');
  let note = '';
  let ok = true;
  if (!fs.existsSync(profilePkgPath)) {
    ok = false;
    note = 'profile 的 package.json 不存在';
  } else {
    const pp = JSON.parse(fs.readFileSync(profilePkgPath, 'utf-8'));
    const dep = pp.dependencies?.['@local/obsidian-bridge'];
    const bundles = pp.dsh?.profile?.bundles ?? [];
    if (!dep) {
      ok = false;
      note = 'profile 的 dependencies 缺 @local/obsidian-bridge';
    } else if (!bundles.includes('@local/obsidian-bridge')) {
      ok = false;
      note = 'profile 的 dsh.profile.bundles 缺 @local/obsidian-bridge';
    } else {
      note = 'dependencies + bundles 均已注册';
    }
  }
  check('A6 profile 已注册插件 bundle', ok, note);
}

/** A7. junction 链接存在（@local 解析的实际来源） */
{
  const linkPath = path.join(PROFILE_DIR, 'node_modules', '@local', 'obsidian-bridge');
  let ok = false;
  let note = '';
  try {
    const st = fs.lstatSync(linkPath);
    const isLink = st.isSymbolicLink() || fs.statSync(linkPath).isDirectory();
    ok = isLink && fs.existsSync(path.join(linkPath, 'index.js'));
    note = ok ? 'junction 指向工作区且 index.js 存在' : 'junction 存在但 index.js 缺失';
  } catch {
    note = 'junction 不存在 —— @local/obsidian-bridge 无法解析';
  }
  check('A7 @local junction 链接', ok, note);
}

/** A8. 插件 bundle 的 patch 含配置（插件加载的真实来源） */
{
  const patchPath = path.join(ROOT, 'cordis.patch.yml');
  let ok = false;
  let note = '';
  try {
    const text = fs.readFileSync(patchPath, 'utf-8');
    // bundle 用 `- insert:` 包裹自己的行；配置在行内 `config:` 下
    const hasRow = /- id: obsidian-bridge\s*\n\s+name:\s*'@local\/obsidian-bridge'/.test(text);
    const hasVault = /vaultPath:\s*(\S+)/.test(text);
    if (!hasRow) {
      note = 'bundle patch 缺 obsidian-bridge 行 —— 插件不会加载';
    } else if (!hasVault) {
      note = 'bundle patch 有行但缺 vaultPath 配置';
    } else {
      ok = true;
      note = 'bundle patch 含行 + vaultPath 配置';
    }
  } catch (error) {
    note = `读取失败: ${error?.message ?? error}`;
  }
  check('A8 bundle patch 含插件配置', ok, note);
}

/** A9. profile patch 与 bundle patch 的 vaultPath 一致（若 profile 也声明了） */
{
  const a = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf-8');
  const b = fs.readFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), 'utf-8');
  const getVault = (t) => (t.match(/vaultPath:\s*(\S+)/) ?? [])[1];
  const va = getVault(a);
  const vb = getVault(b);
  // profile patch 的条目是**可选的**（bundle 自带 patch 才是必需），
  // 所以只在它声明了 vaultPath 时才要求一致。
  const ok = vb === undefined ? true : va === vb;
  check(
    'A9 vaultPath 一致（bundle patch vs profile patch）',
    ok,
    vb === undefined ? `profile 未重复声明（以 bundle 为准 ${va}）` : va === vb ? `均为 ${va}` : `bundle=${va} / profile=${vb}`,
  );
}

/** A5. 本地日期日志 */
{
  const logDir = path.join(VAULT, '00_InteractionLogs');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hasToday = fs.existsSync(path.join(logDir, `${today}_conversation.md`));
  check('A5 本地日期日志', hasToday, hasToday ? `${today}_conversation.md 存在` : `${today}_conversation.md 不存在`);
}

// ============================================================
// B. 运行时检查（需要 DSH 运行中）
// ============================================================

if (!QUICK) {
  const logDir = path.join(process.env.APPDATA || '', 'DSH Desktop', 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const hostLog = path.join(logDir, 'host', `dsh-${today}.log`);
  const appLog = path.join(logDir, `dsh-${today}.log`);

  /** B1. 插件未 pending */
  {
    let pending = false;
    for (const f of [hostLog]) {
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf-8');
      if (text.includes('obsidian-bridge') && /pending \(waiting for service/.test(text)) pending = true;
    }
    check('B1 插件未处于 pending', !pending, pending ? '日志中出现 pending (waiting for service)' : '');
  }

  /** B2. 运行中的插件已加载新代码 */
  {
    // 两个信号，任一成立即证明新代码已生效：
    // ① 启动自检日志（Host 冷启动时 apply() 末尾打出）
    // ② 用户在今天被记录（P0 修复的 prompt 闸门 —— 修复前恒为 0）
    // HMR 热重载不会重跑 apply()，所以 ① 可能缺失；此时 ② 是更强的证据。
    let selfCheck = false;
    let promptLogged = false;
    for (const f of [hostLog]) {
      if (!fs.existsSync(f)) continue;
      if (fs.readFileSync(f, 'utf-8').includes('启动自检')) selfCheck = true;
    }
    const convLog = path.join(VAULT, '00_InteractionLogs', `${localDate()}_conversation.md`);
    if (fs.existsSync(convLog)) {
      const text = fs.readFileSync(convLog, 'utf-8');
      const hits = (text.match(/用户 prompt:/g) ?? []).length;
      promptLogged = hits > 0;
      if (promptLogged && !selfCheck) {
        check('B2 运行中的插件已加载新代码', true, `启动自检缺失（HMR 不重跑 apply），但今日已记录 ${hits} 条用户 prompt ✅`);
      } else {
        check(
          'B2 运行中的插件已加载新代码',
          selfCheck,
          selfCheck ? '启动自检日志存在' : '既无启动自检也无用户 prompt 记录 —— 插件可能未加载新代码',
        );
      }
    } else {
      check('B2 运行中的插件已加载新代码', selfCheck, selfCheck ? '启动自检日志存在' : `今日无 conversation 日志（${convLog}）`);
    }
  }

  /** B3. 插件无错误日志 */
  {
    let errs = 0;
    const samples = [];
    for (const f of [hostLog, appLog]) {
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      for (const l of lines) {
        // 只认**插件自己打的** error：`[E] [obsidian-bridge] ...`
        // 不能只看行里有没有 "obsidian-bridge" —— `execute.failed` 之类的
        // 平台事件也可能在别的字段里带上它，那样会把无关错误算进来（实测 15 条误报）。
        const m = l.match(/\[E\] \[obsidian-bridge\] (.+)$/);
        if (m) {
          errs += 1;
          if (samples.length < 3) samples.push(m[1].slice(0, 120));
        }
      }
    }
    check('B3 插件无 error 日志', errs === 0, errs === 0 ? '' : `${errs} 条，例：${samples.join(' | ')}`);
  }

  /** B4. 面板取数成功 */
  {
    let ok = false;
    for (const f of [appLog]) {
      if (!fs.existsSync(f)) continue;
      if (fs.readFileSync(f, 'utf-8').includes('面板首次取数成功')) ok = true;
    }
    check('B4 面板取数成功', ok, ok ? '存在' : '未找到 —— 可能未打开过面板');
  }
}

// ============================================================
// 输出
// ============================================================
console.log('');
console.log(QUICK ? '安装后自检（静态）' : '安装后自检');
console.log('='.repeat(64));
let pass = 0;
for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  if (r.ok) pass += 1;
  console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log('='.repeat(64));
console.log(`  通过 ${pass}/${results.length}`);
if (!QUICK && pass < results.length) {
  console.log('');
  console.log('  ⚠️  若 B2 失败，说明运行的仍是旧代码 —— 请重启 DSH Desktop 后重跑。');
}
process.exit(pass === results.length ? 0 : 1);

