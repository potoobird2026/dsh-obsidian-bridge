/**
 * 行数口径守卫。
 *
 * ## 为什么需要它
 *
 * 本项目曾出现「同一文件三个人测出三个行数」的事故：
 *
 * ```
 * 2196  ← PowerShell 5.1 裸用 Get-Content | Measure-Object -Line
 * 1004  ← 另一种失真测法
 * 2643  ← 正确：node 读 UTF-8 后 split('\n')
 * ```
 *
 * 成因：Windows PowerShell 5.1 的 `[Text.Encoding]::Default` = **gb2312**，
 * 按 GBK 双字节解码 UTF-8 中文时会吞掉部分 `0x0A` 行边界。
 *
 * 本脚本用**唯一正确口径**统计，并与 `docs/` 中声明的数字比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 唯一正确口径：读 UTF-8 后按 LF 切分，末行换行不计。 */
function countLines(file) {
  const text = fs.readFileSync(file, 'utf-8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** 统计插件代码（排除 docs/、node_modules/）。 */
function collectCode() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'docs' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(ROOT);
  return out.sort();
}

const code = collectCode();
const codeTotal = code.reduce((n, f) => n + countLines(f), 0);

console.log('插件代码（UTF-8 口径）：');
for (const f of code) {
  console.log(`  ${path.relative(ROOT, f).replace(/\\/g, '/').padEnd(34)}${String(countLines(f)).padStart(5)} 行`);
}
console.log(`  ${'-'.repeat(40)}`);
console.log(`  合计 ${code.length} 个文件 / ${codeTotal} 行`);

const docs = fs.existsSync(path.join(ROOT, 'docs'))
  ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()
  : [];
let docTotal = 0;
console.log('\n文档（UTF-8 口径）：');
for (const f of docs) {
  const n = countLines(path.join(ROOT, 'docs', f));
  docTotal += n;
  console.log(`  ${f.padEnd(34)}${String(n).padStart(5)} 行`);
}
console.log(`  ${'-'.repeat(40)}`);
console.log(`  合计 ${docs.length} 份 / ${docTotal} 行`);

// ---- 守卫：文档中若声明了某个文件的行数，必须与实测一致 ----
//
// 只认**括号声明形式** `（NNN 行）`，例如：
//   | `docs/CONFIG.md` | 11 行配置表（...） | ✅ **已建**（275 行） |
// 注意 `11 行配置表` 指的是「表格有 11 行」，不是文件行数 ——
// 宽松匹配会把这类描述误判为行数声明。
const declarations = [];
for (const f of docs) {
  const text = fs.readFileSync(path.join(ROOT, 'docs', f), 'utf-8');
  for (const line of text.split('\n')) {
    // 该行必须提到一个 .md 文件名，且带括号行数声明
    const fileMention = line.match(/`?(?:docs\/)?([A-Za-z0-9._-]+\.md)`?/);
    const claim = line.match(/（\s*(\d{2,5})\s*行\s*）/);
    if (fileMention && claim) {
      declarations.push({ from: f, target: fileMention[1], claimed: Number(claim[1]) });
    }
  }
}

const mismatches = [];
for (const d of declarations) {
  const target = path.join(ROOT, 'docs', d.target);
  if (!fs.existsSync(target)) continue;
  const actual = countLines(target);
  if (actual !== d.claimed) {
    mismatches.push(`${d.from} 声明 ${d.target} = ${d.claimed} 行，实测 ${actual} 行`);
  }
}

console.log(`\n行数声明核对：${declarations.length} 条`);
if (mismatches.length > 0) {
  console.log('不一致：');
  for (const m of mismatches) console.log(`  ${m}`);
  console.log('\n提示：PowerShell 5.1 裸用 Get-Content 会因 gb2312 解码失真；');
  console.log('      请用 `node scripts/check-line-counts.mjs` 输出值更新文档。');
  process.exit(1);
}
console.log('全部一致 ✅');
