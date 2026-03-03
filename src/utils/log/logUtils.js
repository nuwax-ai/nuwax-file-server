// 日志工具模块（ESM）
import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";

function getLogDir(projectId) {
  const base = config.LOG_BASE_DIR;
  const idStr = String(projectId);

  // computer 相关日志：使用 COMPUTER_LOG_DIR/<userId>/<cId>
  // 约定 projectId 形如: computer:<userId>:<cId>
  if (idStr.startsWith("computer:")) {
    const [, userId, cId] = idStr.split(":");
    const computerBase = config.COMPUTER_LOG_DIR || base;
    return path.join(
      computerBase,
      String(userId || "unknown"),
      String(cId || "unknown")
    );
  }

  return path.join(base, idStr);
}

// 获取东八区（UTC+8）时间
// 返回格式: YYYY-MM-DD HH:mm:ss
function getCSTDateTimeString() {
  const now = new Date();
  // 使用 Intl.DateTimeFormat 直接格式化东八区时间，更可靠
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  const hours = parts.find(p => p.type === "hour").value;
  const minutes = parts.find(p => p.type === "minute").value;
  const seconds = parts.find(p => p.type === "second").value;
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 获取东八区日期字符串（用于日志文件名）
// 返回格式: YYYY-MM-DD
function getCSTDateString() {
  return getCSTDateTimeString().split(" ")[0];
}

// 获取格式化的东八区时间戳（用于日志显示）
// 返回格式: YYYY/MM/DD HH:mm:ss
function getCSTTimestampString() {
  return getCSTDateTimeString().replace(/-/g, "/");
}

// 生成唯一请求ID
function generateRequestId() {
  return Math.random().toString(36).substr(2, 9);
}

// 获取客户端IP地址
function getClientIP(req) {
  return (
    req.ip ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    "unknown"
  );
}

// 格式化日志输出
function formatLogMessage(level, message, meta = {}) {
  const timestamp = getCSTTimestampString();
  const metaStr =
    Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

// 日志级别枚举
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

// 当前日志级别
const CURRENT_LOG_LEVEL = (function () {
  const level = (config.LOG_LEVEL || "info").toLowerCase();
  switch (level) {
    case "error":
      return LOG_LEVELS.ERROR;
    case "warn":
      return LOG_LEVELS.WARN;
    case "debug":
      return LOG_LEVELS.DEBUG;
    case "info":
    default:
      return LOG_LEVELS.INFO;
  }
})();

// 获取API日志文件路径
function getLogFilePath(projectId, prefix) {
  const logDir = getLogDir(String(projectId));
  const today = getCSTDateString(); // 格式: YYYY-MM-DD (东八区)

  // 确保日志目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return path.join(logDir, `${prefix}-${today}.log`);
}

// 基于项目名缓存 WriteStream，按天切换文件时自动轮转
const projectIdToLogStream = new Map(); // key: projectId, value: { stream, filePath }

function getLogWriteStream(projectId, prefix) {
  const stringProjectId = String(projectId);
  const targetFilePath = getLogFilePath(stringProjectId, prefix);
  const cached = projectIdToLogStream.get(stringProjectId);

  if (
    cached &&
    cached.filePath === targetFilePath &&
    !cached.stream.destroyed
  ) {
    return cached.stream;
  }

  // 如果已有旧流且文件路径变更或已销毁，关闭旧流
  if (cached && cached.stream && !cached.stream.destroyed) {
    try {
      cached.stream.end();
    } catch (_) {}
  }

  const newStream = fs.createWriteStream(targetFilePath, {
    flags: "a",
    encoding: "utf8",
  });
  newStream.on("error", (err) => {
    console.error("API日志写入流错误:", err && err.message ? err.message : err);
  });
  newStream.on("close", () => {
    const current = projectIdToLogStream.get(stringProjectId);
    if (current && current.stream === newStream) {
      projectIdToLogStream.delete(stringProjectId);
    }
  });

  projectIdToLogStream.set(stringProjectId, {
    stream: newStream,
    filePath: targetFilePath,
  });
  return newStream;
}

// 写入日志到文件
function writeToLogFile(projectId, prefix, level, message, meta = {}) {
  try {
    const logMessage = formatLogMessage(level, message, meta) + "\n";
    const stream = getLogWriteStream(String(projectId), prefix);
    const ok = stream.write(logMessage);
    if (!ok) {
      // 简单回压提示
      console.warn(`日志写入回压: ${projectId}`);
    }
  } catch (error) {
    console.error("写入日志文件失败:", error.message);
  }
}

// 日志输出函数，默认输出到api_${date}.log
function log(projectId, level, message, meta = {}) {
  const upper = String(level).toUpperCase();
  if (LOG_LEVELS[upper] <= CURRENT_LOG_LEVEL) {
    if (config.LOG_CONSOLE_ENABLED) {
      console.log(formatLogMessage(upper, message, meta));
    }
    const finalProjectId = String(projectId || "default");
    writeToLogFile(
      finalProjectId,
      config.LOG_PREFIX_API || "api",
      upper,
      message,
      meta
    );
  }
}

//build日志输出
function logBuild(projectId, level, message, meta = {}) {
  const upper = String(level).toUpperCase();
  if (LOG_LEVELS[upper] <= CURRENT_LOG_LEVEL) {
    if (config.LOG_CONSOLE_ENABLED) {
      console.log(formatLogMessage(upper, message, meta));
    }
    const finalProjectId = String(projectId || "default");
    writeToLogFile(
      finalProjectId,
      config.LOG_PREFIX_BUILD || "build",
      upper,
      message,
      meta
    );
    writeToLogFile(
      finalProjectId,
      config.LOG_PREFIX_API || "api",
      upper,
      message,
      meta
    );
  }
}

// 日志中间件
function logger(req, res, next) {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const clientIP = getClientIP(req);

  // 为请求添加唯一ID
  req.requestId = requestId;

  // 记录请求开始
  const requestLogMessage = `${req.method}-[${req.requestId}] -请求 ${
    req.originalUrl || req.url
  } -`;
  const requestLogMeta = {
    requestId,
    clientIP,
    userAgent: req.headers["user-agent"] || "unknown",
    contentType: req.headers["content-type"] || "unknown",
  };

  // 根据请求方法分别处理 projectId
  let projectId = "default";
  if (req.method === "GET") {
    projectId = req.query.projectId || "default";
  } else if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "PATCH"
  ) {
    projectId = req.body && req.body.projectId ? req.body.projectId : "default";
  }

  log(projectId, "INFO", requestLogMessage, requestLogMeta);

  // 监听响应完成事件
  res.on("finish", () => {
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // 根据状态码确定日志级别
    const level =
      res.statusCode >= 400 ? "ERROR" : res.statusCode >= 300 ? "WARN" : "INFO";

    const responseLogMessage = `${req.method}-[${req.requestId}] -响应(${
      res.statusCode
    }) ${req.originalUrl || req.url} - `;
    const responseLogMeta = {
      requestId,
      clientIP,
      responseTime: `${responseTime}ms`,
      contentLength: res.get("content-length") || "unknown",
      statusCode: res.statusCode,
    };

    log(projectId, level, responseLogMessage, responseLogMeta);
  });

  // 监听响应关闭事件（处理异常情况）
  res.on("close", () => {
    if (!res.finished) {
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      const closeLogMessage = `${req.method}-[${req.requestId}] -响应(${
        res.statusCode
      }) ${req.originalUrl || req.url} - Connection closed`;
      const closeLogMeta = {
        requestId,
        clientIP,
        responseTime: `${responseTime}ms`,
        contentLength: res.get("content-length") || "unknown",
        statusCode: res.statusCode,
      };

      log(projectId, "ERROR", closeLogMessage, closeLogMeta);
    }
  });

  next();
}

export {
  log,
  logBuild,
  logger,
  getLogDir,
  generateRequestId,
  getClientIP,
  formatLogMessage,
  getLogFilePath,
  writeToLogFile,
  getCSTDateTimeString,
  getCSTDateString,
  getCSTTimestampString,
  LOG_LEVELS,
  CURRENT_LOG_LEVEL,
};
