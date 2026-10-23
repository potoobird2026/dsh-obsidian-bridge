/**
 * Host 与 Typert 清单共享的状态存储。
 *
 * `index.js` 在运行时写入快照；`typert.host.js` 的 invocation 与
 * `lib/bridge-service.js` 的服务方法通过这里的 getter 读取。
 * 三者是同进程内的模块，共享同一份模块实例。
 *
 * **兜底设计**：若 `getSnapshot()` 在快照尚未写入时被调用（例如面板在
 * 插件激活完成前就发起首次取数），会回落到 `snapshotBuilder` 现场构建，
 * 而不是返回 null —— 避免 Client 侧抛「Host 返回空结果」。
 */

/** 最近一次状态快照。 */
let snapshotValue = null;

/** 重建索引的回调，由 index.js 注入。 */
let refreshHook = null;

/** 现场构建快照的回调，由 index.js 注入。 */
let snapshotBuilder = null;

export function setSnapshot(value) {
  snapshotValue = value;
}

/**
 * 读取最近一次状态快照。
 * 快照尚未写入时现场构建一次，保证调用方不会拿到 null。
 * @returns 状态快照，或在构建器未注入时返回 null。
 */
export function getSnapshot() {
  if (snapshotValue !== null) return snapshotValue;
  if (typeof snapshotBuilder === 'function') {
    try {
      snapshotValue = snapshotBuilder();
    } catch (error) {
      // 构建失败时保持 null（调用方按空结果处理），但**必须留痕**（D12）：
      // 此前静默吞掉，面板会显示「未知」而没人知道是构建器抛错 ——
      // 与「真的还没构建」不可区分，排查时会误判。
      try {
        console.warn('[obsidian-bridge] 快照构建失败: ' + (error?.message ?? error));
      } catch {
        // console 不可用时彻底静默
      }
    }
  }
  return snapshotValue;
}

export function setRefreshHook(fn) {
  refreshHook = typeof fn === 'function' ? fn : null;
}

/**
 * 注入快照构建器。
 * @param fn - 返回可 JSON 序列化快照的函数。
 */
export function setSnapshotBuilder(fn) {
  snapshotBuilder = typeof fn === 'function' ? fn : null;
}

/**
 * 清空共享状态。
 *
 * **必须在新实例 `apply()` 开头调用**：这些是模块级变量，会跨 `apply()` 存活。
 * HMR 重载或同进程内重新激活时，若不清理，新实例在首次 `touch()` 之前
 * 通过 `getSnapshot()` 读到的是**上一个实例**的快照（实测泄漏
 * `sessionStarts: 1`），且 `refreshHook` / `snapshotBuilder` 仍指向旧闭包。
 */
export function resetStore() {
  snapshotValue = null;
  refreshHook = null;
  snapshotBuilder = null;
}

export async function refreshSnapshot() {
  if (refreshHook) {
    try {
      await refreshHook();
    } catch (error) {
      // hook 抛错时不让它打断调用方（D13）：`refresh` 是面板的只读操作，
      // 索引重建失败应回落到「返回当前快照」，而不是把异常抛给面板。
      try {
        console.warn('[obsidian-bridge] refresh hook 失败: ' + (error?.message ?? error));
      } catch {
        // console 不可用时静默
      }
    }
  }
  return getSnapshot();
}
