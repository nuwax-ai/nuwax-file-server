import fs from "fs";
import path from "path";
import archiver from "archiver";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError, SystemError, FileError } from "../error/errorHandler.js";
import { extractZip } from "../common/zipUtils.js";
import { moveDirectory, movePath } from "../common/fileSystemUtils.js";
import { resolveLogDir, resolveWorkspaceDir, resolveWorkspaceRoot } from "./workspaceContext.js";

/** 导入项目时保留的目录/文件 */
const IMPORT_PROJECT_PRESERVED_ENTRIES = new Set([
  ".git",
  ".agents",
  ".claude",
  ".codex",
  ".opencode",
  ".tmp",
  ".logs",
]);

const DEFAULT_DOWNLOAD_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_MAX_FILE_SIZE_BYTES =
  config.DOWNLOAD_MAX_FILE_SIZE_BYTES || DEFAULT_DOWNLOAD_MAX_FILE_SIZE_BYTES;

/**
 * 列出目录下单层条目（不递归）
 * @param {string} listDir 待列出的绝对目录
 * @param {string} workspaceDir 工作区根目录（用于计算相对路径）
 * @param {string} logId 日志ID
 * @param {string} proxyPath 代理路径前缀
 * @param {string} [customTargetDir] 自定义目标目录
 * @returns {Promise<Array>}
 */
async function listDirectoryLevel(listDir, workspaceDir, logId, proxyPath, customTargetDir) {
  const files = [];
  const entries = await fs.promises.readdir(listDir, { withFileTypes: true });

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const entry of entries) {
    const fullPath = path.join(listDir, entry.name);

    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;

    const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
    if (excludeFiles.includes(entry.name)) continue;

    if (entry.isDirectory() && config.TRAVERSE_EXCLUDE_DIRS.includes(entry.name)) {
      continue;
    }

    // 统一使用正斜杠，保证 Windows/Linux 跨平台一致性及 URL 正确性
    const relativePath = path.relative(workspaceDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      files.push({
        name: relativePath,
        isDir: true,
      });
      continue;
    }

    try {
      files.push({
        name: relativePath,
        isDir: false,
        fileProxyUrl: buildFileProxyUrl(proxyPath, relativePath, customTargetDir),
        isLink: entry.isSymbolicLink(),
      });
    } catch (error) {
      log(logId, "WARN", `处理文件失败: ${fullPath}`, { error: error.message });
    }
  }

  return files;
}

/**
 * 递归遍历目录（扁平文件列表；空目录以 isDir 返回）
 */
async function traverseDirectory(targetDir, basePath, logId, proxyPath, customTargetDir) {
  const files = [];
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);

    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;

    const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
    if (excludeFiles.includes(entry.name)) continue;

    if (entry.isDirectory() && config.TRAVERSE_EXCLUDE_DIRS.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      const sub = await traverseDirectory(fullPath, basePath, logId, proxyPath, customTargetDir);
      if (sub.length === 0) {
        const referencePath = basePath || targetDir;
        const relativePath = path.relative(referencePath, fullPath).replace(/\\/g, "/");
        files.push({
          name: relativePath,
          isDir: true,
        });
      } else {
        files.push(...sub);
      }
    } else {
      try {
        const referencePath = basePath || targetDir;
        const relativePath = path.relative(referencePath, fullPath).replace(/\\/g, "/");
        files.push({
          name: relativePath,
          isDir: false,
          fileProxyUrl: buildFileProxyUrl(proxyPath, relativePath, customTargetDir),
          isLink: entry.isSymbolicLink(),
        });
      } catch (error) {
        log(logId, "WARN", `处理文件失败: ${fullPath}`, { error: error.message });
      }
    }
  }

  return files;
}

/**
 * 将 relativePath 解析到目标根目录内，防止 .. 穿越
 * @param {string} rootDir 目标根目录（默认工作区或 customTargetDir）
 * @param {string} [relativePath] 相对路径，空则返回根目录
 * @returns {string} 绝对路径
 */
function resolvePathWithinWorkspace(rootDir, relativePath) {
  const trimmed = (relativePath == null ? "" : String(relativePath)).trim();
  if (!trimmed || trimmed === "." || trimmed === "/") {
    return path.resolve(rootDir);
  }

  const normalized = path.normalize(trimmed).replace(/^[\/\\]+/, "");
  if (!normalized || normalized === ".") {
    return path.resolve(rootDir);
  }

  if (path.isAbsolute(trimmed) || normalized.split(path.sep).includes("..")) {
    throw new ValidationError("relativePath 非法，不允许越出目标目录", {
      field: "relativePath",
      relativePath,
    });
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(rootDir, normalized);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(resolvedRoot + path.sep)
  ) {
    throw new ValidationError("relativePath 非法，不允许越出目标目录", {
      field: "relativePath",
      relativePath,
    });
  }

  return resolvedPath;
}

/**
 * 解析文件路径到目标根目录内
 * - rootDir 可为默认工作区，也可为 customTargetDir（允许在默认工作区之外）
 * - 相对路径相对 rootDir；绝对路径须落在 rootDir 下
 * @returns {{ absPath: string, name: string } | null}
 */
function resolveFilePathWithinWorkspace(rootDir, filePathInput) {
  const trimmed = (filePathInput == null ? "" : String(filePathInput)).trim();
  if (!trimmed) {
    return null;
  }

  const resolvedRoot = path.resolve(rootDir);
  let absPath;

  if (path.isAbsolute(trimmed)) {
    absPath = path.resolve(trimmed);
  } else {
    const normalized = path.normalize(trimmed).replace(/^[\/\\]+/, "");
    if (!normalized || normalized === "." || normalized.split(path.sep).includes("..")) {
      return null;
    }
    absPath = path.resolve(rootDir, normalized);
  }

  if (
    absPath !== resolvedRoot &&
    !absPath.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }

  const name = path.relative(resolvedRoot, absPath).replace(/\\/g, "/");
  if (!name || name.startsWith("..")) {
    return null;
  }
  return { absPath, name };
}

function buildFileProxyUrl(proxyPath, relativePath, customTargetDir) {
  if (!proxyPath || !relativePath) {
    return null;
  }
  const encodedPath = relativePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  let fileProxyUrl = `${proxyPath}/${encodedPath}`;
  if (customTargetDir) {
    fileProxyUrl += `?customTargetDir=${encodeURIComponent(customTargetDir)}`;
  }
  return fileProxyUrl;
}

/**
 * 校验目标根目录下文件是否存在，存在则返回相对路径与代理 URL（供 IM 直出）
 * 目标根目录 = customTargetDir（可在默认工作区外）或 workspace/userId/cId
 */
async function resolveExistingFile(userId, cId, filePath, proxyPath, customTargetDir, service = null) {
  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!filePath || !String(filePath).trim()) {
    throw new ValidationError("filePath 不能为空", { field: "filePath" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  // customTargetDir 非空时作为目标根（可跳出默认工作区）；否则按项目类型定位默认会话目录
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    return { exists: false };
  }

  let resolved = resolveFilePathWithinWorkspace(targetDir, filePath);
  // 兼容以 / 开头、实为相对目标根的写法（如 /src/a.md）
  if (!resolved) {
    const asRelative = String(filePath).trim().replace(/^[\/\\]+/, "");
    if (asRelative && asRelative !== String(filePath).trim()) {
      resolved = resolveFilePathWithinWorkspace(targetDir, asRelative);
    }
  }
  if (!resolved) {
    return { exists: false };
  }

  try {
    // 与静态文件 sendFile 一致：跟随符号链接，只要最终是文件即可
    const stat = await fs.promises.stat(resolved.absPath);
    if (!stat.isFile()) {
      return { exists: false };
    }
  } catch {
    return { exists: false };
  }

  return {
    exists: true,
    name: resolved.name,
    fileProxyUrl: buildFileProxyUrl(proxyPath, resolved.name, trimmedCustomTargetDir),
  };
}

/**
 * 计算目录中允许打包下载的文件总大小（字节）
 * 过滤规则与 downloadAllFiles 保持一致
 * @param {string} targetDir 目标目录绝对路径
 * @param {string[]} excludeFiles 需排除的文件名列表
 * @param {string[]} excludeDirs 需排除的目录名列表
 * @param {string} logId 日志ID
 * @param {string} relativeDir 相对目录（递归内部使用）
 * @returns {Promise<number>} 允许下载的总字节数
 */
async function calculateDownloadableDirectorySize(
  targetDir,
  excludeFiles,
  excludeDirs,
  logId,
  relativeDir = ""
) {
  const entries = await fs.promises.readdir(path.join(targetDir, relativeDir), {
    withFileTypes: true,
  });
  let totalSize = 0;

  for (const entry of entries) {
    const nextRelativePath = relativeDir
      ? path.join(relativeDir, entry.name)
      : entry.name;
    const segments = nextRelativePath.split(path.sep).filter(Boolean);

    // 1. 任一路径片段以 "." 开头，则忽略（隐藏文件/目录）
    if (segments.some((seg) => seg.startsWith("."))) {
      continue;
    }

    // 2. 检查文件名是否在排除列表中
    const fileName = segments[segments.length - 1];
    if (excludeFiles.includes(fileName)) {
      continue;
    }

    // 3. 检查任一路径片段是否为排除的目录
    if (segments.some((seg) => excludeDirs.includes(seg))) {
      continue;
    }

    const fullPath = path.join(targetDir, nextRelativePath);
    let stats;
    try {
      stats = await fs.promises.lstat(fullPath);
    } catch (error) {
      log(logId, "WARN", "Error occurred when getting file stats, skipping", {
        filePath: nextRelativePath.replace(/\\/g, "/"),
        error: error.message,
      });
      continue;
    }

    // 4. 跳过符号链接和硬链接
    if (stats.isSymbolicLink() || stats.nlink > 1) {
      continue;
    }

    if (stats.isDirectory()) {
      totalSize += await calculateDownloadableDirectorySize(
        targetDir,
        excludeFiles,
        excludeDirs,
        logId,
        nextRelativePath
      );
    } else if (stats.isFile()) {
      totalSize += stats.size;
    }
  }

  return totalSize;
}

/**
 * 获取文件列表
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {string} proxyPath 代理路径
 * @param {string} [customTargetDir] 自定义目标目录，非空时直接扫描该目录，为空则按默认规则拼接 workspaceRoot/userId/cId
 * @param {string} [relativePath] 相对工作区根的目录路径（可多级），空则列出根目录
 * @param {boolean|string} [recursive] 是否递归扁平列出；默认 true（原全量逻辑）；显式 false 时仅当前目录一层
 * @returns {Promise<{files: Array, recursive: boolean}>}
 */
async function getFileList(userId, cId, proxyPath, customTargetDir, relativePath, recursive, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  // 默认 true=原全量递归；仅显式 false/"false" 时单层
  const isRecursive = !(recursive === false || recursive === "false");

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    log(logId, "INFO", "Directory does not exist, returning empty list", {
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
    });
    return { files: [], recursive: isRecursive };
  }

  const listDir = resolvePathWithinWorkspace(targetDir, relativePath);

  if (!fs.existsSync(listDir)) {
    log(logId, "INFO", "List path does not exist, returning empty list", {
      targetDir,
      listDir,
      relativePath: relativePath || "",
      userId: normalizedUserId,
      cId: normalizedCId,
    });
    return { files: [], recursive: isRecursive };
  }

  const listStat = await fs.promises.stat(listDir);
  if (!listStat.isDirectory()) {
    throw new ValidationError("relativePath 必须是目录", {
      field: "relativePath",
      relativePath,
    });
  }

  log(logId, "DEBUG", "Start getting user file list", {
    targetDir,
    listDir,
    relativePath: relativePath || "",
    recursive: isRecursive,
    userId: normalizedUserId,
    cId: normalizedCId,
  });

  try {
    const files = isRecursive
      ? await traverseDirectory(listDir, targetDir, logId, proxyPath, trimmedCustomTargetDir)
      : await listDirectoryLevel(listDir, targetDir, logId, proxyPath, trimmedCustomTargetDir);

    log(logId, "INFO", "User file list obtained successfully", {
      fileCount: files.length,
      targetDir,
      listDir,
      relativePath: relativePath || "",
      recursive: isRecursive,
      userId: normalizedUserId,
      cId: normalizedCId,
      elapsedMs: Date.now() - startTime,
    });

    return { files, recursive: isRecursive };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    log(logId, "ERROR", "Failed to get user file list", {
      targetDir,
      listDir,
      relativePath: relativePath || "",
      recursive: isRecursive,
      userId: normalizedUserId,
      cId: normalizedCId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    throw new SystemError(`Failed to get file list: ${error.message}`, {
      targetDir,
      originalError: error.message,
    });
  }
}

const SEARCH_MAX_QUEUE = 5000;

/** 必填正整数（由 Java 网关传入，file-server 不设默认值） */
function requirePositiveInt(value, field) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field} 必须为正整数`, { field, value });
  }
  return n;
}

function entryMatchesKeyword(relativePath, entryName, kwLower) {
  if (!kwLower) {
    return false;
  }
  if (entryName.toLowerCase().includes(kwLower)) {
    return true;
  }
  return relativePath.toLowerCase().includes(kwLower);
}

function isExcludedSearchEntry(entry, excludeFiles, excludeDirs) {
  if (entry.name.startsWith(".") && entry.name !== ".gitignore") {
    return true;
  }
  if (excludeFiles.includes(entry.name)) {
    return true;
  }
  if (entry.isDirectory() && excludeDirs.includes(entry.name)) {
    return true;
  }
  return false;
}

function hasRemainingSearchableEntries(entries, fromIndex, excludeFiles, excludeDirs) {
  for (let i = fromIndex; i < entries.length; i++) {
    if (!isExcludedSearchEntry(entries[i], excludeFiles, excludeDirs)) {
      return true;
    }
  }
  return false;
}

function isSearchTimedOut(startTime, timeoutMs) {
  return Date.now() - startTime >= timeoutMs;
}

/**
 * 无索引有界实时搜索：返回命中项（相对路径可还原目录结构）。
 * limit / maxVisit / timeoutMs 为必填正整数，由调用方（Java 网关）传入，本层不设默认值。
 * @returns {Promise<{files: Array, truncated: boolean, visited: number}>}
 */
async function searchFiles(
  userId,
  cId,
  proxyPath,
  kw,
  customTargetDir,
  relativePath,
  limit,
  maxVisit,
  timeoutMs,
  service = null
) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  const keyword = (kw == null ? "" : String(kw)).trim();
  if (!keyword) {
    throw new ValidationError("kw 不能为空", { field: "kw" });
  }

  const safeLimit = requirePositiveInt(limit, "limit");
  const safeMaxVisit = requirePositiveInt(maxVisit, "maxVisit");
  const safeTimeoutMs = requirePositiveInt(timeoutMs, "timeoutMs");
  const kwLower = keyword.toLowerCase();

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    return { files: [], truncated: false, visited: 0 };
  }

  const searchRootAbs = resolvePathWithinWorkspace(targetDir, relativePath);
  if (!fs.existsSync(searchRootAbs)) {
    return { files: [], truncated: false, visited: 0 };
  }
  const searchRootStat = await fs.promises.stat(searchRootAbs);
  if (!searchRootStat.isDirectory()) {
    throw new ValidationError("relativePath 必须是目录", { field: "relativePath", relativePath });
  }

  const searchRootRel = path.relative(targetDir, searchRootAbs).replace(/\\/g, "/");
  const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
  const excludeDirs = config.TRAVERSE_EXCLUDE_DIRS || [];

  const matches = [];
  /** @type {Set<string>} */
  const visitedDirs = new Set();
  let visited = 0;
  let truncated = false;
  /** 因 limit/超时等中途停下，目录或队列未耗尽 */
  let abortedIncomplete = false;
  const queue = [searchRootRel];

  const shouldHardStop = () =>
    visited >= safeMaxVisit || isSearchTimedOut(startTime, safeTimeoutMs);

  while (queue.length > 0) {
    if (shouldHardStop()) {
      abortedIncomplete = true;
      break;
    }
    if (matches.length >= safeLimit) {
      if (queue.length > 0) {
        abortedIncomplete = true;
      }
      break;
    }

    const dirRel = queue.shift();
    if (visitedDirs.has(dirRel)) {
      continue;
    }
    visitedDirs.add(dirRel);

    const dirAbs = dirRel ? path.join(targetDir, dirRel) : targetDir;
    let entries;
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      log(logId, "WARN", "search readdir failed", { dirRel, error: error.message });
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    const childDirs = [];
    let hitLimitDuringDir = false;
    let hasRemainingInDir = false;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (isExcludedSearchEntry(entry, excludeFiles, excludeDirs)) {
        continue;
      }

      if (shouldHardStop()) {
        abortedIncomplete = true;
        hitLimitDuringDir = true;
        hasRemainingInDir = true;
        break;
      }

      visited += 1;
      const fullPath = path.join(dirAbs, entry.name);
      const rel = path.relative(targetDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        childDirs.push(rel);
        if (
          matches.length < safeLimit &&
          entryMatchesKeyword(rel, entry.name, kwLower)
        ) {
          matches.push({ name: rel, isDir: true });
          if (matches.length >= safeLimit) {
            hitLimitDuringDir = true;
            hasRemainingInDir = hasRemainingSearchableEntries(
              entries,
              i + 1,
              excludeFiles,
              excludeDirs
            );
            break;
          }
        }
        continue;
      }

      try {
        if (
          matches.length < safeLimit &&
          entryMatchesKeyword(rel, entry.name, kwLower)
        ) {
          matches.push({
            name: rel,
            isDir: false,
            fileProxyUrl: buildFileProxyUrl(proxyPath, rel, trimmedCustomTargetDir),
            isLink: entry.isSymbolicLink(),
          });
          if (matches.length >= safeLimit) {
            hitLimitDuringDir = true;
            hasRemainingInDir = hasRemainingSearchableEntries(
              entries,
              i + 1,
              excludeFiles,
              excludeDirs
            );
            break;
          }
        }
      } catch (error) {
        log(logId, "WARN", `search 处理文件失败: ${fullPath}`, { error: error.message });
      }
    }

    // 满 limit：仅当仍有未扫条目 / 未入队子目录 / 队列残留时标 truncated
    if (hitLimitDuringDir || shouldHardStop()) {
      if (
        shouldHardStop() ||
        hasRemainingInDir ||
        childDirs.length > 0 ||
        queue.length > 0
      ) {
        abortedIncomplete = true;
      }
      continue;
    }

    for (const childRel of childDirs) {
      if (shouldHardStop()) {
        abortedIncomplete = true;
        break;
      }
      if (queue.length >= SEARCH_MAX_QUEUE) {
        abortedIncomplete = true;
        break;
      }
      if (visited + queue.length >= safeMaxVisit) {
        abortedIncomplete = true;
        break;
      }
      if (!visitedDirs.has(childRel)) {
        queue.push(childRel);
      }
    }
  }

  matches.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return String(a.name).localeCompare(String(b.name));
  });

  truncated =
    abortedIncomplete ||
    queue.length > 0 ||
    visited >= safeMaxVisit ||
    isSearchTimedOut(startTime, safeTimeoutMs);

  log(logId, "INFO", "File search completed", {
    kw: keyword,
    matchCount: matches.length,
    visited,
    truncated,
    relativePath: relativePath || "",
    elapsedMs: Date.now() - startTime,
  });

  return {
    files: matches,
    truncated,
    visited,
  };
}

/**
 * 更新文件：支持新增、删除、重命名、修改操作
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {Array} files 文件操作列表
 * @returns {Promise<Object>} 更新结果
 */
async function updateFiles(userId, cId, files, customTargetDir, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files must be an array", { field: "files" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 验证文件操作结构
  for (let i = 0; i < files.length; i++) {
    const fileOp = files[i];
    if (!fileOp || typeof fileOp.operation !== "string") {
      throw new ValidationError(`files[${i}].operation cannot be empty`, {
        field: `files[${i}].operation`,
      });
    }
    if (!fileOp.name || typeof fileOp.name !== "string") {
      throw new ValidationError(`files[${i}].name cannot be empty`, {
        field: `files[${i}].name`,
      });
    }

    const operation = fileOp.operation.toLowerCase();
    if (!["create", "delete", "rename", "modify"].includes(operation)) {
      throw new ValidationError(
        `files[${i}].operation must be one of create, delete, rename or modify`,
        { field: `files[${i}].operation` }
      );
    }

    // 验证特定操作所需的字段
    if (operation === "rename" && !fileOp.renameFrom) {
      throw new ValidationError(
        `files[${i}].renameFrom cannot be empty (rename operation requires)`,
        { field: `files[${i}].renameFrom` }
      );
    }

    if (operation === "modify" && fileOp.isDir !== true) {
      if (typeof fileOp.contents !== "string") {
        throw new ValidationError(
          `files[${i}].contents must be a string (modify operation requires)`,
          { field: `files[${i}].contents` }
        );
      }
    }
  }

  log(logId, "DEBUG", "Start updating user files", {
    userId: normalizedUserId,
    cId: normalizedCId,
    filesCount: files.length,
  });

  try {
    // 处理文件操作
    for (const fileOp of files) {
      const operation = fileOp.operation.toLowerCase();
      const fileName = fileOp.name;

      const normalizedPath = path.normalize(fileName).replace(/^[\/\\]+/, "");
      const targetPath = path.join(targetDir, normalizedPath);

      // 安全检查：确保目标路径在用户目录内
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedTargetDir = path.resolve(targetDir);
      if (
        !resolvedTargetPath.startsWith(resolvedTargetDir + path.sep) &&
        resolvedTargetPath !== resolvedTargetDir
      ) {
        log(logId, "WARN", "File path is not secure, skipping", {
          filePath: normalizedPath,
          resolvedPath: resolvedTargetPath,
        });
        continue;
      }

      switch (operation) {
        case "create": {
          // 创建新文件或目录
          if (fileOp.isDir === true) {
            // 创建目录前检查是否已存在
            if (fs.existsSync(targetPath)) {
              const stat = await fs.promises.stat(targetPath);
              if (stat.isFile()) {
                throw new ValidationError("Cannot create directory, file with the same name already exists", {
                  filePath: normalizedPath,
                });
              }
              // 目录已存在，跳过创建
              log(logId, "INFO", "Directory already exists, skipping creation", {
                filePath: normalizedPath,
              });
              break;
            }
            await fs.promises.mkdir(targetPath, { recursive: true });
            log(logId, "INFO", "Directory created successfully", {
              filePath: normalizedPath,
            });
            break;
          }
          
          // 创建文件前检查是否已存在
          if (fs.existsSync(targetPath)) {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
              throw new ValidationError("Cannot create file, directory with the same name already exists", {
                filePath: normalizedPath,
              });
            }
            // 文件已存在，跳过创建
            log(logId, "INFO", "File already exists, skipping creation", {
              filePath: normalizedPath,
            });
            break;
          }
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          const contents = fileOp.contents || "";
          await fs.promises.writeFile(targetPath, contents, "utf8");
          log(logId, "INFO", "File created successfully", {
            filePath: normalizedPath,
          });
          break;
        }

        case "delete": {
          // 删除文件或目录
          if (fs.existsSync(targetPath)) {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
              // 删除目录（递归删除）
              await fs.promises.rm(targetPath, { recursive: true, force: true });
              log(logId, "INFO", "Directory deleted successfully", {
                filePath: normalizedPath,
              });
            } else {
              // 删除文件
              await fs.promises.unlink(targetPath);
              log(logId, "INFO", "File deleted successfully", {
                filePath: normalizedPath,
              });
            }
          } else {
            log(logId, "WARN", "The file or directory to be deleted does not exist", {
              filePath: normalizedPath,
            });
          }
          break;
        }

        case "rename": {
          // 重命名文件或目录
          const renameFrom = fileOp.renameFrom;
          if (!renameFrom || typeof renameFrom !== "string") {
            log(logId, "WARN", "Rename operation missing renameFrom", {
              filePath: normalizedPath,
            });
            break;
          }

          const normalizedFrom = path
            .normalize(renameFrom)
            .replace(/^[\/\\]+/, "");
          const sourcePath = path.join(targetDir, normalizedFrom);

          // 安全检查：确保源路径在用户目录内
          const resolvedSourcePath = path.resolve(sourcePath);
          if (
            !resolvedSourcePath.startsWith(resolvedTargetDir + path.sep) &&
            resolvedSourcePath !== resolvedTargetDir
          ) {
            log(logId, "WARN", "Source path is not secure, skipping rename", {
              sourcePath: normalizedFrom,
              targetPath: normalizedPath,
            });
            break;
          }

          if (fs.existsSync(sourcePath)) {
            const stat = await fs.promises.stat(sourcePath);
            const isDirectory = stat.isDirectory();
            
            // 确保目标路径的父目录存在（文件和目录重命名都需要）
            await fs.promises.mkdir(path.dirname(targetPath), {
              recursive: true,
            });
            
            await fs.promises.rename(sourcePath, targetPath);
            log(logId, "INFO", isDirectory ? "Directory renamed successfully" : "File renamed successfully", {
              sourcePath: normalizedFrom,
              targetPath: normalizedPath,
            });
          } else {
            log(logId, "WARN", "The file or directory to be renamed does not exist", {
              sourcePath: normalizedFrom,
            });
          }
          break;
        }

        case "modify": {
          // 修改文件：直接写入新内容
          if (!fs.existsSync(targetPath)) {
            log(logId, "WARN", "The file to be modified does not exist", {
              filePath: normalizedPath,
            });
            break;
          }

          // 如果是目录，跳过修改
          const modifyStat = await fs.promises.stat(targetPath);
          if (modifyStat.isDirectory()) {
            log(logId, "INFO", "The target is a directory, skipping modification", {
              filePath: normalizedPath,
            });
            break;
          }

          const newContentStr =
            typeof fileOp.contents === "string" ? fileOp.contents : "";

          // 读取现有文件内容进行比较
          const existingContent = await fs.promises.readFile(
            targetPath,
            "utf8"
          );

          // 若内容完全一致，不覆写文件
          if (existingContent === newContentStr) {
            log(logId, "INFO", "File content has no changes, skipping write", {
              filePath: normalizedPath,
            });
            break;
          }

          // 写入修改后的内容
          await fs.promises.writeFile(targetPath, newContentStr, "utf8");
          log(logId, "INFO", "File modified successfully", {
            filePath: normalizedPath,
          });
          break;
        }

        default: {
          log(logId, "WARN", "Unsupported operation type", {
            operation,
            filePath: normalizedPath,
          });
          break;
        }
      }
    }

    log(logId, "INFO", "User files updated successfully", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filesCount: files.length,
      elapsedMs: Date.now() - startTime,
    });

    return {
      success: true,
      message: "User files updated successfully",
      userId: normalizedUserId,
      cId: normalizedCId,
      filesCount: files.length,
    };
  } catch (error) {
    log(logId, "ERROR", "User files updated failed", {
      userId: normalizedUserId,
      cId: normalizedCId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    throw new SystemError(`User files updated failed: ${error.message}`, {
      userId: normalizedUserId,
      cId: normalizedCId,
      originalError: error.message,
    });
  }
}

/**
 * 上传单个文件到用户工作目录
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {Object} file 文件对象 (包含文件内容和元数据)
 * @param {string} filePath 文件在用户目录中的相对路径
 * @returns {Promise<Object>} 上传结果
 */
async function uploadFile(userId, cId, file, filePath, customTargetDir, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!file) {
    throw new ValidationError("file cannot be empty", { field: "file" });
  }
  if (!filePath || typeof filePath !== "string") {
    throw new ValidationError("filePath cannot be empty", { field: "filePath" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 规范化文件路径，确保是相对路径
  const normalizedPath = path.normalize(filePath).replace(/^[\/\\]+/, "");
  const targetPath = path.join(targetDir, normalizedPath);

  // 安全检查：确保目标路径在用户目录内
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedTargetDir = path.resolve(targetDir);
  if (
    !resolvedTargetPath.startsWith(resolvedTargetDir + path.sep) &&
    resolvedTargetPath !== resolvedTargetDir
  ) {
    throw new ValidationError("File path is not secure, cannot exceed user directory", {
      field: "filePath",
      providedPath: filePath,
      resolvedPath: resolvedTargetPath,
    });
  }

  try {
    // 确保目标目录存在
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    // 写入文件内容
    if (file.buffer) {
      // 如果是二进制文件（buffer）
      await fs.promises.writeFile(targetPath, file.buffer);
    } else if (typeof file.contents === "string") {
      // 如果是文本文件
      await fs.promises.writeFile(targetPath, file.contents, "utf8");
    } else {
      throw new ValidationError("File content format is incorrect", {
        field: "file",
        hasBuffer: !!file.buffer,
        hasContents: typeof file.contents,
      });
    }

    log(logId, "INFO", "File uploaded successfully", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filePath: normalizedPath,
      targetPath: resolvedTargetPath,
      fileSize: file.buffer
        ? file.buffer.length
        : file.contents
        ? file.contents.length
        : 0,
      elapsedMs: Date.now() - startTime,
    });

    return {
      success: true,
      message: "File uploaded successfully",
      fileSize: file.buffer
        ? file.buffer.length
        : file.contents
        ? file.contents.length
        : 0,
    };
  } catch (error) {
    log(logId, "ERROR", "File upload failed", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filePath: normalizedPath,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    throw new SystemError(`File upload failed: ${error.message}`, {
      userId: normalizedUserId,
      cId: normalizedCId,
      filePath: normalizedPath,
      originalError: error.message,
    });
  }
}

/**
 * 批量上传文件到用户工作目录
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {Array<Object>} files 文件对象数组，每个文件对象包含：
 *   - buffer: Buffer (二进制文件) 或 contents: string (文本文件)
 *   - originalname: string 原始文件名
 *   - mimetype: string MIME类型
 *   - size: number 文件大小
 * @param {Array<string>} filePaths 文件路径数组，与files数组一一对应
 * @returns {Promise<Object>} 批量上传结果
 */
async function uploadFiles(userId, cId, files, filePaths, customTargetDir, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files must be an array", { field: "files" });
  }
  if (!Array.isArray(filePaths)) {
    throw new ValidationError("filePaths must be an array", { field: "filePaths" });
  }
  if (files.length !== filePaths.length) {
    throw new ValidationError(
      `File count (${files.length}) does not match path count (${filePaths.length})`,
      { field: "filePaths" }
    );
  }

  log(logId, "DEBUG", "Start batch uploading files", {
    userId,
    cId,
    filesCount: files.length,
  });

  const results = [];

  try {
    // 处理每个文件
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = filePaths[i];

      if (!file) {
        log(logId, "WARN", "Empty file object encountered in batch upload, skipping", {
          index: i,
          filePath,
        });
        results.push({
          success: false,
          filePath,
          error: "Empty file object",
        });
        continue;
      }

      if (!filePath || typeof filePath !== "string") {
        log(logId, "WARN", "Invalid file path in batch upload, skipping", {
          index: i,
          originalname: file.originalname,
        });
        results.push({
          success: false,
          filePath: filePath || "",
          originalname: file.originalname,
          error: "Invalid file path",
        });
        continue;
      }

      try {
        const result = await uploadFile(userId, cId, file, filePath, customTargetDir, service);
        results.push({
          success: true,
          filePath,
          originalname: file.originalname,
          ...result,
        });
      } catch (error) {
        log(logId, "ERROR", "Single file upload failed in batch upload", {
          filePath,
          originalname: file.originalname,
          error: error.message,
        });
        results.push({
          success: false,
          filePath,
          originalname: file.originalname,
          error: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    log(logId, "INFO", "Batch upload files completed", {
      userId,
      cId,
      totalCount: files.length,
      successCount,
      failCount,
      elapsedMs: Date.now() - startTime,
    });

    return {
      success: true,
      message: "Batch upload completed",
      totalCount: files.length,
      successCount,
      failCount,
      results,
    };
  } catch (error) {
    log(logId, "ERROR", "Batch upload files failed", {
      userId,
      cId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    throw new SystemError(`Batch upload files failed: ${error.message}`, {
      userId,
      cId,
      originalError: error.message,
    });
  }
}

/**
 * 下载所有文件
 * - 压缩目录：COMPUTER_WORKSPACE_DIR/<userId>/<cId>/
 * - 顶层目录名：userId_cId
 * - 过滤规则与 get-file-list 路由保持一致：
 *   1. 忽略所有隐藏文件/目录（任一路径片段以 "." 开头）
 *   2. 排除 CONTENT_TRAVERSE_EXCLUDE_FILES 配置的文件
 *   3. 排除 TRAVERSE_EXCLUDE_DIRS 配置的目录（如 node_modules）
 *   4. 跳过符号链接（Symbolic Links）
 *   5. 跳过硬链接（Hard Links，nlink > 1 的文件）
 *
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @returns {Promise<{ archive: import("archiver").Archiver, zipFileName: string }>}
 */
async function downloadAllFiles(userId, cId, customTargetDir, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = resolveWorkspaceRoot(service);

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!workspaceRoot) {
    throw new SystemError("COMPUTER_WORKSPACE_DIR is not configured, cannot create zip");
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const trimmedCustomTargetDir =
    customTargetDir && customTargetDir.trim() ? customTargetDir.trim() : null;
  const targetDir = trimmedCustomTargetDir
    ? trimmedCustomTargetDir
    : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    // 目录不存在时，返回一个仅包含顶层目录的空压缩包
    const zipFileName = `${normalizedUserId}_${normalizedCId}.zip`;

    log(logId, "WARN", "Workspace directory does not exist, returning empty zip", {
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
      zipFileName,
    });

    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    // 创建一个空的顶层目录条目
    archive.append(null, {
      name: `${normalizedUserId}_${normalizedCId}/`,
      type: "directory",
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        log(logId, "WARN", "Encountered file problem when creating empty zip", {
          message: err.message,
          code: err.code,
        });
      } else {
        log(logId, "ERROR", "Encountered warning when creating empty zip", {
          message: err.message,
          code: err.code,
        });
        throw err;
      }
    });

    archive.on("error", (err) => {
      log(logId, "ERROR", "Failed to create empty zip", {
        message: err.message,
      });
    });

    return { archive, zipFileName };
  }

  const zipFileName = `${normalizedUserId}_${normalizedCId}.zip`;

  log(logId, "DEBUG", "Start creating workspace directory zip", {
    targetDir,
    zipFileName,
  });

  const archive = archiver("zip", {
    zlib: { level: 9 },
  });

  // 获取排除配置
  const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
  const excludeDirs = config.TRAVERSE_EXCLUDE_DIRS || [];
  const downloadableSize = await calculateDownloadableDirectorySize(
    targetDir,
    excludeFiles,
    excludeDirs,
    logId
  );
  if (downloadableSize > DOWNLOAD_MAX_FILE_SIZE_BYTES) {
    const maxSizeMb = DOWNLOAD_MAX_FILE_SIZE_BYTES / 1024 / 1024;
    const currentSizeMb = (downloadableSize / 1024 / 1024).toFixed(2);
    log(logId, "WARN", "Download rejected due to oversized workspace", {
      targetDir,
      downloadableSize,
      maxSizeBytes: DOWNLOAD_MAX_FILE_SIZE_BYTES,
    });
    throw new ValidationError(
      `Download failed: total file size ${currentSizeMb}MB exceeds limit ${maxSizeMb}MB`,
      {
        field: "downloadSize",
        downloadableSize,
        maxSizeBytes: DOWNLOAD_MAX_FILE_SIZE_BYTES,
      }
    );
  }

  // 过滤文件/目录，与 get-file-list 路由保持一致
  archive.directory(
    targetDir,
    `${normalizedUserId}_${normalizedCId}`,
    (entry) => {
      const name = entry.name || "";
      const segments = name.split(/[\/\\]/).filter(Boolean);

      // 1. 任一路径片段以 "." 开头，则忽略（隐藏文件/目录）
      if (segments.some((seg) => seg.startsWith("."))) {
        return false;
      }

      // 2. 检查文件名是否在排除列表中
      const fileName = segments[segments.length - 1];
      if (excludeFiles.includes(fileName)) {
        return false;
      }

      // 3. 检查任一路径片段是否为排除的目录
      if (segments.some((seg) => excludeDirs.includes(seg))) {
        return false;
      }

      // 4. 检测并跳过链接文件（符号链接和硬链接）
      try {
        const fullPath = path.join(targetDir, name);
        const stats = fs.lstatSync(fullPath);

        // 跳过符号链接
        if (stats.isSymbolicLink()) {
          return false;
        }

        // 跳过硬链接（nlink > 1 表示文件有多个硬链接）
        if (stats.nlink > 1) {
          return false;
        }
      } catch (error) {
        // 如果无法获取文件信息（如文件不存在、权限问题等），记录警告但继续处理
        log(logId, "WARN", "Error occurred when detecting link file, skipping", {
          filePath: name,
          error: error.message,
        });
        return false;
      }

      return entry;
    }
  );

  archive.on("warning", (err) => {
    // 一些非致命错误（如文件不存在）记录日志即可
    if (err.code === "ENOENT") {
      log(logId, "WARN", "Encountered file problem when creating zip", {
        message: err.message,
        code: err.code,
      });
    } else {
      log(logId, "ERROR", "Encountered warning when creating zip", {
        message: err.message,
        code: err.code,
      });
      throw err;
    }
  });

  archive.on("error", (err) => {
    log(logId, "ERROR", "Failed to create zip", {
      message: err.message,
      elapsedMs: Date.now() - startTime,
    });
  });

  archive.on("end", () => {
    log(logId, "INFO", "Workspace directory zip created successfully", {
      targetDir,
      zipFileName,
      elapsedMs: Date.now() - startTime,
    });
  });

  return { archive, zipFileName };
}

/**
 * 获取沙盒最新日志
 * - 日志目录：COMPUTER_WORKSPACE_DIR/<userId>/<cId>/.logs/
 * - 取该目录下最后修改的文件（不限制后缀），读取最后 N 行
 * - 返回结构与 getDevLog 保持一致（不含 projectId、cacheHit、fileTooLarge）
 * - 使用纯 Node.js 实现，跨平台兼容
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {number} tailLines 读取最后 N 行，默认 200
 * @returns {Promise<{ success: boolean, message: string, logs: Array<{line: number, content: string}>, totalLines: number, startIndex: number, logFileName: string|null }>}
 */
async function getLatestLogs(userId, cId, tailLines = 200, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const logDir = resolveLogDir(service, normalizedUserId, normalizedCId);

  if (!logDir) {
    log(logId, "WARN", "COMPUTER_WORKSPACE_DIR is not configured");
    return {
      success: true,
      message: "Log workspace is not configured",
      logs: [],
      totalLines: 0,
      startIndex: 1,
      logFileName: null,
    };
  }

  if (!fs.existsSync(logDir)) {
    log(logId, "DEBUG", "Log directory does not exist", { logDir });
    return {
      success: true,
      message: "Log directory does not exist",
      logs: [],
      totalLines: 0,
      startIndex: 1,
      logFileName: null,
    };
  }

  // 列出所有文件（不限制后缀），排除目录
  const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  const logFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  if (logFiles.length === 0) {
    log(logId, "DEBUG", "No log file found", { logDir });
    return {
      success: true,
      message: "No log file found",
      logs: [],
      totalLines: 0,
      startIndex: 1,
      logFileName: null,
    };
  }

  // 获取每个文件的修改时间和大小，按修改时间倒序取最新文件
  const fileInfos = [];
  for (const f of logFiles) {
    const fullPath = path.join(logDir, f);
    const stat = await fs.promises.stat(fullPath);
    fileInfos.push({ name: f, fullPath, mtime: stat.mtimeMs, size: stat.size });
  }
  fileInfos.sort((a, b) => b.mtime - a.mtime);

  const latestFile = fileInfos[0];

  // 读取文件内容，取最后 N 行
  const content = await fs.promises.readFile(latestFile.fullPath, "utf8");
  const allLines = content.split("\n").filter((l) => l.length > 0);
  const totalLines = allLines.length;

  const maxLines = Math.max(1, tailLines);
  // 计算实际起始位置（数组索引与用户视角行号）
  const arrayStartIndex = Math.max(0, totalLines - maxLines);
  const startIndex = arrayStartIndex + 1; // 用户视角行号从 1 开始

  const relevantLines = allLines.slice(arrayStartIndex);

  // 构建带行号的日志数据，与 getDevLog 结构保持一致
  const logs = relevantLines.map((lineContent, index) => ({
    line: startIndex + index,
    content: lineContent,
  }));

  log(logId, "DEBUG", "Get latest logs", {
    fileName: latestFile.name,
    fileSize: latestFile.size,
    totalLines,
    returnedLines: logs.length,
    elapsedMs: Date.now() - startTime,
  });

  return {
    success: true,
    message: "Get log successfully",
    logs,
    totalLines,
    startIndex,
    logFileName: latestFile.name,
  };
}

/**
 * 若解压目录仅含一个非隐藏顶层目录，则将其内容上移一层
 */
async function removeTopLevelDir(dirPath, logId) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const filtered = entries.filter(
      (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules"
    );

    if (filtered.length !== 1 || !filtered[0].isDirectory()) {
      return;
    }

    const topDir = path.join(dirPath, filtered[0].name);
    const tmpDir = path.join(
      dirPath,
      `..tmp_${Date.now()}_${Math.round(Math.random() * 1e6)}`
    );

    try {
      await fs.promises.rename(topDir, tmpDir);
    } catch (renameErr) {
      if (renameErr.code === "EXDEV") {
        await fs.promises.cp(topDir, tmpDir, { recursive: true });
        await fs.promises.rm(topDir, { recursive: true, force: true });
      } else {
        throw renameErr;
      }
    }

    const tmpEntries = await fs.promises.readdir(tmpDir);
    for (const entry of tmpEntries) {
      const src = path.join(tmpDir, entry);
      const dest = path.join(dirPath, entry);
      try {
        await fs.promises.rename(src, dest);
      } catch (err) {
        if (err.code === "EXDEV") {
          const stat = await fs.promises.lstat(src);
          if (stat.isDirectory()) {
            await moveDirectory(src, dest);
          } else {
            await fs.promises.copyFile(src, dest);
            await fs.promises.unlink(src);
          }
        } else {
          throw err;
        }
      }
    }

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    log(logId, "INFO", "Removed single top-level directory from imported zip", {
      removedDir: filtered[0].name,
    });
  } catch (error) {
    log(logId, "WARN", "Failed to remove top-level directory from imported zip, continuing", {
      error: error.message,
    });
  }
}

/**
 * 清空工作目录，保留白名单内的目录/文件
 */
async function clearWorkspaceExceptPreserved(targetDir, logId) {
  if (!fs.existsSync(targetDir)) {
    await fs.promises.mkdir(targetDir, { recursive: true });
    return;
  }

  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IMPORT_PROJECT_PRESERVED_ENTRIES.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(targetDir, entry.name);
    await fs.promises.rm(fullPath, { recursive: true, force: true });
    log(logId, "DEBUG", "Removed workspace entry during import", { name: entry.name });
  }
}

/**
 * 将非白名单内容移动到备份目录（用于导入失败时回滚）
 */
async function backupWorkspaceExceptPreserved(targetDir, backupDir, logId) {
  await fs.promises.mkdir(backupDir, { recursive: true });
  if (!fs.existsSync(targetDir)) {
    await fs.promises.mkdir(targetDir, { recursive: true });
    return;
  }

  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IMPORT_PROJECT_PRESERVED_ENTRIES.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(targetDir, entry.name);
    const destPath = path.join(backupDir, entry.name);
    await movePath(srcPath, destPath);
    log(logId, "DEBUG", "Backed up workspace entry before import", { name: entry.name });
  }
}

/**
 * 从备份目录恢复工作区内容
 */
async function restoreWorkspaceFromBackup(backupDir, targetDir, logId) {
  if (!fs.existsSync(backupDir)) {
    return;
  }

  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IMPORT_PROJECT_PRESERVED_ENTRIES.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(backupDir, entry.name);
    const destPath = path.join(targetDir, entry.name);
    await movePath(srcPath, destPath);
  }

  log(logId, "INFO", "Workspace restored from backup after import failure");
}

/**
 * 将解压后的内容合并到工作目录，跳过白名单目录
 */
async function mergeExtractedIntoWorkspace(extractRoot, targetDir, logId) {
  const items = await fs.promises.readdir(extractRoot, { withFileTypes: true });
  const mergedEntries = [];

  try {
    for (const item of items) {
      if (IMPORT_PROJECT_PRESERVED_ENTRIES.has(item.name)) {
        log(logId, "INFO", "Skipping preserved entry from imported zip", { name: item.name });
        continue;
      }

      const srcPath = path.join(extractRoot, item.name);
      const destPath = path.join(targetDir, item.name);
      await movePath(srcPath, destPath);
      mergedEntries.push(item.name);
    }
  } catch (error) {
    error.mergedEntries = mergedEntries;
    throw error;
  }
}

/**
 * 导入项目：解压 zip 后替换工作目录（保留白名单），失败时回滚
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object} file multer 文件对象（zip）
 * @param {string} [customTargetDir]
 */
async function importProject(userId, cId, file, customTargetDir, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = resolveWorkspaceRoot(service);

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!file || !file.path) {
    throw new ValidationError("file is required", { field: "file" });
  }
  if (!workspaceRoot) {
    throw new SystemError("COMPUTER_WORKSPACE_DIR is not configured");
  }

  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  if (ext !== ".zip") {
    throw new ValidationError("Only zip files are supported", {
      field: "file",
      originalName: file.originalname,
    });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const targetDir =
    customTargetDir && customTargetDir.trim()
      ? customTargetDir.trim()
      : resolveWorkspaceDir(service, normalizedUserId, normalizedCId);
  const tmpRoot = path.join(targetDir, ".tmp");
  const extractRoot = path.join(
    tmpRoot,
    `import_project_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
  );
  let backupDir = null;

  log(logId, "INFO", "Start importing project from zip", {
    userId: normalizedUserId,
    cId: normalizedCId,
    targetDir,
    fileName: file.originalname,
  });

  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.mkdir(tmpRoot, { recursive: true });
    await fs.promises.mkdir(extractRoot, { recursive: true });

    // 1. 先解压并校验 zip，失败时不改动现有工作区
    await extractZip(file.path, extractRoot);
    await removeTopLevelDir(extractRoot, logId);

    // 2. 备份当前非白名单内容，再合并新文件
    backupDir = path.join(
      tmpRoot,
      `import_backup_${Date.now()}_${Math.round(Math.random() * 1e6)}`
    );
    await backupWorkspaceExceptPreserved(targetDir, backupDir, logId);

    try {
      await mergeExtractedIntoWorkspace(extractRoot, targetDir, logId);
    } catch (mergeError) {
      log(logId, "ERROR", "Merge imported project failed, restoring workspace", {
        error: mergeError.message,
        mergedEntries: mergeError.mergedEntries || [],
      });
      await clearWorkspaceExceptPreserved(targetDir, logId);
      await restoreWorkspaceFromBackup(backupDir, targetDir, logId);
      throw mergeError;
    }

    if (fs.existsSync(backupDir)) {
      await fs.promises.rm(backupDir, { recursive: true, force: true });
      backupDir = null;
    }

    log(logId, "INFO", "Project imported successfully", {
      userId: normalizedUserId,
      cId: normalizedCId,
      targetDir,
      elapsedMs: Date.now() - startTime,
    });

    return {
      success: true,
      message: "Project imported successfully",
      userId: normalizedUserId,
      cId: normalizedCId,
      targetDir,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to import project", {
      userId: normalizedUserId,
      cId: normalizedCId,
      targetDir,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    if (error instanceof ValidationError || error instanceof SystemError || error instanceof FileError) {
      throw error;
    }

    throw new SystemError(`Failed to import project: ${error.message}`, {
      userId: normalizedUserId,
      cId: normalizedCId,
      originalError: error.message,
    });
  } finally {
    if (fs.existsSync(extractRoot)) {
      try {
        await fs.promises.rm(extractRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        log(logId, "WARN", "Failed to clean import extract directory", {
          extractRoot,
          error: cleanupError.message,
        });
      }
    }
    if (backupDir && fs.existsSync(backupDir)) {
      try {
        await fs.promises.rm(backupDir, { recursive: true, force: true });
      } catch (cleanupError) {
        log(logId, "WARN", "Failed to clean import backup directory", {
          backupDir,
          error: cleanupError.message,
        });
      }
    }
    if (file?.path && fs.existsSync(file.path)) {
      try {
        await fs.promises.unlink(file.path);
      } catch (cleanupError) {
        log(logId, "WARN", "Failed to clean uploaded zip file", {
          tempZipPath: file.path,
          error: cleanupError.message,
        });
      }
    }
  }
}

/**
 * 根据文本内容生成文件到用户工作目录
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {string} fileName 文件名（含后缀，可为相对路径）
 * @param {string} content 文本内容
 * @param {string} [customTargetDir] 自定义目标目录
 * @returns {Promise<Object>} 生成结果
 */
async function generateFile(userId, cId, fileName, content, customTargetDir, service = null) {
  const logId = `computer:${userId}:${cId}`;

  if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
    throw new ValidationError("fileName cannot be empty", { field: "fileName" });
  }
  if (content !== undefined && content !== null && typeof content !== "string") {
    throw new ValidationError("content must be a string", { field: "content" });
  }

  const normalizedFileName = fileName.trim();
  const textContent = content == null ? "" : content;

  log(logId, "INFO", "Generate file from text content", {
    userId,
    cId,
    fileName: normalizedFileName,
    contentLength: textContent.length,
  });

  const result = await uploadFile(
    userId,
    cId,
    {
      contents: textContent,
      originalname: path.basename(normalizedFileName),
      size: Buffer.byteLength(textContent, "utf8"),
    },
    normalizedFileName,
    customTargetDir,
    service
  );

  return {
    ...result,
    message: "File generated successfully",
    fileName: normalizedFileName,
  };
}

export {
  getFileList,
  resolveExistingFile,
  searchFiles,
  updateFiles,
  uploadFile,
  uploadFiles,
  generateFile,
  downloadAllFiles,
  getLatestLogs,
  importProject,
  IMPORT_PROJECT_PRESERVED_ENTRIES,
  removeTopLevelDir,
};
