/**
 * 发布前安全检查 + 脱敏发布树生成。
 *
 * ## 为什么需要它
 *
 * 本插件的**工作副本**是活配置的一部分：它经 junction 挂在
 * `~/.dsh/profiles/desktop/node_modules/@local/obsidian-bridge`，而
 * `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`，
 * 该 bundle patch 会**先于 profile 的 cordis.patch.yml 被合成**（实测依据：
 * profile patch 第 573-577 行的注释「declared by the ... BUNDLE patch, which is
 * composed before this file」）。所以：
 *
 *   ⚠️ **不能就地改写 `cordis.patch.yml`** —— 那会把正在运行的 Vault 路径改掉。
 *
 * 因此本脚本的做法是「**扫描 + 生成脱敏副本**」，而不是「就地修改」：
 *
 * | 模式 | 作用 | 是否改文件 |
 * |---|---|---|
 * | `--scan`（默认） | 扫描敏感内容，按「是否进入发布树」分级报告 | 否 |
 * | `--stage[=dir]` | 生成脱敏发布树（默认 `release-staging/`）并复检为 0 命中 | 只写 staging |
 * | `--check-vault` | 校验 Vault 的本地 git 是否安全（无远端 / 无真实邮箱 / 敏感项已忽略） | 否 |
 *
 * ## 绝不 push
 *
 * 本脚本**没有任何** push / 网络代码。传入 `--push` 会被显式拒绝。
 *
 * ## 密钥只报位置，不报正文
 *
 * 任何疑似密钥的命中只输出 `文件:行号` 与**掩码后的类型**（如 `ghp_…(40)`），
 * 不输出原文。
 *
 * 用法：
 *   node scripts/prepare-github.mjs
 *   node scripts/prepare-github.mjs --json
 *   node scripts/prepare-github.mjs --stage
 *   node scripts/prepare-github.mjs --stage=out/github
 *   node scripts/prepare-github.mjs --check-vault
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const STAGE_ARG = ARGV.find((a) => a === '--stage' || a.startsWith('--stage='));
const CHECK_VAULT = ARGV.includes('--check-vault');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';

// ------------------------------------------------------------
// 0. 明确拒绝 push
// ------------------------------------------------------------
if (ARGV.some((a) => /^--(push|publish|upload|deploy)$/.test(a))) {
  console.error('拒绝执行：本脚本只做「准备」，不会 push 到任何远端。');
  console.error('推送必须由人工在确认 docs/RELEASE-SECURITY.md 清单后手动执行。');
  process.exit(2);
}

// ------------------------------------------------------------
// 1. 发布树策略
// ------------------------------------------------------------
/** 一律进入发布树的路径（相对仓库根，正斜杠）。 */
const PUBLISH_INCLUDE = [
  '.gitignore',
  'README.md',
  'LICENSE',
  'package.json',
  'index.js',
  'client.js',
  'typert.host.js',
  'icon.svg',
  'cordis.patch.yml',
  '.github/workflows/ci.yml',
  'lib/',
  'locale/',
  'scripts/',
  'docs/CONFIG.md',
  'docs/TROUBLESHOOTING.md',
  'docs/CHANGELOG.md',
  // 这两份被 CONFIG / TROUBLESHOOTING / CHANGELOG 大量引用（入链 3 / 2 次），
  // 排除会让公开仓库出现断链（check-doc-links.mjs 会红）。
  // 它们本身不含私密笔记标题或对话正文，只有本机绝对路径 —— 由 SANITIZE 处理。
  'docs/RETROSPECTIVE.md',
  'docs/RELEASE-1.0.md',
  'docs/KNOWLEDGE-PIPELINE.md',
  // 注意：BEST-PRACTICES / DOC-IMPROVEMENT-PLAN / RELEASE-SECURITY 与
  // test/evidence/* 等**刻意留在 PUBLISH_EXCLUDE 里**（RELEASE-SECURITY 引用了
  // 私密笔记的真实文件名，evidence/* 含本机日志摘录）—— 不要在 INCLUDE 里
  // 加它们，INCLUDE − EXCLUDE 才是发布集。
  'test/contract.mjs',
  'test/run-all.mjs',
  'test/run.mjs',
  'test/wiring.mjs',
  'test/status-refresh.mjs',
  'test/audit-counters.mjs',
  'test/acceptance.mjs',
  'test/e2e-verify.mjs',
  // audit-counters / audit-flow 用它解析暂存目录（不能用 DSH profile —— CI 上会缺依赖）
  'test/lib-staging.mjs',
  // 测试文档与覆盖率工具：公开仓库应能说明「怎么测、测了什么」
  'test/coverage.mjs',
  'test/test-suite-plan.md',
  'test/cross-review-host.md',
  'test/cross-review-tests.md',
];

/**
 * 排除的路径，附理由。发布树 = INCLUDE − EXCLUDE。
 * 这里的条目与仓库根 `.gitignore` 保持一致（双保险）。
 *
 * 注意 `.gitignore` 与这里的**目的不同**，因此同一文件可能同时出现在
 * `.gitignore` 与 `PUBLISH_INCLUDE` 里：
 *   - `.gitignore` 管「**工作副本**绝不入库」（原文含本机路径）；
 *   - `PUBLISH_INCLUDE` 管「**脱敏后的副本**可以发布」。
 */
const PUBLISH_EXCLUDE = {
  'docs/DOC-IMPROVEMENT-PLAN.md': '内部计划文档；且它是 check-line-counts 里 3 条过期行数声明的唯一来源，纳入会让 CI 变红',
  'docs/BEST-PRACTICES.md': '内部工程规范；无入链（入链 0），排除不影响链接图',
  'docs/RELEASE-SECURITY.md': '维护者文档；§1.4 引用了私密笔记的真实文件名，§4 含本机绝对路径',
  // 以下为一次性审计脚本与发现报告：已在测试体系收敛时删除或移入 test/evidence/。
  // 保留键位的是**移入** evidence 的四份报告 —— 它们含本机绝对路径与日志摘录，
  // 必须继续排除在发布树外（路径已随迁移更新）。
  'test/evidence/audit-panel-fields.md': '审计发现报告（含本机日志摘录）',
  'test/evidence/backend-findings.md': '审计发现报告（含本机日志摘录）',
  'test/evidence/frontend-findings.md': '审计发现报告（含本机日志摘录）',
  'test/evidence/lead-findings.md': '审计发现报告（含本机日志摘录）',
  'test/audit-flow.md': '审计发现报告（含本机日志摘录）；其守卫 audit-flow.mjs 已接入 run-all',
  'test/audit-counters.md': '审计发现报告（含本机日志摘录）',
  'test/e2e-verification.md': '端到端取证报告（含真实 Vault 路径与产物内容）',
};

const NEVER_WALK = new Set(['node_modules', '.git', 'release-staging', 'dist', 'build', 'publish']);

/**
 * 自身豁免：本文件**定义**了全部敏感模式，因此正文里必然出现
 * `D:/MyVault`、`<USER>` 等字面量。扫描时跳过自己，避免自我命中。
 *
 * 代价：本文件内部若真的写入了密钥不会被本脚本发现 —— 所以它必须保持
 * 「只含模式定义，不含任何真实凭据」。
 */
// 扫描器**自身**合法地包含敏感模式（正则字面量），必须豁免，否则自指误报。
// 新增含敏感模式的脚本时，记得加进来。
const SELF_EXEMPT = new Set(['scripts/prepare-github.mjs', 'scripts/verify-install.mjs']);

// ------------------------------------------------------------
// 2. 敏感内容规则
// ------------------------------------------------------------
/**
 * 每条规则：`id` / `severity` / `label` / `re` / 可选 `allow`。
 * `severity: 'critical'` = 凭据；`'high'` = 本机身份/绝对路径；`'medium'` = 其他 PII。
 */
const RULES = [
  {
    id: 'secret-github-pat',
    severity: 'critical',
    label: 'GitHub PAT',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: 'secret-openai-style',
    severity: 'critical',
    label: 'OpenAI 风格 API key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  { id: 'secret-aws-akid', severity: 'critical', label: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    id: 'secret-private-key',
    severity: 'critical',
    label: 'PEM 私钥块',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  { id: 'secret-slack', severity: 'critical', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'secret-bearer',
    severity: 'critical',
    label: 'Bearer token 字面量',
    re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/g,
  },
  {
    id: 'path-vault',
    severity: 'high',
    label: 'Vault 绝对路径',
    re: /[A-Za-z]:[\\/]MyLibrary\b/g,
  },
  {
    id: 'path-userhome',
    severity: 'high',
    label: 'Windows 用户目录绝对路径',
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+/g,
  },
  {
    id: 'path-workbuddy',
    severity: 'high',
    label: '.workbuddy 私有目录路径',
    re: /[A-Za-z]:[\\/]{1,2}[^\s'"`]*\.workbuddy[^\s'"`]*/g,
  },
  {
    id: 'path-node-exe',
    severity: 'medium',
    label: 'node.exe 绝对路径',
    re: /[A-Za-z]:[\\/]{1,2}Program Files[\\/]{1,2}nodejs[\\/]{1,2}node\.exe/g,
  },
  {
    id: 'path-dsh-app',
    severity: 'high',
    label: 'DSH 安装目录绝对路径',
    re: /[A-Za-z]:[\\/]{1,2}deepseek deskt[\\/]{1,2}DSH Desktop[\\/]{1,2}resources[\\/]{1,2}app/g,
  },
  {
    id: 'pii-username',
    severity: 'high',
    label: '本机用户名',
    re: /\b46628\b/g,
  },
  {
    id: 'pii-email',
    severity: 'medium',
    label: '邮箱地址',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // 合成身份与示例域名不算 PII
    allow: [/@localhost$/i, /@example\.(com|org|net)$/i, /@users\.noreply\.github\.com$/i, /^noreply@/i],
  },
];

/** 只扫描这些扩展名的文本内容（其余按文件名判断）。 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt', '.svg', '.html', '.css']);

/** 把疑似敏感值掩码，绝不输出正文。 */
function mask(value) {
  const v = String(value);
  if (v.length <= 6) return `${v.slice(0, 2)}…(${v.length})`;
  const head = /^(ghp|gho|ghu|ghs|ghr|github_pat|sk|xox|AKIA|Bearer)/i.test(v) ? v.slice(0, 4) : v.slice(0, 3);
  return `${head}…(${v.length})`;
}

// ------------------------------------------------------------
// 3. 遍历与扫描
// ------------------------------------------------------------
/** 相对仓库根、正斜杠形式。 */
function rel(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

/** 递归收集文件（跳过 NEVER_WALK）。 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (NEVER_WALK.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * 从 `test/run-all.mjs` 的 SUITES 列表推导必须一起发布的测试文件。
 *
 * 理由：`run-all.mjs` 是 CI 的入口，它 `execFileSync` 每一个 `file: 'test/x.mjs'`。
 * 如果发布树里缺了其中任何一个，CI 会以 ENOENT 失败。**让两份清单无法漂移**
 * —— 队友新增套件时，发布集自动跟上。
 * @returns 相对仓库根的路径集合。
 */
function suitesFromRunAll() {
  const entry = path.join(ROOT, 'test', 'run-all.mjs');
  if (!fs.existsSync(entry)) return new Set();
  const text = fs.readFileSync(entry, 'utf-8');
  const out = new Set();
  for (const m of text.matchAll(/file:\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

const DERIVED_INCLUDE = suitesFromRunAll();

/** 判断一个相对路径是否进入发布树。 */
function inPublishTree(r) {
  if (PUBLISH_EXCLUDE[r]) return false;
  if (DERIVED_INCLUDE.has(r)) return true;
  // 目录级 include
  for (const inc of PUBLISH_INCLUDE) {
    if (inc.endsWith('/')) {
      if (r.startsWith(inc)) return !PUBLISH_EXCLUDE[r];
    } else if (r === inc) {
      return true;
    }
  }
  return false;
}

/** 扫描一批文件，返回命中列表。 */
/**
 * 扫描文件列表里的敏感内容。
 *
 * `selfExemptPrefix` 用于**发布树复检**：`walk(staging)` 给出的路径带
 * `release-staging/` 前缀，而 `SELF_EXEMPT` 里存的是相对仓库根的路径
 * （如 `scripts/prepare-github.mjs`）。不剥前缀的话豁免会失效，
 * 脱敏脚本会把自己（`\b46628\b` 这类正则字面量）报成命中 —— 自指误报。
 * @param files - 绝对路径列表。
 * @param selfExemptPrefix - 需要剥掉的前缀（发布树根目录），可为空。
 * @returns 命中列表。
 */
function scanFiles(files, selfExemptPrefix = '') {
  const hits = [];
  for (const abs of files) {
    let r = rel(abs);
    // 统一用正斜杠比较 —— Windows 下 `rel()` 产出 `\`，而 SELF_EXEMPT 里是 `/`，
    // 不归一化会漏判（实测正是这个原因让豁免失效）。
    r = r.replace(/\\/g, '/');
    if (selfExemptPrefix && r.startsWith(selfExemptPrefix)) {
      r = r.slice(selfExemptPrefix.length).replace(/^[\\/]/, '');
    }
    if (SELF_EXEMPT.has(r)) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // 二进制
    const lines = text.split('\n');
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line)) !== null) {
          const raw = m[0];
          if (rule.allow?.some((a) => a.test(raw))) continue;
          hits.push({
            file: r,
            line: i + 1,
            ruleId: rule.id,
            severity: rule.severity,
            label: rule.label,
            masked: mask(raw),
            published: inPublishTree(r),
          });
          if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
        }
      }
    }
  }
  return hits;
}

// ------------------------------------------------------------
// 4. 脱敏规则（只作用于 staging 副本）
// ------------------------------------------------------------
/** 顺序敏感：更具体的规则必须排在更宽泛的规则之前。 */
const SANITIZE = [
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}<USER>[\\/]{1,2}\.workbuddy[^\s'"`]*/g, '<YOUR_WORKBUDDY_PATH>'],
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}<USER>/g, '<USER_HOME>'],
  [/[A-Za-z]:[\\/]{1,2}deepseek deskt[\\/]{1,2}DSH Desktop[\\/]{1,2}resources[\\/]{1,2}app/g, '<DSH_APP_DIR>'],
  [/[A-Za-z]:[\\/]{1,2}Program Files[\\/]{1,2}nodejs[\\/]{1,2}node\.exe/g, 'node'],
  [/[A-Za-z]:[\\/]MyLibrary/g, 'D:/MyVault'],
  [/\b46628\b/g, '<USER>'],
];

function sanitizeText(text) {
  let out = text;
  for (const [re, to] of SANITIZE) out = out.replace(re, to);
  return out;
}

/** 发布树专用的 .gitignore（比仓库根版简单：只挡依赖与本机配置）。 */
const PUBLISH_GITIGNORE = `# 依赖与本机配置
node_modules/
cordis.patch.yml.local
*.local.yml
.env
.env.*
!.env.example
*.log
*.tmp
.DS_Store
Thumbs.db
.idea/
.vscode/
`;

/** MIT LICENSE（版权人需自行替换）。 */
function licenseText() {
  return `MIT License

Copyright (c) 2026 <YOUR NAME OR ORG>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// ------------------------------------------------------------
// 5. 模式：--check-vault
// ------------------------------------------------------------
function runVaultCheck() {
  const findings = [];
  const info = [];
  /** 统一 findings 形状，便于输出层复用。 */
  const add = (id, severity, detail) => findings.push({ id, ruleId: id, severity, label: id, detail, masked: '', published: false, file: VAULT, line: 0 });
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', VAULT, ...args], { encoding: 'utf-8' }).trim();
    } catch (error) {
      return `__ERROR__${error.message}`;
    }
  };
  // 先自检判定逻辑本身 —— 检查器错了比不检查更危险（会给出假绿/假红）
  const selfTestFailures = selfTestGitignoreCovers();
  if (selfTestFailures.length > 0) {
    for (const f of selfTestFailures) add('checker-self-test', 'critical', f);
  } else {
    info.push(`检查器自检：gitignoreCovers 12 个用例全通过 ✅`);
  }
  if (!fs.existsSync(path.join(VAULT, '.git'))) {
    add('vault-no-git', 'high', `${VAULT} 不是 git 仓库（无本地版本控制）`);
  } else {
    const remotes = git(['remote', '-v']);
    if (remotes.startsWith('__ERROR__')) add('vault-git-error', 'high', remotes);
    else if (remotes.length > 0) {
      add(
        'vault-has-remote',
        'critical',
        `Vault 配了远端 —— 私密数据可能已被推送。立即执行：git -C "${VAULT}" remote remove <name>`,
      );
    } else info.push('远端：未配置 ✅');

    const author = git(['log', '-1', '--format=%an <%ae>']);
    if (!author.startsWith('__ERROR__')) {
      // 注意：author 形如 `Name <mail>`，域名判断要允许结尾的 `>`
      const isSynthetic = /@localhost>?\s*$|@users\.noreply\.github\.com>?\s*$/i.test(author);
      if (isSynthetic) info.push('提交身份：合成身份（无真实邮箱）✅');
      else add('vault-real-email', 'medium', `提交作者含真实邮箱：${author.replace(/<[^>]+>/, '<EMAIL>')}`);
    }

    const tracked = git(['ls-files']);
    if (!tracked.startsWith('__ERROR__')) {
      const files = tracked.split('\n').filter(Boolean);
      info.push(`已跟踪文件：${files.length} 个`);
      const sensitive = files.filter((f) =>
        /bridge-diagnostics\.jsonl$|memory-sync\/user-memory\.md$|memory-sync\/workspace-user-memory\.md$|^90_Agent\/(audit|governance)\//.test(f));
      if (sensitive.length > 0) {
        add('vault-sensitive-tracked', 'high', `${sensitive.length} 个敏感文件已被跟踪：${sensitive.slice(0, 3).join(', ')}${sensitive.length > 3 ? ' …' : ''}`);
      }
    }
  }

  // 敏感项是否被 .gitignore 覆盖
  const giPath = path.join(VAULT, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : '';
  const mustIgnore = [
    ['90_Agent/bridge-diagnostics.jsonl', '运行时诊断日志（每次 prompt 都变，造成工作树长期脏）'],
    ['90_Agent/memory-sync/user-memory.md', '个人记忆（用户画像）'],
    ['90_Agent/memory-sync/workspace-user-memory.md', '个人记忆（工作区）'],
    ['90_Agent/audit/', '审计产物（含全库扫描结果）'],
    ['00_InteractionLogs/*.jsonl', '原始运行痕迹'],
  ];
  for (const [pat, why] of mustIgnore) {
    if (!gitignoreCovers(gi, pat)) add('vault-gitignore-gap', 'high', `.gitignore 未覆盖 ${pat} —— ${why}`);
  }
  return { findings, info };
}

/**
 * 判断 .gitignore 是否**真的**覆盖某个路径。
 *
 * 不能用「顶级目录名出现过」当判据 —— Vault 的 .gitignore 里有
 * `90_Agent/knowledge-organize-cursor.json`，若只查 `90_Agent` 会把
 * `90_Agent/audit/` 误判为已覆盖。
 * @param gitignore - .gitignore 正文。
 * @param target - 待判定的仓库相对路径（可含 `*`，可带尾斜杠）。
 * @returns 是否被覆盖。
 */
function gitignoreCovers(gitignore, target) {
  const norm = (s) => s.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const rules = gitignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map(norm);
  // 两侧都归一化：规则与目标都可能写成目录形式（带尾斜杠）。
  // 曾因只归一化规则、不归一化目标，把 `90_Agent/audit/` 误报为「未覆盖」。
  const t = norm(target);
  return rules.some((r) => {
    if (r === '') return false;
    if (r === t) return true; // 精确匹配（含「目录形式 vs 目录形式」）
    // `dir/**`：覆盖 dir 自身与 dir/ 下全部
    if (r.endsWith('/**')) {
      const base = r.slice(0, -3);
      if (t === base || t.startsWith(`${base}/`)) return true;
    }
    // 纯目录规则（无通配符）：覆盖其下全部
    if (!/[*?]/.test(r) && t.startsWith(`${r}/`)) return true;
    // 含通配符：转 glob 正则
    if (/[*?]/.test(r) && globToRegExp(r).test(t)) return true;
    return false;
  });
}

/**
 * 把 .gitignore 的 glob 转成正则。
 *
 * 语义：`*` 不跨 `/`，`?` 匹配单个非 `/` 字符，`**` 跨 `/`，
 * `**\/` 允许零层目录。
 * @param pattern - 已归一化的 glob。
 * @returns 锚定到整串的正则。
 */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * `gitignoreCovers` 的自检。
 *
 * 上一版把目录形式的目标误判为「未覆盖」，导致 `--check-vault` 报假红。
 * 判定逻辑必须有自检，否则「检查器本身是错的」不会被发现。
 * @returns 失败用例描述数组（空 = 全通过）。
 */
function selfTestGitignoreCovers() {
  const gi = [
    '# comment',
    '.obsidian/workspace.json',
    '90_Agent/knowledge-organize-cursor.json',
    '00_InteractionLogs/*.jsonl',
    '90_Agent/audit/',
    '90_Agent/governance/',
    '90_Agent/bridge-diagnostics.jsonl',
    '90_Agent/memory-sync/user-memory.md',
    'build/**',
  ].join('\n');
  const cases = [
    // [目标, 期望被覆盖, 说明]
    ['90_Agent/audit/', true, '目录形式目标 vs 目录形式规则'],
    ['90_Agent/audit', true, '无尾斜杠目标 vs 目录形式规则'],
    ['90_Agent/audit/2026-10-22-audit.json', true, '目录下具体文件'],
    ['90_Agent/governance/', true, 'governance 目录'],
    ['90_Agent/bridge-diagnostics.jsonl', true, '精确文件规则'],
    ['90_Agent/memory-sync/user-memory.md', true, '精确文件规则'],
    ['00_InteractionLogs/hook-debug.log', false, '规则是 *.jsonl，.log 不应被覆盖'],
    ['00_InteractionLogs/x.jsonl', true, '通配符规则'],
    ['build', true, 'dir/** 覆盖 dir 自身'],
    ['build/out/a.js', true, 'dir/** 覆盖子路径'],
    ['90_Agent/agent-memory.md', false, '同目录下未被规则命中的文件'],
    ['30_Resources/x.md', false, '完全无关路径'],
    ['30_Resources/sub/deep.md', false, '目录规则不得跨目录误判'],
  ];
  const failed = [];
  for (const [target, expected, why] of cases) {
    const actual = gitignoreCovers(gi, target);
    if (actual !== expected) failed.push(`${why}: gitignoreCovers(${JSON.stringify(target)}) = ${actual}，期望 ${expected}`);
  }
  return failed;
}

// ------------------------------------------------------------
// 6. 模式：--stage
// ------------------------------------------------------------
function stage(dir) {
  const target = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  fs.rmSync(target, { recursive: true, force: true });
  const all = walk(ROOT);
  const copied = [];
  for (const abs of all) {
    const r = rel(abs);
    if (!inPublishTree(r)) continue;
    const dest = path.join(target, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ext = path.extname(abs).toLowerCase();
    if (TEXT_EXT.has(ext)) {
      fs.writeFileSync(dest, sanitizeText(fs.readFileSync(abs, 'utf-8')), 'utf-8');
    } else {
      fs.copyFileSync(abs, dest);
    }
    copied.push(r);
  }
  // 生成物
  fs.writeFileSync(path.join(target, '.gitignore'), PUBLISH_GITIGNORE, 'utf-8');
  if (!copied.includes('.gitignore')) copied.push('.gitignore');
  if (!fs.existsSync(path.join(target, 'LICENSE'))) {
    fs.writeFileSync(path.join(target, 'LICENSE'), licenseText(), 'utf-8');
    copied.push('LICENSE (生成，版权人待替换)');
  }

  // 第二遍：把指向「未发布文档」的 Markdown 链接降级为纯文本。
  // 否则公开仓库会出现断链，CI 的 check-doc-links.mjs 会红。
  const published = new Set(copied);
  const neutralized = [];
  for (const relPath of copied.filter((f) => f.endsWith('.md'))) {
    const abs = path.join(target, relPath);
    if (!fs.existsSync(abs)) continue;
    const before = fs.readFileSync(abs, 'utf-8');
    const after = neutralizeUnpublishedLinks(before, relPath, published);
    if (after !== before) {
      fs.writeFileSync(abs, after, 'utf-8');
      neutralized.push(relPath);
    }
  }
  return { target, copied, neutralized };
}

/**
 * 把指向未发布文档的 `[text](X.md)` 降级为 `` `text`（未随仓库发布） ``。
 *
 * 只处理**文件级** `.md` 链接，且跳过围栏代码块与行内代码 —— 与
 * `check-doc-links.mjs` 的口径保持一致。
 * @param text - 文档正文。
 * @param relPath - 该文档在发布树中的相对路径。
 * @param published - 发布树内的全部相对路径集合。
 * @returns 处理后的正文。
 */
function neutralizeUnpublishedLinks(text, relPath, published) {
  const segments = text.split(/(```[\s\S]*?```)/);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // 围栏代码块原样保留
      return seg.replace(/\[([^\]]+)\]\(([^)\s#]+\.md)(#[^)]*)?\)/g, (whole, label, target) => {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), target));
        if (published.has(resolved) || published.has(target)) return whole;
        return `\`${label}\`（未随仓库发布）`;
      });
    })
    .join('');
}

// ------------------------------------------------------------
// 6.5 真实文件名泄漏检查
// ------------------------------------------------------------
/**
 * 通用/模式化文件名 —— 它们在任何仓库都可能出现，不算泄漏。
 *
 * 判据：Vault 里同名的文件若在**多个不同目录**下都存在，或名字本身是
 * 本插件定义的模式（日志文件名），或属于极少数通用名（README/PRD），
 * 都不该被当作「本仓库特有的私密文件名」。
 */
const GENERIC_NAMES = new Set(['README.md', 'PRD.md', 'MEMORY-INDEX.md']);
const GENERIC_RE = [
  /^\d{4}-\d{2}-\d{2}_(conversation|decision|thinking|insight|memory-op|project-op|tool-op)\.md$/, // 日志名（插件定义的模式）
  /^[a-z-]+-memory\.md$/, // memory-sync 产物
  /^[A-Z]+-[A-Z]+-\d+\.md$/, // 知识图谱索引类
];

/**
 * 收集 Vault 里「非通用」的真实文件名，用于泄漏检查。
 *
 * **为什么需要**：笔记标题由对话内容派生（形如
 * `KB-<时间戳>_<slug>_<标题片段>.md`），公开仓库带上它们等于公开对话片段 ——
 * 这正是 `RELEASE-SECURITY.md` 被排除在发布树外的理由。
 * 此前 `KNOWLEDGE-PIPELINE.md` 与 `RELEASE-1.0.md` 就泄漏过真实笔记名
 * （2026-10-23 修复）。
 *
 * **本文件的注释里不要写真实文件名** —— 它会把自己报成命中（实测踩过）。
 * @returns Vault 里的非通用 .md 文件名集合。
 */
function collectVaultNoteNames() {
  const vault = process.env.OBSIDIAN_VAULT_PATH || 'D:/MyVault';
  if (!fs.existsSync(vault)) return new Set();
  const names = new Set();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.obsidian' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.md')) {
        if (GENERIC_NAMES.has(e.name)) continue;
        if (GENERIC_RE.some((re) => re.test(e.name))) continue;
        names.add(e.name);
      }
    }
  };
  walk(vault, 0);
  return names;
}

/**
 * 扫发布树里是否出现 Vault 的真实文件名。
 * @param stagingDir - 发布树根目录。
 * @returns 命中列表（`文件 ← 真实文件名`）。
 */
function scanRealNameLeaks(stagingDir) {
  const realNames = collectVaultNoteNames();
  if (realNames.size === 0) return [];
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(md|json|yml|js|mjs|svg)$/.test(e.name)) {
        const rel = path.relative(stagingDir, p).replace(/\\/g, '/');
        const text = fs.readFileSync(p, 'utf-8');
        for (const name of realNames) {
          if (text.includes(name)) hits.push(`${rel} ← ${name}`);
        }
      }
    }
  };
  walk(stagingDir);
  return hits;
}

// ------------------------------------------------------------
// 7. 主流程
// ------------------------------------------------------------
const out = { mode: '', findings: [], info: [], publishTree: [] };

if (CHECK_VAULT) {
  out.mode = 'check-vault';
  const { findings, info } = runVaultCheck();
  out.findings = findings;
  out.info = info;
} else if (STAGE_ARG) {
  out.mode = 'stage';
  const dir = STAGE_ARG.includes('=') ? STAGE_ARG.split('=')[1] : 'release-staging';
  const { target, copied, neutralized } = stage(dir);
  out.info.push(`发布树已生成：${rel(target)}（${copied.length} 个条目）`);
  if (neutralized.length > 0) {
    out.info.push(`已降级 ${neutralized.length} 份文档里指向未发布文档的链接：${neutralized.join(', ')}`);
  }
  // 复检：发布树必须 0 命中
  // 前缀也要归一化为 `/` —— `path.sep` 在 Windows 上是 `\`，
  // 而归一化后的路径用 `/`，`startsWith` 会永远为 false（实测正是这个原因）。
  const stagedPrefix = `${path.basename(target).replace(/\\/g, '/')}/`;
  const stagedHits = scanFiles(walk(target), stagedPrefix).map((h) => ({ ...h, published: true }));
  out.publishTree = copied;
  out.findings = stagedHits;
  if (stagedHits.length === 0) out.info.push('发布树复检：0 命中 ✅');
  else out.info.push(`发布树复检：仍有 ${stagedHits.length} 处命中 ❌（脱敏规则未覆盖）`);

  // **真实文件名泄漏检查**：发布树里出现 Vault 的真实笔记名 = 公开对话片段。
  // 与上面的模式扫描互补 —— 那个查「路径/密钥」，这个查「笔记标题」。
  const nameLeaks = scanRealNameLeaks(target);
  if (nameLeaks.length === 0) {
    out.info.push(`真实文件名检查：0 处泄漏 ✅（Vault 非通用文件名 ${collectVaultNoteNames().size} 个已比对）`);
  } else {
    out.info.push(`真实文件名泄漏 ❌ ${nameLeaks.length} 处（笔记标题由对话派生，不得公开）：`);
    for (const leak of nameLeaks.slice(0, 20)) out.info.push(`    ${leak}`);
    if (nameLeaks.length > 20) out.info.push(`    …（共 ${nameLeaks.length} 处）`);
  }
} else {
  out.mode = 'scan';
  const files = walk(ROOT);
  const hits = scanFiles(files);
  out.findings = hits;
  out.publishTree = files.map(rel).filter(inPublishTree).sort();
  const blockers = hits.filter((h) => h.published);
  out.info.push(`扫描 ${files.length} 个文件；进入发布树 ${out.publishTree.length} 个`);
  out.info.push(`命中 ${hits.length} 处：发布树内 ${blockers.length} 处（阻塞），开发产物内 ${hits.length - blockers.length} 处（不阻塞）`);
  out.info.push(`从 test/run-all.mjs 推导出 ${DERIVED_INCLUDE.size} 个必发测试文件`);
  // 配置矛盾：run-all.mjs 要跑的套件被 PUBLISH_EXCLUDE 挡掉了 → CI 必 ENOENT
  const contradictions = [...DERIVED_INCLUDE].filter((f) => PUBLISH_EXCLUDE[f]);
  if (contradictions.length > 0) {
    out.info.push(`❌ 配置矛盾：${contradictions.join(', ')} 被 run-all.mjs 引用，却又在 PUBLISH_EXCLUDE 里`);
    out.findings.push({
      file: 'scripts/prepare-github.mjs', line: 0, ruleId: 'publish-set-contradiction', severity: 'high',
      label: '发布集与 run-all.mjs 冲突', masked: '', published: true,
    });
  }
  // 依赖真实 Vault 的套件在发布树里会失败（路径已被脱敏为占位值）。
  //
  // 判据必须**推导**而不是写死清单 —— 写死的清单在修好之后会继续报假警告
  // （本项曾是 `['test/run.mjs','test/wiring.mjs','test/status-refresh.mjs']`，
  //  这三个文件改成 env 驱动后仍然被误报）。
  // 真正的判据：文件里出现 Vault 路径字面量，却**没有**读 OBSIDIAN_VAULT_PATH。
  const vaultDependent = out.publishTree
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs)) return false;
      const src = fs.readFileSync(abs, 'utf-8');
      return /MyLibrary|MyVault/.test(src) && !/OBSIDIAN_VAULT_PATH/.test(src);
    });
  if (vaultDependent.length > 0) {
    out.info.push(`⚠️ 以下套件写死了 Vault 路径且无 env 回退，脱敏后在本机跑会失败：${vaultDependent.join(', ')}`);
  } else {
    out.info.push('Vault 路径：所有发布套件都走 OBSIDIAN_VAULT_PATH ✅');
  }
}

// ------------------------------------------------------------
// 8. 输出
// ------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('\n' + '='.repeat(72));
  console.log(`  obsidian-bridge 发布安全检查 — 模式：${out.mode}`);
  console.log('='.repeat(72));
  for (const s of out.info) console.log(`  · ${s}`);

  if (out.mode === 'check-vault') {
    if (out.findings.length > 0) {
      console.log(`\n  ❌ Vault 备份安全隐患：${out.findings.length} 条`);
      for (const f of out.findings) console.log(`     [${f.severity}] ${f.label}\n        ${f.detail}`);
    } else {
      console.log('\n  ✅ Vault 本地 git 未发现安全隐患');
    }
  } else {
    if (out.mode === 'stage') {
      console.log('\n  发布树内容：');
      for (const f of out.publishTree) console.log(`    ${f}`);
    }

    const blockers = out.findings.filter((f) => f.published);
    const devOnly = out.findings.filter((f) => !f.published);

    if (blockers.length > 0) {
      console.log(`\n  ❌ 阻塞项（会进入发布树，必须先脱敏）：${blockers.length} 处`);
      for (const f of blockers) {
        console.log(`     [${f.severity}] ${f.file}:${f.line}  ${f.label}  ${f.masked}`);
      }
    } else {
      console.log('\n  ✅ 发布树内无敏感命中');
    }

    if (devOnly.length > 0) {
      const byRule = new Map();
      for (const f of devOnly) byRule.set(f.ruleId ?? 'unknown', (byRule.get(f.ruleId ?? 'unknown') ?? 0) + 1);
      console.log(`\n  ℹ️  仅存在于开发产物中的命中：${devOnly.length} 处（已被 .gitignore / 发布策略排除）`);
      for (const [id, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`     ${String(id).padEnd(22)} ${n} 处`);
      console.log('     明细：node scripts/prepare-github.mjs --json');
    }
  }

  console.log('\n' + '-'.repeat(72));
  console.log('  本脚本不会 push。推送前请逐条核对 docs/RELEASE-SECURITY.md 的清单。');
  console.log('-'.repeat(72) + '\n');
}

process.exit(out.findings.some((f) => f.published || out.mode === 'check-vault') ? 1 : 0);
