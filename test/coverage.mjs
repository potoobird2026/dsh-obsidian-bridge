/**
 * 行覆盖率统计器（零依赖，用 Node 内置的 NODE_V8_COVERAGE）。
 *
 * ## 为什么需要它
 *
 * 用户要求「对每一行代码都做完整测试，不跳过任何一条线」。
 * Node 内置的 `--experimental-test-coverage` 只服务 `node --test` 运行器，
 * 而本项目测试是普通脚本，因此改用 `NODE_V8_COVERAGE` + 本脚本解析。
 *
 * ## 用法
 *   $env:NODE_V8_COVERAGE = "<输出目录>"
 *   node test/run-all.mjs
 *   node test/coverage.mjs <输出目录>
 *
 * 输出每个源文件的：总行数 / 已覆盖行数 / 覆盖率 / 未覆盖行号列表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 纳入统计的源文件（插件本体，不含测试）。 */
const SOURCES = [
  'index.js',
  'client.js',
  'typert.host.js',
  'lib/bridge-service.js',
  'lib/config.js',
  'lib/message.js',
  'lib/query.js',
  'lib/status-store.js',
  'lib/status.js',
  'lib/vault-index.js',
  'lib/writer.js',
];

/** 要忽略的目录。 */
const IGNORE_DIR = /node_modules|release-staging|\.git/;

/**
 * 读取 V8 coverage 结果。
 * @param dir - NODE_V8_COVERAGE 输出目录。
 * @returns 每个 URL 的函数覆盖区间。
 */
function readCoverage(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (const script of data.result ?? []) {
        if (script.url && script.url.startsWith('file://')) out.push(script);
      }
    } catch {
      // 单个文件解析失败不影响整体
    }
  }
  return out;
}

/** 把 URL 转成相对 ROOT 的路径；无法归属时返回 null。 */
function urlToRel(url) {
  let p;
  try {
    p = decodeURIComponent(url.replace(/^file:\/\//, ''));
  } catch {
    return null;
  }
  if (IGNORE_DIR.test(p)) return null;
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel;
}

/**
 * 判断一个 coverage URL 是否指向目标文件。
 *
 * **不能只用 `urlToRel` 的相对路径比较** —— 测试经 `run-all.mjs` 的 `stage()`
 * 跑在 profile 的 node_modules 下（如 `.../node_modules/ob-testrun-123/`），
 * 相对 ROOT 会变成 `../../...` 而被判为「不属于本项目」，导致覆盖率恒为 0%。
 * 因此改用**路径后缀匹配**：只要 URL 以目标相对路径结尾即视为同一文件。
 * @param url - coverage 脚本 URL。
 * @param relPath - 目标相对路径（如 `index.js`）。
 */
function urlMatches(url, relPath) {
  const direct = urlToRel(url);
  if (direct === relPath) return true;
  const norm = relPath.replace(/\\/g, '/');
  return url.replace(/\\/g, '/').endsWith(`/${norm}`);
}

/**
 * 计算单个源文件的行覆盖。
 * @param relPath - 相对 ROOT 的路径。
 * @param scripts - V8 coverage 脚本列表。
 * @returns `{ total, covered, pct, uncovered }`。
 */
function lineCoverage(relPath, scripts) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf-8');
  const lines = text.split('\n');
  // 末行换行不产生空行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  // 行边界（字节偏移）：第 i 行的范围是 [start[i], start[i+1])
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + Buffer.byteLength(line, 'utf-8') + 1);

  const coveredOffsets = new Set();
  for (const script of scripts) {
    if (!urlMatches(script.url, relPath)) continue;
    for (const fn of script.functions ?? []) {
      for (const range of fn.ranges ?? []) {
        if (range.count > 0) {
          coveredOffsets.add(`${range.startOffset}-${range.endOffset}`);
        }
      }
    }
  }

  const coveredLines = new Set();
  const fileSize = Buffer.byteLength(text, 'utf-8');

  /**
   * 标记一个区间触及的行。
   * @param start - 区间起始偏移。
   * @param end - 区间结束偏移。
   */
  const mark = (start, end) => {
    for (let i = 0; i < lines.length; i += 1) {
      const lineStart = starts[i];
      const lineEnd = starts[i + 1] ?? starts[i] + 1;
      if (start < lineEnd && end > lineStart) coveredLines.add(i);
    }
  };

  for (const script of scripts) {
    if (!urlMatches(script.url, relPath)) continue;
    for (const fn of script.functions ?? []) {
      const ranges = fn.ranges ?? [];
      if (ranges.length === 0) continue;
      const [own, ...inner] = ranges;

      // `ranges[0]` 是函数**自身跨度**：count>0 表示「这个函数被进入过」。
      //
      // **模块包装函数必须排除** —— 它是 `ranges[0]` 从偏移 0 开始的那个函数
      // （V8 把整个模块包进一个匿名函数），跨度覆盖 `apply` 及其所有嵌套函数体。
      // 采信它的跨度会让「模块被 import 一次」=「文件里每个函数都跑过」。
      // 实测 `index.js`：包装函数 own=[0,17007)，而文件 22206 字节 ——
      // 判据不能用「跨度≈整个文件」（17007 < 22205 会判 false），
      // 必须用「起始偏移为 0」。
      const isModuleWrapper = own.startOffset === 0;
      if (own.count > 0 && !isModuleWrapper) mark(own.startOffset, own.endOffset);

      // 内层块（if/catch/循环体等）才是真实执行路径
      for (const range of inner) {
        if (range.count > 0) mark(range.startOffset, range.endOffset);
      }
    }
  }

  const uncovered = [...Array(lines.length).keys()].filter((i) => !coveredLines.has(i));
  return {
    total: lines.length,
    covered: lines.length - uncovered.length,
    pct: lines.length === 0 ? 100 : Math.round(((lines.length - uncovered.length) / lines.length) * 1000) / 10,
    uncovered,
  };
}

function main() {
  const dir = process.argv[2] || process.env.NODE_V8_COVERAGE_DIR || '';
  if (!dir) {
    console.error('用法: node test/coverage.mjs <NODE_V8_COVERAGE 目录>');
    process.exit(2);
  }
  const scripts = readCoverage(dir);
  if (scripts.length === 0) {
    console.error(`未找到 coverage 数据: ${dir}`);
    process.exit(2);
  }

  console.log('\n行覆盖率（V8 coverage）\n' + '='.repeat(78));
  let totalAll = 0;
  let coveredAll = 0;
  const gaps = [];

  for (const src of SOURCES) {
    const r = lineCoverage(src, scripts);
    if (!r) {
      console.log(`  ${src.padEnd(30)} (文件不存在，跳过)`);
      continue;
    }
    totalAll += r.total;
    coveredAll += r.covered;
    const bar = '█'.repeat(Math.round(r.pct / 5)) + '░'.repeat(20 - Math.round(r.pct / 5));
    console.log(`  ${src.padEnd(30)} ${bar} ${String(r.pct).padStart(5)}%  ${r.covered}/${r.total}`);
    if (r.uncovered.length > 0) {
      gaps.push({ src, uncovered: r.uncovered, total: r.total });
    }
  }

  const pct = totalAll === 0 ? 100 : Math.round((coveredAll / totalAll) * 1000) / 10;
  console.log('='.repeat(78));
  console.log(`  合计 ${coveredAll}/${totalAll} 行 = ${pct}%\n`);

  if (gaps.length > 0) {
    console.log('未覆盖的行（前 5 个文件，每文件最多列 25 行）:\n');
    for (const g of gaps.slice(0, 5)) {
      const list = g.uncovered.slice(0, 25).map((n) => n + 1).join(', ');
      const more = g.uncovered.length > 25 ? ` …（共 ${g.uncovered.length} 行）` : '';
      console.log(`  ${g.src}: ${list}${more}`);
    }
    console.log('');
  }
  console.log('提示：覆盖率数字只能说明「跑过」，不能说明「断言过」——');
  console.log('      高覆盖率 + 弱断言 = 假阳性（本项目踩过两次）。');
}

main();
