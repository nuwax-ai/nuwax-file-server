import path from "path";
import fs from "fs";
import config from "../appConfig/index.js";
import { restartDevServer } from "../utils/build/restartDevUtils.js";
import { log } from "../utils/log/logUtils.js";
import {
  ValidationError,
  SystemError,
  ResourceError,
  FileError,
} from "../utils/error/errorHandler.js";
import { sanitizeSensitivePaths } from "../utils/common/sensitiveUtils.js";
import {
  backupProjectToZip,
  restoreProjectFromZip,
  pruneMissingFiles,
  removeEmptyDirectories,
} from "../utils/project/backupUtils.js";
import { extractSingleFileFromZip } from "../utils/common/zipUtils.js";
import {
  shouldRestartForSingleFile,
  shouldRestartDevServer,
} from "../utils/buildJudge/restartJudgeUtils.js";

/**
 * 按行对比旧内容与新内容，返回合并后的内容和变更行数
 * - 行内容不同视为修改
 * - 旧文件多出的行视为删除
 * - 新文件多出的行视为新增
 * - 保持原文件换行符风格（\n 或 \r\n）
 */
function diffContentByLines(existingContent, newContentStr) {
  const oldLines = existingContent.split(/\r?\n/);
  const newLines = newContentStr.split(/\r?\n/);

  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const minLen = Math.min(oldLen, newLen);

  let changesCount = 0;

  // 1) 对齐范围内的行：不同则视为修改
  for (let idx = 0; idx < minLen; idx++) {
    if (oldLines[idx] !== newLines[idx]) {
      oldLines[idx] = newLines[idx];
      changesCount++;
    }
  }

  // 2) old 比 new 长的部分：多出来的行视为删除，从后往前删
  if (oldLen > newLen) {
    for (let idx = oldLen - 1; idx >= newLen; idx--) {
      oldLines.splice(idx, 1);
      changesCount++;
    }
  }

  // 3) new 比 old 长的部分：多出来的行视为新增，按顺序追加
  if (newLen > oldLen) {
    for (let idx = oldLen; idx < newLen; idx++) {
      oldLines.push(newLines[idx]);
      changesCount++;
    }
  }

  const newline = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const finalContent = oldLines.join(newline);

  return { finalContent, changesCount };
}

/**
 * 直接使用新内容替换旧内容
 * - 若内容完全一致，则 changesCount 为 0
 * - 预留备用：当前未在业务中使用
 */
function replaceContentDirectly(existingContent, newContentStr) {
  if (existingContent === newContentStr) {
    return { finalContent: existingContent, changesCount: 0 };
  }
  return { finalContent: newContentStr, changesCount: -1 };
}

/**
 * 部分文件更新：支持新增、删除、重命名、修改操作
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 代码版本号
 * @param {Array} files 文件操作列表
 * @param {Object} req 请求对象
 * @returns {Object} 更新结果
 */
async function specifiedFilesUpdate(projectId, codeVersion, files, req) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion不能为空", {
      field: "codeVersion",
    });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files必须是数组", { field: "files" });
  }

  // 验证文件操作结构
  for (let i = 0; i < files.length; i++) {
    const fileOp = files[i];
    if (!fileOp || typeof fileOp.operation !== "string") {
      throw new ValidationError(`files[${i}].operation 不能为空`, {
        field: `files[${i}].operation`,
      });
    }
    // 使用 name 作为文件路径字段
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

    if (operation === "modify") {
      if (typeof fileOp.contents !== "string") {
        throw new ValidationError(
          `files[${i}].contents 必须是字符串（修改操作需要）`,
          { field: `files[${i}].contents` }
        );
      }
    }
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    log(projectId, "ERROR", "项目不存在", { projectId, projectPath });
    throw new ResourceError("项目不存在", { projectId });
  }

  let backupZipPath = "";
  try {
    // 1) 备份
    const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const zipName = `${projectId}-v${versionNum}.zip`;
    backupZipPath = path.join(backupDir, zipName);
    log(projectId, "DEBUG", "开始备份项目", { projectId, backupZipPath });
    await backupProjectToZip(projectId, projectPath, backupZipPath);
    log(projectId, "INFO", "项目已备份", {
      projectId,
      zipPath: backupZipPath,
    });

    // 2) 处理文件操作
    try {
      log(projectId, "DEBUG", "开始处理文件操作", { projectId, filesCount: files.length });
      for (const fileOp of files) {
        const operation = fileOp.operation.toLowerCase();
        // 使用 name 作为文件路径
        const fileName = fileOp.name;

        const normalizedPath = path.normalize(fileName).replace(/^[\/\\]+/, "");
        const targetPath = path.join(projectPath, normalizedPath);

        // 安全检查：确保目标路径在项目目录内
        const resolvedTargetPath = path.resolve(targetPath);
        const resolvedProjectPath = path.resolve(projectPath);
        if (!resolvedTargetPath.startsWith(resolvedProjectPath + path.sep) &&
            resolvedTargetPath !== resolvedProjectPath) {
          log(projectId, "WARN", "文件路径不安全，跳过", {
            filePath: normalizedPath,
            resolvedPath: resolvedTargetPath,
          });
          continue;
        }

        switch (operation) {
          case "create": {
            // 创建新文件
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            const contents = fileOp.contents || "";
            await fs.promises.writeFile(targetPath, contents, "utf8");
            log(projectId, "INFO", "文件创建成功", {
              filePath: normalizedPath,
            });
            break;
          }

          case "delete": {
            // 删除文件
            if (fs.existsSync(targetPath)) {
              await fs.promises.unlink(targetPath);
              log(projectId, "INFO", "文件删除成功", {
                filePath: normalizedPath,
              });
            } else {
              log(projectId, "WARN", "要删除的文件不存在", {
                filePath: normalizedPath,
              });
            }
            break;
          }

          case "rename": {
            // 重命名文件
            const renameFrom = fileOp.renameFrom;
            if (!renameFrom || typeof renameFrom !== "string") {
              log(projectId, "WARN", "重命名操作缺少 renameFrom", {
                filePath: normalizedPath,
              });
              break;
            }

            const normalizedFrom = path.normalize(renameFrom).replace(/^[\/\\]+/, "");
            const oldPath = path.join(projectPath, normalizedFrom);
            const resolvedOldPath = path.resolve(oldPath);

            // 安全检查
            if (!resolvedOldPath.startsWith(resolvedProjectPath + path.sep) &&
                resolvedOldPath !== resolvedProjectPath) {
              log(projectId, "WARN", "重命名源路径不安全，跳过", {
                renameFrom: normalizedFrom,
                resolvedPath: resolvedOldPath,
              });
              break;
            }

            if (fs.existsSync(oldPath)) {
              await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
              await fs.promises.rename(oldPath, targetPath);
              log(projectId, "INFO", "文件重命名成功", {
                oldPath: normalizedFrom,
                newPath: normalizedPath,
              });
            } else {
              log(projectId, "WARN", "要重命名的文件不存在", {
                renameFrom: normalizedFrom,
              });
            }
            break;
          }

          case "modify": {
            // 修改文件：前端传入完整 contents，这里根据新旧内容按行生成增删改
            if (!fs.existsSync(targetPath)) {
              log(projectId, "WARN", "要修改的文件不存在", {
                filePath: normalizedPath,
              });
              break;
            }

            // 读取现有文件内容
            const existingContent = await fs.promises.readFile(
              targetPath,
              "utf8"
            );
            const newContentStr =
              typeof fileOp.contents === "string" ? fileOp.contents : "";

            // 使用按行 diff 的方式生成最终内容
            const { finalContent, changesCount } = diffContentByLines(
              existingContent,
              newContentStr
            );

            // 1) 若内容完全一致，不覆写文件，避免触发 HMR
            if (changesCount === 0) {
              log(projectId, "INFO", "文件内容无变化，跳过写入", {
                filePath: normalizedPath,
              });
              break;
            }

            // 2) 写入修改后的内容
            await fs.promises.writeFile(targetPath, finalContent, "utf8");
            log(projectId, "INFO", "文件修改成功", {
              filePath: normalizedPath,
              changesCount,
            });
            break;
          }

          default: {
            log(projectId, "WARN", "不支持的操作类型", {
              operation,
              filePath: normalizedPath,
            });
            break;
          }
        }
      }

      // 3) 清理空目录
      log(projectId, "DEBUG", "开始清理空目录", { projectId });
      try {
        await removeEmptyDirectories(
          projectPath,
          config.TRAVERSE_EXCLUDE_DIRS || []
        );
      } catch (e) {
        log(projectId, "WARN", "清理空目录失败", {
          projectId,
          error: e && e.message,
        });
      }

      log(projectId, "INFO", "部分文件更新成功", {
        projectId,
        filesCount: files.length,
        elapsedMs: Date.now() - startTime,
      });

      return {
        success: true,
        message: "部分文件更新成功",
        projectId,
        filesCount: files.length,
      };
    } catch (e) {
      log(projectId, "ERROR", "处理文件操作失败", {
        projectId,
        error: e && e.message,
        elapsedMs: Date.now() - startTime,
      });
      throw e;
    }
  } catch (backupErr) {
    // 备份阶段失败：不执行回滚（无备份可回滚），直接抛出
    if (!backupErr.isOperational) {
      throw new SystemError("备份项目失败", {
        projectId,
        originalError: backupErr && backupErr.message,
      });
    }
    throw backupErr;
  }
}

async function allFilesUpdate(projectId, codeVersion, files, req) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }
  if (!Array.isArray(files)) {
    throw new ValidationError("files必须是数组", { field: "files" });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    log(projectId, "ERROR", "项目不存在", { projectId, projectPath });
    throw new ResourceError("项目不存在", { projectId });
  }

  let backupZipPath = "";
  try {
    // 1) 备份
    const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const zipName = `${projectId}-v${versionNum}.zip`;
    backupZipPath = path.join(backupDir, zipName);
    log(projectId, "DEBUG", "开始备份项目", { projectId, backupZipPath });
    await backupProjectToZip(projectId, projectPath, backupZipPath);

    // 2) 写入文件
    try {
      log(projectId, "DEBUG", "开始写入文件", { projectId, filesCount: files.length });
      for (const file of files) {
        if (!file || typeof file.name !== "string") continue;
        const targetPath = path.join(projectPath, file.name);

        // 处理文件重命名：如果存在 renameFrom，需要先重命名原文件
        if (file.renameFrom && typeof file.renameFrom === "string") {
          const oldPath = path.join(projectPath, file.renameFrom);
          if (fs.existsSync(oldPath)) {
            // 确保目标目录存在（跨目录重命名时需要）
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.rename(oldPath, targetPath);
            log(projectId, "INFO", "文件重命名成功", {
              projectId,
              oldPath: file.renameFrom,
              newPath: file.name,
            });
            continue; // 重命名后跳过后续的写入操作
          }
        }

        const isBinary = file.binary === true;
        const isText = file.binary === false;
        const sizeExceeded = !!file.sizeExceeded;
        const hasContents =
          typeof file.contents === "string" && file.contents.length > 0;
        
        // 处理二进制文件：如果已经存在就不写入，不存在才需要根据hasContents写入
        if (isBinary) {
          // 如果文件已存在，跳过写入
          if (fs.existsSync(targetPath)) {
            log(projectId, "INFO", "二进制文件已存在，跳过写入", {
              filePath: file.name,
            });
            continue;
          }
          
          // 文件不存在，且 hasContents 为 true，才写入
          if (hasContents) {
            // 二进制文件有 base64 编码的内容，需要解码为 Buffer 并写入
            try {
              await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
              const buffer = Buffer.from(file.contents, "base64");
              await fs.promises.writeFile(targetPath, buffer);
              log(projectId, "INFO", "二进制文件写入成功", {
                filePath: file.name,
              });
            } catch (e) {
              log(projectId, "ERROR", "二进制文件写入失败", {
                filePath: file.name,
                error: e && e.message,
              });
            }
          } else {
            // 二进制文件没有内容（可能是大文件），且文件不存在
            log(projectId, "WARN", "二进制文件不存在且无内容，跳过", {
              filePath: file.name,
            });
          }
          continue;
        }
        
        // 处理文本文件
        const shouldReplace =
          isText && (!sizeExceeded || (sizeExceeded && hasContents));
        if (!shouldReplace) {
          continue;
        }
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, file.contents || "", "utf8");
      }
    } catch (e) {
      log(projectId, "ERROR", "写入文件失败", {
        projectId,
        error: e && e.message,
        elapsedMs: Date.now() - startTime,
      });
      throw e;
    }

    // 3) 清理缺失文件与空目录
    try {
      log(projectId, "DEBUG", "开始清理缺失文件与空目录", { projectId });
      const keepSet = new Set(
        files
          .filter((f) => f && typeof f.name === "string")
          .map((f) => path.normalize(f.name))
      );
      await pruneMissingFiles(
        projectPath,
        keepSet,
        config.TRAVERSE_EXCLUDE_DIRS || []
      );
      await removeEmptyDirectories(
        projectPath,
        config.TRAVERSE_EXCLUDE_DIRS || []
      );
    } catch (e) {
      log(projectId, "ERROR", "清理缺失文件失败，开始回滚", {
        projectId,
        error: e && e.message,
        elapsedMs: Date.now() - startTime,
      });
      throw e;
    }

    log(projectId, "INFO", "文件提交成功", {
      projectId,
      filesCount: files.length,
      elapsedMs: Date.now() - startTime,
    });
    return {
      success: true,
      message: "文件提交成功",
      projectId,
      restarted: false,
    };

  } catch (backupErr) {
    // 备份阶段失败：不执行回滚（无备份可回滚），直接抛出
    if (!backupErr.isOperational) {
      throw new SystemError("备份旧版本失败", {
        projectId,
        originalError: backupErr && backupErr.message,
      });
    }
    throw backupErr;
  }
}

/**
 * 上传单个文件到指定路径
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 代码版本号
 * @param {Object} file 文件对象 (包含文件内容和元数据)
 * @param {string} filePath 文件在项目中的相对路径
 * @param {Object} req 请求对象
 * @returns {Object} 上传结果
 */
async function uploadSingleFile(projectId, codeVersion, file, filePath, req) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }
  if (!file) {
    throw new ValidationError("文件不能为空", { field: "file" });
  }
  if (!filePath || typeof filePath !== "string") {
    throw new ValidationError("文件路径不能为空", { field: "filePath" });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    log(projectId, "ERROR", "项目不存在", { projectId, projectPath });
    throw new ResourceError("项目不存在", { projectId });
  }

  // 规范化文件路径，确保是相对路径
  const normalizedPath = path.normalize(filePath).replace(/^[\/\\]+/, "");
  const targetPath = path.join(projectPath, normalizedPath);

  // 安全检查：确保目标路径在项目目录内
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedProjectPath = path.resolve(projectPath);
  if (!resolvedTargetPath.startsWith(resolvedProjectPath)) {
    throw new ValidationError("文件路径不安全，不能超出项目目录", {
      field: "filePath",
      providedPath: filePath,
      resolvedPath: resolvedTargetPath,
    });
  }

  let backupZipPath = "";
  try {
    // 1) 备份
    const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const zipName = `${projectId}-v${versionNum}.zip`;
    backupZipPath = path.join(backupDir, zipName);
    log(projectId, "DEBUG", "开始备份项目", { projectId, backupZipPath });
    await backupProjectToZip(projectId, projectPath, backupZipPath);
    log(projectId, "INFO", `项目已备份: ${backupZipPath}`, {
      projectId,
      zipPath: backupZipPath,
    });

    // 2) 写入文件
    try {
      // 确保目标目录存在
      log(projectId, "DEBUG", "开始写入上传文件", { projectId, filePath: normalizedPath });
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

      // 写入文件内容，统一使用buffer（multer memoryStorage对所有文件类型都提供buffer）
      if (!file.buffer) {
        throw new ValidationError("文件内容格式不正确，缺少buffer", {
          field: "file",
        });
      }
      
      // 记录写入前的文件信息，用于调试
      log(projectId, "INFO", "准备写入文件", {
        targetPath,
        bufferLength: file.buffer.length,
        expectedSize: file.size,
        bufferIsBuffer: Buffer.isBuffer(file.buffer),
        sizeMatch: file.buffer.length === file.size,
      });
      
      // 直接写入Buffer，Node.js会自动以二进制模式写入
      await fs.promises.writeFile(targetPath, file.buffer);

      log(projectId, "INFO", "文件上传成功", {
        projectId,
        filePath: normalizedPath,
        targetPath: resolvedTargetPath,
        fileSize: file.buffer ? file.buffer.length : 0,
        elapsedMs: Date.now() - startTime,
      });

      // 判断是否需要重启开发服务器
      // const needRestart = shouldRestartForSingleFile(path.basename(normalizedPath));
      const needRestart = false;

      if (needRestart) {
        try {
          const restartResult = await restartDevServer(req, projectId);
          log(projectId, "INFO", "重启开发服务器成功", {
            projectId,
            pid: restartResult.pid,
            port: restartResult.port,
          });
          return {
            success: true,
            message: "文件上传并重启开发服务器成功",
            projectId,
            filePath: normalizedPath,
            targetPath: resolvedTargetPath,
            fileSize: file.buffer ? file.buffer.length : 0,
            pid: restartResult.pid,
            port: restartResult.port,
            restarted: true,
          };
        } catch (e) {
          log(projectId, "ERROR", "重启开发服务器失败", {
            projectId,
            filePath: normalizedPath,
            error: e && e.message,
          });
        }
      } else {
        log(projectId, "INFO", "文件修改不需要重启开发服务器", {
          projectId,
          filePath: normalizedPath,
        });
        return {
          success: true,
          message: "文件上传成功，无需重启开发服务器",
          projectId,
          restarted: false,
        };
      }
    } catch (e) {
      log(projectId, "ERROR", "写入文件失败", {
        projectId,
        filePath: normalizedPath,
        error: e && e.message,
        elapsedMs: Date.now() - startTime,
      });
      throw e;
    }
  } catch (backupErr) {
    // 备份阶段失败：不执行回滚（无备份可回滚），直接抛出
    if (!backupErr.isOperational) {
      throw new SystemError("备份项目失败", {
        projectId,
        filePath: normalizedPath,
        originalError: backupErr && backupErr.message,
      });
    }
    throw backupErr;
  }
}

/**
 * 回滚项目到指定版本
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 当前代码版本号
 * @param {string} rollbackTo 要回滚到的版本号
 * @param {Object} req 请求对象
 * @returns {Object} 回滚结果
 */
async function rollbackVersion(projectId, codeVersion, rollbackTo, req) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }
  const rollbackToNum = Number(rollbackTo);
  if (!Number.isFinite(rollbackToNum)) {
    throw new ValidationError("rollbackTo必须是数字", {
      field: "rollbackTo",
    });
  }
  if (rollbackToNum < 0) {
    throw new ValidationError("rollbackTo不能小于0", {
      field: "rollbackTo",
    });
  }
  if (rollbackToNum >= versionNum) {
    throw new ValidationError("rollbackTo必须小于当前codeVersion", {
      field: "rollbackTo",
    });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    log(projectId, "ERROR", "项目不存在", { projectId, projectPath });
    throw new ResourceError("项目不存在", { projectId });
  }

  // 检查要回滚到的版本的备份文件是否存在
  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  const rollbackZipName = `${projectId}-v${rollbackToNum}.zip`;
  const rollbackZipPath = path.join(backupDir, rollbackZipName);
  
  if (!fs.existsSync(rollbackZipPath)) {
    log(projectId, "ERROR", "回滚版本备份文件不存在", {
      projectId,
      rollbackTo: rollbackToNum,
      zipPath: rollbackZipPath,
    });
    throw new ResourceError("回滚版本备份文件不存在", {
      projectId,
      rollbackTo: rollbackToNum,
    });
  }

  let currentBackupZipPath = "";
  try {
    // 1) 备份当前版本
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const currentZipName = `${projectId}-v${versionNum}.zip`;
    currentBackupZipPath = path.join(backupDir, currentZipName);
    
    // 如果当前版本的备份已存在，跳过备份（避免覆盖）
    if (!fs.existsSync(currentBackupZipPath)) {
      await backupProjectToZip(projectId, projectPath, currentBackupZipPath);
      log(projectId, "INFO", "当前版本已备份", {
        projectId,
        zipPath: currentBackupZipPath,
      });
    } else {
      log(projectId, "INFO", "当前版本备份已存在，跳过备份", {
        projectId,
        zipPath: currentBackupZipPath,
      });
    }

    // 2) 从指定版本恢复项目
    log(projectId, "DEBUG", "开始从备份恢复项目", { projectId, rollbackToNum, rollbackZipPath });
    await restoreProjectFromZip(projectId, projectPath, rollbackZipPath);
    log(projectId, "INFO", "项目回滚成功", {
      projectId,
      newVersion: versionNum,
      toVersion: rollbackToNum,
      rollbackZipPath,
      elapsedMs: Date.now() - startTime,
    });

    return {
      success: true,
      message: "项目回滚成功",
      newVersion: versionNum,
      rollbackTo: rollbackToNum,
    };
  } catch (restoreErr) {
    log(projectId, "ERROR", "回滚项目失败", {
      projectId,
      rollbackTo: rollbackToNum,
      error: restoreErr && restoreErr.message,
      elapsedMs: Date.now() - startTime,
    });
    
    // 如果恢复失败，尝试从当前版本备份恢复（如果存在）
    if (currentBackupZipPath && fs.existsSync(currentBackupZipPath)) {
      try {
        log(projectId, "INFO", "回滚失败，尝试恢复当前版本", {
          projectId,
          backupPath: currentBackupZipPath,
        });
        await restoreProjectFromZip(projectId, projectPath, currentBackupZipPath);
        log(projectId, "INFO", "已恢复当前版本", {
          projectId,
        });
      } catch (recoveryErr) {
        log(projectId, "ERROR", "恢复当前版本失败", {
          projectId,
          error: recoveryErr && recoveryErr.message,
        });
      }
    }
    
    if (!restoreErr.isOperational) {
      throw new SystemError("回滚项目失败", {
        projectId,
        rollbackTo: rollbackToNum,
        originalError: restoreErr && restoreErr.message,
      });
    }
    throw restoreErr;
  }
}

export { specifiedFilesUpdate, allFilesUpdate, uploadSingleFile, rollbackVersion };
export default {
  specifiedFilesUpdate,
  allFilesUpdate,
  uploadSingleFile,
  rollbackVersion,
};
