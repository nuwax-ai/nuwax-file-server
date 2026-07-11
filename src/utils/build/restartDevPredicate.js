/**
 * restart-dev 快路径判定 —— 纯谓词, 无 fs/config 依赖, 便于单测。
 *
 * 快路径语义: 当 FAST_RESTART_ENABLED 开启 且 node_modules 已存在时,
 * 跳过「rm -rf node_modules + 删 lockfile + 从缓存恢复」,
 * 改由 installDependencies 内的 preflightCleanNodeModules(外科式坏态修复)
 * + pnpm install(增量 reconcile)接管。
 *
 * node_modules 不存在时强制回落全路径: 让 copyNodeModulesFromCache 有机会用模板缓存,
 * 而不是直接对空目录跑全量 pnpm install。
 */

/**
 * @param {Object} args
 * @param {boolean} args.fastRestartEnabled  config.FAST_RESTART_ENABLED
 * @param {boolean} args.nodeModulesExists   <projectPath>/node_modules 是否存在
 * @returns {boolean} true → 快路径(保留 node_modules + lockfile)
 */
export function shouldUseFastRestart({ fastRestartEnabled, nodeModulesExists }) {
  return Boolean(fastRestartEnabled) && Boolean(nodeModulesExists);
}
