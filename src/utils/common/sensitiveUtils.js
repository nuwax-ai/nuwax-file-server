/**
 * 敏感信息处理工具
 */

/**
 * 通用脱敏函数 - 移除敏感路径信息
 * @param {string} text 需要脱敏的文本
 * @returns {string} 脱敏后的文本
 */
function sanitizeSensitivePaths(text) {
  if (!text || typeof text !== "string") {
    return text;
  }

  let sanitized = text;

  // 获取敏感路径列表
  const sensitivePaths = [
    process.cwd(), // 当前工作目录
    process.env.HOME, // 用户主目录
    process.env.USERPROFILE, // Windows用户目录
    // 环境变量中的敏感路径
    process.env.LOG_BASE_DIR,
    process.env.INIT_PROJECT_DIR,
    process.env.UPLOAD_PROJECT_DIR,
    process.env.PROJECT_SOURCE_DIR,
    process.env.DIST_TARGET_DIR,
  ].filter(Boolean); // 过滤掉空值

  // 替换敏感路径为空字符串
  sensitivePaths.forEach((sensitivePath) => {
    if (sensitivePath) {
      // 转义特殊字符用于正则表达式
      const escapedPath = sensitivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escapedPath, "gi");
      sanitized = sanitized.replace(regex, "");
    }
  });

  // 处理路径中的敏感部分（如 /workspace/rcoder-server）
  const sensitivePatterns = [
    /\/workspace\/rcoder-server/g,
    /\/home\/[^\/]+\/workspace\/rcoder-server/g,
    /\/opt\/project_[^\/]+/g,
    /\/Users\/[^\/]+\/Work\/[^\/]+/g,
  ];

  sensitivePatterns.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, "");
  });

  return sanitized;
}

export { sanitizeSensitivePaths };

