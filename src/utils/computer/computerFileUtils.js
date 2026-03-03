import fs from "fs";
import path from "path";
import archiver from "archiver";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError, SystemError } from "../error/errorHandler.js";

function isBinaryFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return true;
    const text = buffer.toString("utf-8");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
    }
    return false;
  } catch (error) {
    log("system", "WARN", `检测二进制文件失败: ${filePath}`, { error: error.message });
    return false;
  }
}

function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".avif"].includes(ext);
}

async function traverseDirectory(targetDir, basePath, logId, proxyPath) {
  const files = [];
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);

    if (entry.name.startsWith(".")) continue;

    const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
    if (excludeFiles.includes(entry.name)) continue;

    if (entry.isDirectory() && config.TRAVERSE_EXCLUDE_DIRS.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      const sub = await traverseDirectory(fullPath, basePath, logId, proxyPath);
      if (sub.length === 0) {
        // 空目录，返回目录信息
        const referencePath = basePath || targetDir;
        const relativePath = path.relative(referencePath, fullPath);
        files.push({
          name: relativePath,
          isDir: true,
        });
      } else {
        files.push(...sub);
      }
    } else {
      try {
        const stats = await fs.promises.stat(fullPath);
        const referencePath = basePath || targetDir;
        const relativePath = path.relative(referencePath, fullPath);

        const binary = isBinaryFile(fullPath);
        const isLink = entry.isSymbolicLink();
        
        // 生成文件代理URL
        let fileProxyUrl = null;
        if (proxyPath) {
          fileProxyUrl = `${proxyPath}/${relativePath}`;
        }
        
        const fileInfo = {
          name: relativePath,
          isDir: false,
          binary,
          //sizeExceeded: stats.size > config.MAX_INLINE_FILE_SIZE_BYTES,
          //contents: "",
          fileProxyUrl: fileProxyUrl,
          isLink: isLink,
        };

        // if (!fileInfo.sizeExceeded) {
        //   if (binary) {
        //     if (isImageFile(fullPath)) {
        //       const buffer = fs.readFileSync(fullPath);
        //       fileInfo.contents = buffer.toString("base64");
        //     }
        //   } else {
        //     fileInfo.contents = fs.readFileSync(fullPath, "utf-8");
        //   }
        // }

        files.push(fileInfo);
      } catch (error) {
        log(logId, "WARN", `处理文件失败: ${fullPath}`, { error: error.message });
      }
    }
  }

  return files;
}

/**
 * 获取文件列表
 * @param {string|number} userId 用户ID
 * @param {string|number} cId 会话ID
 * @returns {Promise<{files: Array}>}
 */
async function getFileList(userId, cId, proxyPath) {
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
  const targetDir = path.join(workspaceRoot, normalizedUserId, normalizedCId);
  

  if (!fs.existsSync(targetDir)) {
    log(logId, "INFO", "目录不存在，返回空列表", {
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
    });
    return { files: [] };
  }

  log(logId, "INFO", "开始获取用户文件列表", {
    targetDir,
    userId: normalizedUserId,
    cId: normalizedCId,
  });

  try {
    const files = await traverseDirectory(targetDir, targetDir, logId, proxyPath);

    log(logId, "INFO", "用户文件列表获取完成", {
      fileCount: files.length,
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
    });

    return { files };
  } catch (error) {
    log(logId, "ERROR", "获取用户文件列表失败", {
      targetDir,
      userId: normalizedUserId,
      cId: normalizedCId,
      error: error.message,
    });

    throw new SystemError(`获取文件列表失败: ${error.message}`, {
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
async function updateFiles(userId, cId, files) {
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files必须是数组", { field: "files" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const targetDir = path.join(workspaceRoot, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 验证文件操作结构
  for (let i = 0; i < files.length; i++) {
    const fileOp = files[i];
    if (!fileOp || typeof fileOp.operation !== "string") {
      throw new ValidationError(`files[${i}].operation 不能为空`, {
        field: `files[${i}].operation`,
      });
    }
    if (!fileOp.name || typeof fileOp.name !== "string") {
      throw new ValidationError(`files[${i}].name 不能为空`, {
        field: `files[${i}].name`,
      });
    }

    const operation = fileOp.operation.toLowerCase();
    if (!["create", "delete", "rename", "modify"].includes(operation)) {
      throw new ValidationError(
        `files[${i}].operation 必须是 create、delete、rename 或 modify 之一`,
        { field: `files[${i}].operation` }
      );
    }

    // 验证特定操作所需的字段
    if (operation === "rename" && !fileOp.renameFrom) {
      throw new ValidationError(
        `files[${i}].renameFrom 不能为空（重命名操作需要）`,
        { field: `files[${i}].renameFrom` }
      );
    }

    if (operation === "modify" && fileOp.isDir !== true) {
      if (typeof fileOp.contents !== "string") {
        throw new ValidationError(
          `files[${i}].contents 必须是字符串（修改操作需要）`,
          { field: `files[${i}].contents` }
        );
      }
    }
  }

  log(logId, "INFO", "开始更新用户文件", {
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
        log(logId, "WARN", "文件路径不安全，跳过", {
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
                throw new ValidationError("无法创建目录，已存在同名文件", {
                  filePath: normalizedPath,
                });
              }
              // 目录已存在，跳过创建
              log(logId, "INFO", "目录已存在，跳过创建", {
                filePath: normalizedPath,
              });
              break;
            }
            await fs.promises.mkdir(targetPath, { recursive: true });
            log(logId, "INFO", "目录创建成功", {
              filePath: normalizedPath,
            });
            break;
          }
          
          // 创建文件前检查是否已存在
          if (fs.existsSync(targetPath)) {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
              throw new ValidationError("无法创建文件，已存在同名目录", {
                filePath: normalizedPath,
              });
            }
            // 文件已存在，跳过创建
            log(logId, "INFO", "文件已存在，跳过创建", {
              filePath: normalizedPath,
            });
            break;
          }
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          const contents = fileOp.contents || "";
          await fs.promises.writeFile(targetPath, contents, "utf8");
          log(logId, "INFO", "文件创建成功", {
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
              log(logId, "INFO", "目录删除成功", {
                filePath: normalizedPath,
              });
            } else {
              // 删除文件
              await fs.promises.unlink(targetPath);
              log(logId, "INFO", "文件删除成功", {
                filePath: normalizedPath,
              });
            }
          } else {
            log(logId, "WARN", "要删除的文件或目录不存在", {
              filePath: normalizedPath,
            });
          }
          break;
        }

        case "rename": {
          // 重命名文件或目录
          const renameFrom = fileOp.renameFrom;
          if (!renameFrom || typeof renameFrom !== "string") {
            log(logId, "WARN", "重命名操作缺少 renameFrom", {
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
            log(logId, "WARN", "源路径不安全，跳过重命名", {
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
            log(logId, "INFO", isDirectory ? "目录重命名成功" : "文件重命名成功", {
              sourcePath: normalizedFrom,
              targetPath: normalizedPath,
            });
          } else {
            log(logId, "WARN", "要重命名的文件或目录不存在", {
              sourcePath: normalizedFrom,
            });
          }
          break;
        }

        case "modify": {
          // 修改文件：直接写入新内容
          if (!fs.existsSync(targetPath)) {
            log(logId, "WARN", "要修改的文件不存在", {
              filePath: normalizedPath,
            });
            break;
          }

          // 如果是目录，跳过修改
          const modifyStat = await fs.promises.stat(targetPath);
          if (modifyStat.isDirectory()) {
            log(logId, "INFO", "目标是目录，跳过修改", {
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
            log(logId, "INFO", "文件内容无变化，跳过写入", {
              filePath: normalizedPath,
            });
            break;
          }

          // 写入修改后的内容
          await fs.promises.writeFile(targetPath, newContentStr, "utf8");
          log(logId, "INFO", "文件修改成功", {
            filePath: normalizedPath,
          });
          break;
        }

        default: {
          log(logId, "WARN", "不支持的操作类型", {
            operation,
            filePath: normalizedPath,
          });
          break;
        }
      }
    }

    log(logId, "INFO", "用户文件更新成功", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filesCount: files.length,
    });

    return {
      success: true,
      message: "用户文件更新成功",
      userId: normalizedUserId,
      cId: normalizedCId,
      filesCount: files.length,
    };
  } catch (error) {
    log(logId, "ERROR", "用户文件更新失败", {
      userId: normalizedUserId,
      cId: normalizedCId,
      error: error.message,
    });

    throw new SystemError(`用户文件更新失败: ${error.message}`, {
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
async function uploadFile(userId, cId, file, filePath) {
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!file) {
    throw new ValidationError("文件不能为空", { field: "file" });
  }
  if (!filePath || typeof filePath !== "string") {
    throw new ValidationError("文件路径不能为空", { field: "filePath" });
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const targetDir = path.join(workspaceRoot, normalizedUserId, normalizedCId);

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
    throw new ValidationError("文件路径不安全，不能超出用户目录", {
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
      throw new ValidationError("文件内容格式不正确", {
        field: "file",
        hasBuffer: !!file.buffer,
        hasContents: typeof file.contents,
      });
    }

    log(logId, "INFO", "文件上传成功", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filePath: normalizedPath,
      targetPath: resolvedTargetPath,
      fileSize: file.buffer
        ? file.buffer.length
        : file.contents
        ? file.contents.length
        : 0,
    });

    return {
      success: true,
      message: "文件上传成功",
      fileSize: file.buffer
        ? file.buffer.length
        : file.contents
        ? file.contents.length
        : 0,
    };
  } catch (error) {
    log(logId, "ERROR", "文件上传失败", {
      userId: normalizedUserId,
      cId: normalizedCId,
      filePath: normalizedPath,
      error: error.message,
    });

    throw new SystemError(`文件上传失败: ${error.message}`, {
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
async function uploadFiles(userId, cId, files, filePaths) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files 必须是数组", { field: "files" });
  }
  if (!Array.isArray(filePaths)) {
    throw new ValidationError("filePaths 必须是数组", { field: "filePaths" });
  }
  if (files.length !== filePaths.length) {
    throw new ValidationError(
      `文件数量 (${files.length}) 与路径数量 (${filePaths.length}) 不匹配`,
      { field: "filePaths" }
    );
  }

  log(logId, "INFO", "开始批量上传文件", {
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
        log(logId, "WARN", "批量上传中遇到空文件对象，跳过", {
          index: i,
          filePath,
        });
        results.push({
          success: false,
          filePath,
          error: "文件对象为空",
        });
        continue;
      }

      if (!filePath || typeof filePath !== "string") {
        log(logId, "WARN", "批量上传中文件路径无效，跳过", {
          index: i,
          originalname: file.originalname,
        });
        results.push({
          success: false,
          filePath: filePath || "",
          originalname: file.originalname,
          error: "文件路径无效",
        });
        continue;
      }

      try {
        const result = await uploadFile(userId, cId, file, filePath);
        results.push({
          success: true,
          filePath,
          originalname: file.originalname,
          ...result,
        });
      } catch (error) {
        log(logId, "ERROR", "批量上传中单个文件上传失败", {
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

    log(logId, "INFO", "批量上传文件完成", {
      userId,
      cId,
      totalCount: files.length,
      successCount,
      failCount,
    });

    return {
      success: true,
      message: "批量上传完成",
      totalCount: files.length,
      successCount,
      failCount,
      results,
    };
  } catch (error) {
    log(logId, "ERROR", "批量上传文件失败", {
      userId,
      cId,
      error: error.message,
    });

    throw new SystemError(`批量上传文件失败: ${error.message}`, {
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
async function downloadAllFiles(userId, cId) {
  const logId = `computer:${userId}:${cId}`;
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!workspaceRoot) {
    throw new SystemError("COMPUTER_WORKSPACE_DIR 未配置，无法创建压缩包");
  }

  const normalizedUserId = String(userId);
  const normalizedCId = String(cId);
  const targetDir = path.join(workspaceRoot, normalizedUserId, normalizedCId);

  if (!fs.existsSync(targetDir)) {
    // 目录不存在时，返回一个仅包含顶层目录的空压缩包
    const zipFileName = `${normalizedUserId}_${normalizedCId}.zip`;

    log(logId, "WARN", "工作目录不存在，返回空压缩包", {
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
        log(logId, "WARN", "创建空压缩包时遇到文件问题", {
          message: err.message,
          code: err.code,
        });
      } else {
        log(logId, "ERROR", "创建空压缩包时发生警告", {
          message: err.message,
          code: err.code,
        });
        throw err;
      }
    });

    archive.on("error", (err) => {
      log(logId, "ERROR", "创建空压缩包失败", {
        message: err.message,
      });
    });

    return { archive, zipFileName };
  }

  const zipFileName = `${normalizedUserId}_${normalizedCId}.zip`;

  log(logId, "INFO", "开始创建工作目录压缩包", {
    targetDir,
    zipFileName,
  });

  const archive = archiver("zip", {
    zlib: { level: 9 },
  });

  // 获取排除配置
  const excludeFiles = config.CONTENT_TRAVERSE_EXCLUDE_FILES || [];
  const excludeDirs = config.TRAVERSE_EXCLUDE_DIRS || [];

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
        log(logId, "WARN", "检测链接文件时出错，跳过该文件", {
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
      log(logId, "WARN", "创建压缩包时遇到文件问题", {
        message: err.message,
        code: err.code,
      });
    } else {
      log(logId, "ERROR", "创建压缩包时发生警告", {
        message: err.message,
        code: err.code,
      });
      throw err;
    }
  });

  archive.on("error", (err) => {
    log(logId, "ERROR", "创建压缩包失败", {
      message: err.message,
    });
  });

  return { archive, zipFileName };
}

export { getFileList, updateFiles, uploadFile, uploadFiles, downloadAllFiles };
