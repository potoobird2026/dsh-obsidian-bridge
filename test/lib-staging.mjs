/**
 * 测试用暂存目录解析器。
 *
 * ## 为什么需要暂存
 *
 * `audit-counters.mjs` / `audit-flow.mjs` 要加载**真实的** `index.js`，
 * 而它内部 `import './lib/config.js'`，后者 `import '@deepseek-ai/schemastery'`。
 * 直接 `import()` 仓库里的 `index.js` 时，Node 会从**仓库根**向上解析依赖 ——
 * 仓库根没有 `node_modules`（或没装 schemastery）就会 `ERR_MODULE_NOT_FOUND`。
 * 把 `lib/` + 入口复制到一个**有 node_modules 的祖先**下，解析就能成功。
 *
 * ## 为什么不再用 DSH profile
 *
 * 此前用 `~/.dsh/profiles/desktop/node_modules/.audit-*-staging`，
 * 这是**本机便利**，但在 CI 上有害：GitHub runner 镜像自带该目录
 * （里面没有 schemastery），于是 `npm install` 明明成功，测试却跑在
 * profile 的暂存目录里并报 `ERR_MODULE_NOT_FOUND`（CI run 39888972259 实测）。
 *
 * ## 现在的优先级
 *
 * 1. `<repo>/node_modules/.audit-<name>-staging` —— 仓库 `npm install` 之后
 *    schemastery 就在这里，解析必然成功（本地与 CI 都成立）
 * 2. 都没有 → 返回 null，调用方给出明确报错（`--strict` 会把它判为配置事故）
 *
 * @param name - 套件名，用于目录名（如 `audit-counters`）。
 * @returns 暂存目录的绝对路径；无法解析依赖时返回 null。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 依赖是否可从给定目录解析到。 */
function hasSchemastery(dir) {
  return fs.existsSync(path.join(dir, '@deepseek-ai', 'schemastery'));
}

/**
 * 解析暂存目录。
 * @param name - 套件名。
 * @returns 暂存目录绝对路径，或 null。
 */
export function resolveStaging(name) {
  const repoModules = path.join(REPO_ROOT, 'node_modules');
  if (hasSchemastery(repoModules)) {
    const dir = path.join(repoModules, `.audit-${name}-staging`);
    return dir;
  }
  return null;
}

/** 仓库根（供调用方复制源文件用）。 */
export const REPO = REPO_ROOT;
