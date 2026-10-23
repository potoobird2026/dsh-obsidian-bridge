import path from 'node:path';
import { SCAN_ROOTS } from './config.js';

/** 单个笔记的读取上限，避免把超大附件读进内存。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 目录递归深度上限。 */
const MAX_DEPTH = 8;
/** 索引条目总数上限。 */
const MAX_ENTRIES = 5000;

/**
 * 解析 Markdown frontmatter。
 *
 * 与 `bridge.js` 的 `parseFrontmatter` 保持一致：支持 `key: value` 与
 * `key:` 后跟 `- item` 的列表写法，值两侧的引号会被剥掉。
 * @param content - 文件全文。
 * @returns frontmatter 数据与正文。
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { data: {}, body: content };
  const data = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    // 列表项：`  - item`
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(arrayMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    // 嵌套对象：`  name: value`（前导空白 + 键值）
    //
    // 此前键的正则 `^(\w[\w-]*):` 不允许前导空白，嵌套键被整行忽略，
    // 于是 `source:` 的值恒为 `[]`，`parseEntry` 里的 `data.source?.name`
    // 成了**死分支**（注释声称的「与 bridge.js 保持一致」不成立）。
    // 这里把父键的值升级为对象并写入嵌套键。
    const nestedMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
    if (nestedMatch && currentKey) {
      if (!data[currentKey] || typeof data[currentKey] !== 'object' || Array.isArray(data[currentKey])) {
        data[currentKey] = {};
      }
      const nestedValue = nestedMatch[2].trim();
      data[currentKey][nestedMatch[1]] =
        nestedValue === '' ? [] : nestedValue.replace(/^["']|["']$/g, '');
      continue;
    }
    // 顶层键值：`key: value`
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      data[currentKey] = val === '' ? [] : val.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: content.slice(match[0].length) };
}

/**
 * 解析一条索引记录。
 * @param content - 笔记全文。
 * @param displayPath - Vault 内的展示路径。
 * @returns 索引记录。
 */
export function parseEntry(content, displayPath) {
  const { data, body } = parseFrontmatter(content);
  return {
    path: displayPath.replace(/\\/g, '/'),
    title: data.title || path.basename(displayPath, '.md'),
    // 空值键（`summary:`）会被 parseFrontmatter 解析成 `[]`，
    // `[] || x` 得到的是 `[]`（真值），随后 `[].substring` 抛 TypeError ——
    // 异常被 walk() 的 catch 吞掉，**该笔记会静默从索引里消失**，
    // 日志/计数/面板全无异常。这里显式要求「非空字符串」才采用。
    summary: asSummary(data.summary) || body.substring(0, 150).substring(0, 200),
    tags: Array.isArray(data.tags) ? data.tags : [],
    category: data.category || 'unknown',
    created: data.created,
    updated: data.updated,
    project: data.project || data.source?.name || '',
    permission: data.permission,
    body,
  };
}

/**
 * 把 frontmatter 里的 summary 规范化成字符串。
 *
 * 解析器对空值键返回 `[]`（数组），对缺失键返回 `undefined`，
 * 对字符串键返回字符串 —— 三种都可能出现，直接用会抛错。
 * @param value - 解析出的原始值。
 * @returns 非空字符串，否则空串。
 */
function asSummary(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

/**
 * 递归扫描一个目录，把 `.md` 笔记收集进索引。
 * @param ctx - 插件上下文。
 * @param dirTarget - 已解析的目录 target。
 * @param index - 累积的索引数组。
 * @param signal - 取消信号。
 * @param depth - 当前深度。
 */
async function walk(ctx, dirTarget, index, signal, depth) {
  if (depth > MAX_DEPTH || index.length >= MAX_ENTRIES || signal?.aborted) return;
  let entries;
  try {
    entries = await ctx.fs.listDir(dirTarget, signal);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal?.aborted || index.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith('.')) continue;
    if (entry.type === 'directory') {
      await walk(ctx, entry.target, index, signal, depth + 1);
    } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
      if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) continue;
      try {
        const content = await ctx.fs.readText(entry.target, signal);
        index.push(parseEntry(content, entry.target.displayPath));
      } catch {
        // 读不到的笔记直接跳过，不影响整体扫描
      }
    }
  }
}

/**
 * 构建 Vault 内存索引。
 *
 * 读取走 `ctx.fs`（sandbox 放行读操作），因此即使会话处于
 * `workspace-write` 模式也能扫描 `D:/MyVault`。
 *
 * **失败必须可被调用方识别**：逐个根目录的失败是正常的（目录不存在就跳过），
 * 但**所有根目录都失败**意味着配置或权限出了问题，不能静默返回 `[]`
 * —— 否则 `ensureIndex` 会把「扫描失败」记成一次成功的 `indexBuilt`，
 * 面板把故障显示成「空 Vault」。
 *
 * @param ctx - 插件上下文。
 * @param vaultPath - Vault 根目录。
 * @param signal - 取消信号。
 * @returns `{ entries, ok, failedRoots }`：
 *   `ok=false` 表示一个根目录都没扫到（全部 resolve/stat 失败）。
 */
export async function buildVaultIndex(ctx, vaultPath, signal) {
  const index = [];
  const failedRoots = [];
  let scannedRoots = 0;
  for (const root of SCAN_ROOTS) {
    if (signal?.aborted) break;
    let target;
    try {
      target = await ctx.fs.resolve(path.join(vaultPath, root), { signal });
    } catch {
      failedRoots.push(root);
      continue;
    }
    let stat;
    try {
      stat = await ctx.fs.stat(target, signal);
    } catch {
      failedRoots.push(root);
      continue;
    }
    if (!stat || stat.type !== 'directory') {
      failedRoots.push(root);
      continue;
    }
    scannedRoots += 1;
    await walk(ctx, target, index, signal, 0);
  }
  return {
    entries: index,
    // 至少扫到一个根目录即视为成功（其余根目录不存在属正常）
    ok: scannedRoots > 0,
    failedRoots,
  };
}
