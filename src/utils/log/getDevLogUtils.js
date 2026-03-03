import fs from "fs";
import path from "path";
import { getLogDir, getCSTDateString } from "./logUtils.js";
import logCacheManager from "./logCacheManager.js";
import { SystemError } from "../error/errorHandler.js";
import { sanitizeSensitivePaths } from "../common/sensitiveUtils.js";

/**
 * 从日志文件读取内容（支持缓存）
 * @param {string} projectId 项目ID
 * @param {string} logFileName 日志文件名
 * @param {number} arrayStartIndex 数组起始索引（从0开始）
 * @param {number} startIndex 用户视角起始行号（从1开始）
 * @returns {Object} 日志读取结果
 */
function readLogFileWithCache(projectId, logFileName, arrayStartIndex, startIndex) {
  try {
    let lines;
    let cacheHit = false;
    let fileTooLarge = false;
    const logDir = getLogDir(String(projectId));
    const logFilePath = path.join(logDir, logFileName);

    // 尝试从缓存获取
    if (logCacheManager.isEnabled()) {
      const cached = logCacheManager.get(String(projectId), logFilePath);
      if (cached) {
        lines = cached.lines;
        cacheHit = true;
      }
    }

    // 如果缓存未命中，从文件读取
    if (!lines) {
      // 检查文件大小
      const stats = fs.statSync(logFilePath);
      const fileSize = stats.size;
      
      const logContent = fs.readFileSync(logFilePath, "utf8");
      lines = logContent.split("\n");
      
      // 更新缓存（如果文件不超过大小限制）
      if (logCacheManager.isEnabled()) {
        const cached = logCacheManager.set(String(projectId), logFilePath, logContent);
        if (!cached && fileSize > logCacheManager.maxFileSize) {
          fileTooLarge = true;
        }
      }
    }

    // 从指定行号开始截取到文件结束
    const relevantLines = lines.slice(arrayStartIndex);

    // 构建返回的日志数据，包含行号和内容
    const logs = relevantLines.map((content, index) => ({
      line: startIndex + index, // 行号从1开始
      content: sanitizeSensitivePaths(content), // 对日志内容进行脱敏处理
    }));

    return {
      success: true,
      message: cacheHit ? "获取日志成功（缓存）" : fileTooLarge ? "获取日志成功（文件过大，未缓存）" : "获取日志成功",
      logs: logs,
      totalLines: lines.length,
      startIndex: startIndex,
      cacheHit: cacheHit, // 标记是否命中缓存
      fileTooLarge: fileTooLarge, // 标记文件是否过大
      logFileName: logFileName, // 日志文件名
    };
  } catch (error) {
    throw new SystemError("读取日志文件失败", {
      projectId,
      logFileName: logFileName,
      error: error.message,
    });
  }
}

/**
 * 获取开发服务器日志
 * @param {string} projectId 项目ID
 * @param {number} startIndex 起始行号（从1开始，用户视角）
 * @returns {Object} 日志查询结果
 */
async function getDevLogFromMainLog(projectId, startIndex = 1) {
  // 将用户行号（从1开始）转换为数组索引（从0开始）
  const arrayStartIndex = Math.max(0, startIndex - 1);

  // 获取项目日志目录
  const logDir = getLogDir(String(projectId));

  if (!fs.existsSync(logDir)) {
    return {
      success: true,
      message: "日志目录不存在",
      logs: [],
      totalLines: 0,
      startLine: startIndex,
    };
  }

  // 查找当日主日志文件（仅匹配 dev-YYYY-MM-DD.log）
  const files = fs.readdirSync(logDir);
  const today = getCSTDateString(); // 格式: YYYY-MM-DD (东八区)
  const targetFileName = `dev-${today}.log`;
  const mainFiles = files.filter((file) => file === targetFileName);

  if (mainFiles.length === 0) {
    return {
      success: true,
      message: "未找到主日志文件",
      logs: [],
      totalLines: 0,
      startLine: startIndex,
    };
  }

  // 按文件名排序，取最新的文件（文件名包含日期）
  mainFiles.sort((a, b) => {
    // 提取文件名中的日期部分进行比较
    const dateA = a.match(/dev-(.+)\.log/)?.[1];
    const dateB = b.match(/dev-(.+)\.log/)?.[1];
    if (!dateA || !dateB) return 0;
    return dateB.localeCompare(dateA); // 降序排列，最新的在前
  });

  const latestMainFile = mainFiles[0];

  return readLogFileWithCache(projectId, latestMainFile, arrayStartIndex, startIndex);
}

/**
 * 获取开发服务器日志
 * @param {string} projectId 项目ID
 * @param {number} startIndex 起始行号（从1开始，用户视角）
 * @returns {Object} 日志查询结果
 */
async function getDevLogFromTempLog(projectId, startIndex = 1) {
  // 将用户行号（从1开始）转换为数组索引（从0开始）
  const arrayStartIndex = Math.max(0, startIndex - 1);

  // 获取项目日志目录
  const logDir = getLogDir(String(projectId));

  if (!fs.existsSync(logDir)) {
    return {
      success: true,
      message: "日志目录不存在",
      logs: [],
      totalLines: 0,
      startLine: startIndex,
    };
  }

  // 查找所有临时日志文件
  const files = fs.readdirSync(logDir);
  const tempFiles = files.filter(
    (file) => file.startsWith("dev-temp-") && file.endsWith(".log")
  );

  if (tempFiles.length === 0) {
    return {
      success: true,
      message: "未找到临时日志文件",
      logs: [],
      totalLines: 0,
      startLine: startIndex,
    };
  }

  // 按文件名排序，取最新的文件（文件名包含时间戳）
  tempFiles.sort((a, b) => {
    // 提取文件名中的时间戳进行比较
    const timestampA = a.match(/dev-temp-(\d+)\.log/)?.[1];
    const timestampB = b.match(/dev-temp-(\d+)\.log/)?.[1];
    return Number(timestampB) - Number(timestampA); // 降序排列，最新的在前
  });

  const latestTempFile = tempFiles[0];

  return readLogFileWithCache(projectId, latestTempFile, arrayStartIndex, startIndex);
}


/**
 * 获取开发服务器日志
 * @param {string} projectId 项目ID
 * @param {number} startIndex 起始行号（从1开始，用户视角）
 * @returns {Object} 日志查询结果
 */
async function getDevLog(projectId, startIndex = 1, logType) {
  if (logType === "main") {
    return await getDevLogFromMainLog(projectId, startIndex);
  } else {
    return await getDevLogFromTempLog(projectId, startIndex);
  }
}

export { getDevLog, getDevLogFromMainLog, getDevLogFromTempLog };