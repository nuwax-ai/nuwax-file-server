// 错误处理工具模块（ESM）
import { log, getCSTTimestampString } from "../log/logUtils.js";
import { sanitizeSensitivePaths } from "../common/sensitiveUtils.js";
import config from "../../appConfig/index.js";

// 错误类型枚举
const ERROR_TYPES = {
  VALIDATION_ERROR: "VALIDATION_ERROR", // 验证错误
  BUSINESS_ERROR: "BUSINESS_ERROR", // 业务逻辑错误
  SYSTEM_ERROR: "SYSTEM_ERROR", // 系统错误
  NETWORK_ERROR: "NETWORK_ERROR", // 网络错误
  FILE_ERROR: "FILE_ERROR", // 文件操作错误
  PROCESS_ERROR: "PROCESS_ERROR", // 进程操作错误
  PERMISSION_ERROR: "PERMISSION_ERROR", // 权限错误
  RESOURCE_ERROR: "RESOURCE_ERROR", // 资源错误
  UNKNOWN_ERROR: "UNKNOWN_ERROR", // 未知错误
};

// HTTP状态码映射
const HTTP_STATUS_MAP = {
  [ERROR_TYPES.VALIDATION_ERROR]: 400,
  [ERROR_TYPES.BUSINESS_ERROR]: 400,
  [ERROR_TYPES.PERMISSION_ERROR]: 403,
  [ERROR_TYPES.RESOURCE_ERROR]: 404,
  [ERROR_TYPES.SYSTEM_ERROR]: 500,
  [ERROR_TYPES.NETWORK_ERROR]: 502,
  [ERROR_TYPES.FILE_ERROR]: 500,
  [ERROR_TYPES.PROCESS_ERROR]: 500,
  [ERROR_TYPES.UNKNOWN_ERROR]: 500,
};

// 自定义错误类
class AppError extends Error {
  constructor(
    message,
    type = ERROR_TYPES.UNKNOWN_ERROR,
    statusCode = null,
    details = null
  ) {
    super(message);
    this.name = "AppError";
    this.type = type;
    this.statusCode = statusCode || HTTP_STATUS_MAP[type] || 500;
    this.details = details;
    this.timestamp = getCSTTimestampString(); // 东八区时间
    this.isOperational = true; // 标记为可操作的错误

    // 保持堆栈跟踪
    Error.captureStackTrace(this, this.constructor);
  }
}

// 验证错误类
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.VALIDATION_ERROR, 400, details);
    this.name = "ValidationError";
  }
}

// 业务错误类
class BusinessError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.BUSINESS_ERROR, 400, details);
    this.name = "BusinessError";
  }
}

// 系统错误类
class SystemError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.SYSTEM_ERROR, 500, details);
    this.name = "SystemError";
  }
}

// 资源错误类
class ResourceError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.RESOURCE_ERROR, 404, details);
    this.name = "ResourceError";
  }
}

// 权限错误类
class PermissionError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.PERMISSION_ERROR, 403, details);
    this.name = "PermissionError";
  }
}

// 文件错误类
class FileError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.FILE_ERROR, 500, details);
    this.name = "FileError";
  }
}

// 进程错误类
class ProcessError extends AppError {
  constructor(message, details = null) {
    super(message, ERROR_TYPES.PROCESS_ERROR, 500, details);
    this.name = "ProcessError";
  }
}

// 脱敏错误堆栈信息
function sanitizeErrorStack(stack) {
  return sanitizeSensitivePaths(stack);
}

// 脱敏错误详情信息
function sanitizeErrorDetails(details) {
  if (!details) {
    return details;
  }

  // 如果是字符串，直接脱敏
  if (typeof details === "string") {
    return sanitizeSensitivePaths(details);
  }

  // 如果是对象，递归处理
  if (typeof details === "object") {
    const sanitized = {};
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === "string") {
        sanitized[key] = sanitizeSensitivePaths(value);
      } else if (typeof value === "object") {
        sanitized[key] = sanitizeErrorDetails(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  return details;
}

// 统一错误响应格式
function formatErrorResponse(error, requestId = null) {
  const response = {
    success: false,
    code: error.code || (error.details && error.details.code) || "UNKNOWN_ERROR",
    error: {
      type: error.type || ERROR_TYPES.UNKNOWN_ERROR,
      message: error.message || "未知错误",
      timestamp:
        error.timestamp || getCSTTimestampString(), // 东八区时间
      requestId: requestId,
    },
  };

  // 构建错误已经包含用户友好的指导信息，无需额外处理

  // 在开发环境下添加更多调试信息
  if (process.env.NODE_ENV === "development") {
    response.error.stack = sanitizeErrorStack(error.stack);
    response.error.details = sanitizeErrorDetails(error.details);
  } else if (error.details) {
    // 生产环境下只添加必要的详细信息
    response.error.details = sanitizeErrorDetails(error.details);
  }

  return response;
}

// 错误处理中间件
function errorHandler(err, req, res, next) {
  let error = err;
  const requestId = req.requestId || "unknown";
  const projectId = req.body?.projectId || req.query?.projectId || "default";

  // 如果不是AppError实例，转换为AppError
  if (!(error instanceof AppError)) {
    // 处理特定类型的错误
    if (error.name === "ValidationError") {
      error = new ValidationError(error.message, error.details);
    } else if (error.name === "MulterError") {
      if (error.code === "LIMIT_FILE_SIZE") {
        const maxMb =
          Math.round((config.UPLOAD_MAX_FILE_SIZE_BYTES / 1024 / 1024) * 10) /
          10;
        error = new ValidationError("文件大小超出限制", {
          maxSize: `${maxMb}MB`,
        });
      } else if (error.code === "LIMIT_FILE_COUNT") {
        error = new ValidationError("文件数量超出限制");
      } else if (error.code === "LIMIT_UNEXPECTED_FILE") {
        error = new ValidationError(
          "文件字段名错误，请使用 'file' 字段上传文件",
          {
            expectedField: "file",
            receivedField: error.field,
          }
        );
      } else if (error.code === "LIMIT_PART_COUNT") {
        error = new ValidationError("表单字段数量超出限制");
      } else if (error.code === "LIMIT_FIELD_KEY") {
        error = new ValidationError("字段名长度超出限制");
      } else if (error.code === "LIMIT_FIELD_VALUE") {
        error = new ValidationError("字段值长度超出限制");
      } else if (error.code === "LIMIT_FIELD_COUNT") {
        error = new ValidationError("表单字段数量超出限制");
      } else {
        error = new ValidationError("文件上传错误: " + error.message, {
          code: error.code,
          field: error.field,
        });
      }
    } else if (error.code === "ENOENT") {
      error = new ResourceError("文件或目录不存在");
    } else if (error.code === "EACCES") {
      error = new PermissionError("权限不足");
    } else if (error.code === "ECONNREFUSED") {
      error = new SystemError("连接被拒绝", { code: error.code });
    } else {
      // 未知错误转换为系统错误
      error = new SystemError(error.message || "系统内部错误", {
        originalError: error.name,
        code: error.code,
      });
    }
  }

  // 记录错误日志
  const logLevel = error.statusCode >= 500 ? "ERROR" : "WARN";
  log(projectId, logLevel, `错误处理: ${error.message}`, {
    requestId,
    errorType: error.type,
    statusCode: error.statusCode,
    url: req.originalUrl,
    method: req.method,
    userAgent: req.headers["user-agent"],
    ip: req.ip,
    stack: error.stack,
    details: error.details,
  });

  // 发送错误响应
  const errorResponse = formatErrorResponse(error, requestId);
  res.status(error.statusCode).json(errorResponse);
}

// 404处理中间件
function notFoundHandler(req, res, next) {
  const error = new ResourceError(`路径不存在: ${req.originalUrl}`);
  const requestId = req.requestId || "unknown";

  log("default", "WARN", `404错误: ${req.originalUrl}`, {
    requestId,
    method: req.method,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  const errorResponse = formatErrorResponse(error, requestId);
  res.status(404).json(errorResponse);
}

// 异步错误包装器
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 错误分类函数
function classifyError(error) {
  if (error instanceof AppError) {
    return error.type;
  }

  // 根据错误特征分类
  if (error.code === "ENOENT") return ERROR_TYPES.RESOURCE_ERROR;
  if (error.code === "EACCES") return ERROR_TYPES.PERMISSION_ERROR;
  if (error.code === "ECONNREFUSED") return ERROR_TYPES.NETWORK_ERROR;
  if (error.name === "ValidationError") return ERROR_TYPES.VALIDATION_ERROR;

  return ERROR_TYPES.UNKNOWN_ERROR;
}

// 错误统计
const errorStats = {
  counts: new Map(),
  lastReset: Date.now(),
};

function recordError(error) {
  const type = classifyError(error);
  const count = errorStats.counts.get(type) || 0;
  errorStats.counts.set(type, count + 1);
}

function getErrorStats() {
  return {
    counts: Object.fromEntries(errorStats.counts),
    lastReset: errorStats.lastReset,
    totalErrors: Array.from(errorStats.counts.values()).reduce(
      (sum, count) => sum + count,
      0
    ),
  };
}

function resetErrorStats() {
  errorStats.counts.clear();
  errorStats.lastReset = Date.now();
}

export {
  ERROR_TYPES,
  AppError,
  ValidationError,
  BusinessError,
  SystemError,
  ResourceError,
  PermissionError,
  FileError,
  ProcessError,
  formatErrorResponse,
  errorHandler,
  notFoundHandler,
  asyncHandler,
  classifyError,
  sanitizeSensitivePaths,
  sanitizeErrorStack,
  sanitizeErrorDetails,
  recordError,
  getErrorStats,
  resetErrorStats,
};
