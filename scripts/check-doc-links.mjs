/**
 * 文档内部链接有效性检查。
 *
 * 只检查**文件级**链接（`[x](y.md)`），忽略代码块内的示例文本 ——
 * `DOC-IMPROVEMENT-PLAN.md` 里就有写给 README 用的根相对路径示例，
 * 那是正确的，不应被误判为断链。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 去掉围栏代码块（```...```）与行内代码（`...`）。 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** 收集所有待检查的 Markdown 文件（仓库根 + docs/）。 */
function collectMarkdown() {
  const out = [path.join(ROOT, 'README.md')];
  const docs = path.join(ROOT, 'docs');
  if (fs.existsSync(docs)) {
    for (const f of fs.readdirSync(docs)) {
      if (f.endsWith('.md')) out.push(path.join(docs, f));
    }
  }
  return out.filter((p) => fs.existsSync(p));
}

let total = 0;
const broken = [];

for (const file of collectMarkdown()) {
  const dir = path.dirname(file);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = stripCode(fs.readFileSync(file, 'utf-8'));
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    total += 1;
    // 仓库根相对路径（docs/X.md）与同目录相对路径（X.md）都支持
    const candidates = [
      path.resolve(dir, target),
      path.resolve(ROOT, target),
    ];
    if (!candidates.some((p) => fs.existsSync(p))) {
      broken.push(`${rel} -> ${target}`);
    }
  }
}

console.log(`检查 ${collectMarkdown().length} 份 Markdown，共 ${total} 条文件级链接`);
if (broken.length > 0) {
  console.log('\n断链：');
  for (const b of broken) console.log(`  ${b}`);
  process.exit(1);
}
console.log('全部有效 ✅');
