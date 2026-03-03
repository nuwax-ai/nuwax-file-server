// 应用配置模块（ESM）：环境变量与运行时配置，与 src/config 的 Swagger 等区分
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

/** 解析日志根目录：若配置的路径无法创建（如本机无 /app），则回退到系统临时目录 */
function resolveLogBaseDir() {
  const raw = process.env.LOG_BASE_DIR;
  const fallback = path.join(os.tmpdir(), "nuwax-file-server", "project_logs");
  if (!raw) return fallback;
  try {
    fs.mkdirSync(raw, { recursive: true });
    return raw;
  } catch (_) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch (__) {}
    return fallback;
  }
}

// 获取环境变量，默认为 development
const env = process.env.NODE_ENV || "development";

// 加载环境变量文件（env 位于 appConfig 同级目录：src/env.* 或 dist/env.*）
function loadEnvFile(envName) {
  const envFile = path.join(__dirname, "..", `env.${envName}`);
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
    console.log(`已加载环境配置文件: env.${envName}`);
  } else {
    const message = `环境配置文件 env.${envName} 不存在，请创建对应的环境配置文件后重试`;
    console.error(message);
    throw new Error(message);
  }
}

// 加载对应环境的配置文件
loadEnvFile(env);

// 从环境变量构建配置对象
const config = {
  NODE_ENV: env,
  PORT: parseInt(process.env.PORT),
  INIT_PROJECT_NAME: process.env.INIT_PROJECT_NAME,
  INIT_PROJECT_DIR: process.env.INIT_PROJECT_DIR,
  PROJECT_SOURCE_DIR: process.env.PROJECT_SOURCE_DIR,
  DIST_TARGET_DIR: process.env.DIST_TARGET_DIR,
  UPLOAD_PROJECT_DIR: process.env.UPLOAD_PROJECT_DIR,
  MAX_BUILD_CONCURRENCY: process.env.MAX_BUILD_CONCURRENCY
    ? parseInt(process.env.MAX_BUILD_CONCURRENCY, 10)
    : undefined,
  MAX_INLINE_FILE_SIZE_BYTES: process.env.MAX_INLINE_FILE_SIZE_BYTES
    ? parseInt(process.env.MAX_INLINE_FILE_SIZE_BYTES, 10)
    : undefined,
  UPLOAD_MAX_FILE_SIZE_BYTES: process.env.UPLOAD_MAX_FILE_SIZE_BYTES
    ? parseInt(process.env.UPLOAD_MAX_FILE_SIZE_BYTES, 10)
    : undefined,
  UPLOAD_ALLOWED_EXTENSIONS: process.env.UPLOAD_ALLOWED_EXTENSIONS
    ? process.env.UPLOAD_ALLOWED_EXTENSIONS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
  UPLOAD_SINGLE_FILE_SIZE_BYTES: process.env.UPLOAD_SINGLE_FILE_SIZE_BYTES
    ? parseInt(process.env.UPLOAD_SINGLE_FILE_SIZE_BYTES, 10)
    : undefined,
  REQUEST_BODY_LIMIT: process.env.REQUEST_BODY_LIMIT,
  TRAVERSE_EXCLUDE_DIRS: process.env.TRAVERSE_EXCLUDE_DIRS
    ? process.env.TRAVERSE_EXCLUDE_DIRS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  BACKUP_TRAVERSE_EXCLUDE_FILES: process.env.BACKUP_TRAVERSE_EXCLUDE_FILES
    ? process.env.BACKUP_TRAVERSE_EXCLUDE_FILES.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  CONTENT_TRAVERSE_EXCLUDE_FILES: process.env.CONTENT_TRAVERSE_EXCLUDE_FILES
    ? process.env.CONTENT_TRAVERSE_EXCLUDE_FILES.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  INLINE_IMAGE_EXTENSIONS: process.env.INLINE_IMAGE_EXTENSIONS
    ? process.env.INLINE_IMAGE_EXTENSIONS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
  TOP_LEVEL_NOISE_PATTERNS: process.env.TOP_LEVEL_NOISE_PATTERNS
    ? process.env.TOP_LEVEL_NOISE_PATTERNS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  LOG_BASE_DIR: resolveLogBaseDir(),
  LOG_LEVEL: process.env.LOG_LEVEL
    ? process.env.LOG_LEVEL.toLowerCase()
    : undefined,
  LOG_PREFIX_API: process.env.LOG_PREFIX_API,
  LOG_PREFIX_BUILD: process.env.LOG_PREFIX_BUILD,
  LOG_CONSOLE_ENABLED:
    typeof process.env.LOG_CONSOLE_ENABLED === "string"
      ? process.env.LOG_CONSOLE_ENABLED.toLowerCase() === "true"
      : undefined,
  LOG_CACHE_ENABLED:
    typeof process.env.LOG_CACHE_ENABLED === "string"
      ? process.env.LOG_CACHE_ENABLED.toLowerCase() === "true"
      : undefined,
  LOG_CACHE_DURATION: process.env.LOG_CACHE_DURATION
    ? parseInt(process.env.LOG_CACHE_DURATION, 10)
    : undefined,
  LOG_CACHE_MAX_ENTRIES: process.env.LOG_CACHE_MAX_ENTRIES
    ? parseInt(process.env.LOG_CACHE_MAX_ENTRIES, 10)
    : undefined,
  LOG_CACHE_MAX_FILE_SIZE: process.env.LOG_CACHE_MAX_FILE_SIZE
    ? parseInt(process.env.LOG_CACHE_MAX_FILE_SIZE, 10)
    : undefined,
  DEV_SERVER_PORT_TIMEOUT: process.env.DEV_SERVER_PORT_TIMEOUT
    ? parseInt(process.env.DEV_SERVER_PORT_TIMEOUT, 10)
    : undefined,
  DEV_SERVER_STOP_TIMEOUT: process.env.DEV_SERVER_STOP_TIMEOUT
    ? parseInt(process.env.DEV_SERVER_STOP_TIMEOUT, 10)
    : undefined,
  DEV_SERVER_STOP_CHECK_INTERVAL: process.env.DEV_SERVER_STOP_CHECK_INTERVAL
    ? parseInt(process.env.DEV_SERVER_STOP_CHECK_INTERVAL, 10)
    : undefined,
  DEV_SERVER_STOP_MAX_ATTEMPTS: process.env.DEV_SERVER_STOP_MAX_ATTEMPTS
    ? parseInt(process.env.DEV_SERVER_STOP_MAX_ATTEMPTS, 10)
    : undefined,
  COMPUTER_WORKSPACE_DIR: process.env.COMPUTER_WORKSPACE_DIR,
  COMPUTER_LOG_DIR: process.env.COMPUTER_LOG_DIR,
  CLI_SERVICE_NAME: "nuwax-file-server",
  CLI_PID_DIR: process.env.CLI_PID_DIR || (
    process.platform === "win32"
      ? path.join(process.env.TEMP || "", "nuwax-file-server")
      : path.join("/tmp", "nuwax-file-server")
  ),
  CLI_PID_FILE: "server.pid",
  CLI_STOP_TIMEOUT: process.env.CLI_STOP_TIMEOUT
    ? parseInt(process.env.CLI_STOP_TIMEOUT, 10)
    : 30000,
  CLI_CHECK_INTERVAL: process.env.CLI_CHECK_INTERVAL
    ? parseInt(process.env.CLI_CHECK_INTERVAL, 10)
    : 500,
  CLI_LOG_DIR: process.env.CLI_LOG_DIR || (
    process.platform === "win32"
      ? path.join(process.env.TEMP || "", "nuwax-file-server", "logs")
      : path.join("/tmp", "nuwax-file-server", "logs")
  ),
  CLI_IS_WINDOWS: process.platform === "win32",
};

export default config;
