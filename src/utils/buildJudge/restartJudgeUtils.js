import { log } from "../log/logUtils.js";

/**
 * 判断单个文件是否需要重启开发服务器
 * @param {string} fileName 文件名
 * @returns {boolean} 是否需要重启
 */
function shouldRestartForSingleFile(fileName) {
  if (!fileName || typeof fileName !== "string") {
    return false;
  }

  // 定义需要重启的文件类型和路径模式
  const restartRequiredPatterns = [
    // 配置文件
    /package\.json$/i,
    /vite\.config\.(js|ts|mjs|cjs)$/i,
    /webpack\.config\.(js|ts|mjs|cjs)$/i,
    /rollup\.config\.(js|ts|mjs|cjs)$/i,
    /next\.config\.(js|ts|mjs|cjs)$/i,
    /nuxt\.config\.(js|ts|mjs|cjs)$/i,
    /tailwind\.config\.(js|ts|mjs|cjs)$/i,
    /postcss\.config\.(js|ts|mjs|cjs)$/i,
    /babel\.config\.(js|ts|mjs|cjs)$/i,
    /tsconfig\.json$/i,
    /\.env$/i,
    /\.env\..*$/i,

    // 依赖相关
    /yarn\.lock$/i,
    /package-lock\.json$/i,
    /pnpm-lock\.yaml$/i,
  ];

  // 检查是否匹配需要重启的模式
  for (const pattern of restartRequiredPatterns) {
    if (pattern.test(fileName)) {
      log(null, "INFO", `检测到需要重启的文件: ${fileName}`, {
        fileName,
        pattern: pattern.toString(),
      });
      return true;
    }
  }

  return false;
}

/**
 * 判断是否需要重启开发服务器
 * 基于文件类型和修改内容来判断是否需要重启
 * @param {Array} files 修改的文件列表
 * @returns {boolean} 是否需要重启
 */
function shouldRestartDevServer(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return false;
  }

  // 检查是否有任何文件匹配需要重启的模式
  for (const file of files) {
    if (!file || typeof file.name !== "string") {
      continue;
    }

    if (shouldRestartForSingleFile(file.name)) {
      return true;
    }
  }

  return false;
}

export { shouldRestartForSingleFile, shouldRestartDevServer };
