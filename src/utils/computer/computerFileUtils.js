import fs from "fs";
import path from "path";
import archiver from "archiver";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError, SystemError } from "../error/errorHandler.js";

const DEFAULT_DOWNLOAD_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_MAX_FILE_SIZE_BYTES =
  config.DOWNLOAD_MAX_FILE_SIZE_BYTES || DEFAULT_DOWNLOAD_MAX_FILE_SIZE_BYTES;

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
        // 空目录，返回目录信息
        const referencePath = basePath || targetDir;
        // 统一使用正斜杠，保证 Windows/Linux 跨平台一致性及 URL 正确性
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
        // 统一使用正斜杠，保证 Windows/Linux 跨平台一致性及 URL 正确性
        const relativePath = path.relative(referencePath, fullPath).replace(/\\/g, "/");

        const isLink = entry.isSymbolicLink();

        // 生成文件代理URL，对路径段进行编码以支持空格、中文等特殊字符
        let fileProxyUrl = null;
        if (proxyPath) {
          const encodedPath = relativePath
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
          fileProxyUrl = `${proxyPath}/${encodedPath}`;
          if (customTargetDir) {
            fileProxyUrl += `?customTargetDir=${encodeURIComponent(customTargetDir)}`;
          }
        }

        const fileInfo = {
          name: relativePath,
          isDir: false,
          fileProxyUrl: fileProxyUrl,
          isLink: isLink,
        };

        files.push(fileInfo);
      } catch (error) {
        log(logId, "WARN", `处理文件失败: ${fullPath}`, { error: error.message });
      }
    }
  }

  return files;
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
 * @returns {Promise<{files: Array}>}
 */
async function getFileList(userId, cId, proxyPath, customTargetDir) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const targetDir = (customTargetDir && customTargetDir.trim())
    ? customTargetDir
    : path.join(workspaceRoot, normalizedUserId, normalizedCId);
  

  if (!fs.existsSync(targetDir)) {
    log(logId, "INFO", "Directory does not exist, returning empty list", {
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
    });
    return { files: [] };
  }

  log(logId, "DEBUG", "Start getting user file list", {
    targetDir,
    userId: normalizedUserId,
    cId: normalizedCId,
  });

  try {
    const files = await traverseDirectory(targetDir, targetDir, logId, proxyPath, customTargetDir);

    log(logId, "INFO", "User file list obtained successfully", {
      fileCount: files.length,
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
      elapsedMs: Date.now() - startTime,
    });

    return { files };
  } catch (error) {
    log(logId, "ERROR", "Failed to get user file list", {
      targetDir,
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

/**
 * 更新文件：支持新增、删除、重命名、修改操作
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {Array} files 文件操作列表
 * @returns {Promise<Object>} 更新结果
 */
async function updateFiles(userId, cId, files, customTargetDir) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

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
  const targetDir = (customTargetDir && customTargetDir.trim())
    ? customTargetDir
    : path.join(workspaceRoot, normalizedUserId, normalizedCId);

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
async function uploadFile(userId, cId, file, filePath, customTargetDir) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

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
  const targetDir = (customTargetDir && customTargetDir.trim())
    ? customTargetDir
    : path.join(workspaceRoot, normalizedUserId, normalizedCId);

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
async function uploadFiles(userId, cId, files, filePaths, customTargetDir) {
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
        const result = await uploadFile(userId, cId, file, filePath, customTargetDir);
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
async function downloadAllFiles(userId, cId, customTargetDir) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

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
  const targetDir = (customTargetDir && customTargetDir.trim())
    ? customTargetDir
    : path.join(workspaceRoot, normalizedUserId, normalizedCId);

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
 * - 日志目录：COMPUTER_LOG_DIR/<userId>/<cId>/.logs/
 * - 取该目录下最后修改的文件（不限制后缀），读取最后 N 行
 * - 使用纯 Node.js 实现，跨平台兼容
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @param {number} tailLines 读取最后 N 行，默认 200
 * @returns {Promise<{ fileName: string|null, fileSize: number, lines: string[] }>}
 */
async function getLatestLogs(userId, cId, tailLines = 200) {
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
  const computerLogDir = config.COMPUTER_LOG_DIR;

  if (!computerLogDir) {
    log(logId, "WARN", "COMPUTER_LOG_DIR is not configured");
    return { fileName: null, fileSize: 0, lines: [] };
  }

  const logDir = path.join(computerLogDir, normalizedUserId, normalizedCId, ".logs");

  if (!fs.existsSync(logDir)) {
    log(logId, "DEBUG", "Log directory does not exist", { logDir });
    return { fileName: null, fileSize: 0, lines: [] };
  }

  // 列出所有文件（不限制后缀），排除目录
  const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  const logFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  if (logFiles.length === 0) {
    log(logId, "DEBUG", "No log file found", { logDir });
    return { fileName: null, fileSize: 0, lines: [] };
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
  const maxLines = Math.max(1, tailLines);
  const lines = allLines.slice(-maxLines);

  log(logId, "DEBUG", "Get latest logs", {
    fileName: latestFile.name,
    fileSize: latestFile.size,
    totalLines: allLines.length,
    returnedLines: lines.length,
    elapsedMs: Date.now() - startTime,
  });

  return {
    fileName: latestFile.name,
    fileSize: latestFile.size,
    lines,
  };
}

export { getFileList, updateFiles, uploadFile, uploadFiles, downloadAllFiles, getLatestLogs };

