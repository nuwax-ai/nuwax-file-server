import fs from "fs";
import path from "path";
import archiver from "archiver";
import yauzl from "yauzl";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { FileError } from "../error/errorHandler.js";
import { sanitizeSensitivePaths } from "../common/sensitiveUtils.js";

/**
 * 按排除规则将目录复制到目标目录
 * @param {string} srcDir 源目录
 * @param {string} destDir 目标目录
 */
async function copyDirectoryFiltered(srcDir, destDir) {
  const excludeDirNames = new Set(config.TRAVERSE_EXCLUDE_DIRS || []);
  const excludeFileNames = new Set(config.BACKUP_TRAVERSE_EXCLUDE_FILES || []);
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirNames.has(entry.name)) {
        continue;
      }
      await fs.promises.mkdir(destPath, { recursive: true });
      await copyDirectoryFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      if (excludeFileNames.has(entry.name)) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

/**
 * 将项目目录备份为zip文件（按配置排除目录）
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目源路径
 * @param {string} outZipPath 输出zip文件路径
 * @returns {Promise<string>} 生成的zip文件路径
 */
async function backupProjectToZip(projectId, projectPath, outZipPath) {
  const startTime = Date.now();
  const tempBase = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  if (!fs.existsSync(tempBase)) {
    fs.mkdirSync(tempBase, { recursive: true });
  }
  const tempDir = path.join(tempBase, `backup_temp_${Date.now()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    log(projectId, "DEBUG", "开始复制项目文件到临时目录", { projectPath, tempDir });
    await copyDirectoryFiltered(projectPath, tempDir);
    log(projectId, "DEBUG", "项目文件复制完成，开始压缩", { tempDir, outZipPath });

    // 使用 archiver 进行压缩，避免依赖系统 zip
    await fs.promises.mkdir(path.dirname(outZipPath), { recursive: true });
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outZipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => resolve());
      output.on("error", (err) =>
        reject(
          new FileError("备份zip压缩失败", {
            projectId,
            projectPath,
            outZipPath,
            originalError: err && err.message,
          })
        )
      );

      archive.on("warning", (err) => {
        if (err && err.code === "ENOENT") {
          // 记录告警但不失败
          log(projectId, "WARN", `压缩告警: ${err.message}`, {
            projectId,
            outZipPath,
          });
        } else if (err) {
          reject(
            new FileError("备份zip压缩失败", {
              projectId,
              projectPath,
              outZipPath,
              originalError: err && err.message,
            })
          );
        }
      });

      archive.on("error", (err) =>
        reject(
          new FileError("备份zip压缩失败", {
            projectId,
            projectPath,
            outZipPath,
            originalError: err && err.message,
          })
        )
      );

      archive.pipe(output);
      archive.directory(tempDir + "/", false);
      archive.finalize();
    });

    log(projectId, "INFO", `项目已备份: ${outZipPath}`, {
      projectId,
      outZipPath,
      elapsedMs: Date.now() - startTime,
    });

    return outZipPath;
  } finally {
    // 清理临时目录
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * 从zip备份回滚项目目录
 * 策略：
 * - 清空现有项目目录（保留根目录本身和被排除的目录/文件）
 * - 将zip内容解压回项目目录
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {string} zipPath zip备份文件路径
 */
async function restoreProjectFromZip(projectId, projectPath, zipPath) {
  const startTime = Date.now();
  // 获取排除列表（与备份时使用的规则一致）
  const excludeDirNames = new Set(config.TRAVERSE_EXCLUDE_DIRS || []);
  const excludeFileNames = new Set(config.BACKUP_TRAVERSE_EXCLUDE_FILES || []);
  
  // 清空目录内容，但保留被排除的目录和文件
  log(projectId, "DEBUG", "开始清空项目目录（保留排除项）", { projectPath });
  const entries = await fs.promises.readdir(projectPath, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const fullPath = path.join(projectPath, entry.name);
    
    // 跳过被排除的目录
    if (entry.isDirectory() && excludeDirNames.has(entry.name)) {
      continue;
    }
    
    // 跳过被排除的文件
    if (entry.isFile() && excludeFileNames.has(entry.name)) {
      continue;
    }
    
    // 删除不在排除列表中的文件和目录
    try {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
    } catch (e) {
      // 忽略个别删除失败，继续
    }
  }

  // 使用 yauzl 解压 zip 到项目目录，避免依赖系统 unzip
  log(projectId, "DEBUG", "开始从 zip 恢复项目文件", { zipPath, projectPath });
  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipFile) => {
      if (openErr || !zipFile) {
        return reject(
          new FileError("回滚解压失败", {
            projectId,
            projectPath,
            zipPath,
            originalError: openErr && openErr.message,
          })
        );
      }

      const resolvedProjectPath = path.resolve(projectPath);

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        // 安全处理路径，防止路径穿越
        const normalized = path
          .normalize(entry.fileName)
          .replace(/^([/\\]+)+/, "");
        const targetPath = path.join(projectPath, normalized);
        const resolvedTargetPath = path.resolve(targetPath);
        if (
          !resolvedTargetPath.startsWith(resolvedProjectPath + path.sep) &&
          resolvedTargetPath !== resolvedProjectPath
        ) {
          zipFile.readEntry();
          return;
        }

        if (/\\$|\/$/.test(entry.fileName) || entry.fileName.endsWith("/")) {
          // 目录条目
          fs.promises
            .mkdir(resolvedTargetPath, { recursive: true })
            .then(() => zipFile.readEntry())
            .catch((e) => {
              zipFile.close();
              reject(
                new FileError("回滚解压失败", {
                  projectId,
                  projectPath,
                  zipPath,
                  originalError:
                    e && e.message
                      ? sanitizeSensitivePaths(e.message)
                      : e && e.message,
                })
              );
            });
          return;
        }

        // 文件条目
        zipFile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            zipFile.close();
            return reject(
              new FileError("回滚解压失败", {
                projectId,
                projectPath,
                zipPath,
                originalError: streamErr && streamErr.message,
              })
            );
          }

          fs.promises
            .mkdir(path.dirname(resolvedTargetPath), { recursive: true })
            .then(() => {
              const writeStream = fs.createWriteStream(resolvedTargetPath);
              readStream.pipe(writeStream);
              writeStream.on("close", () => zipFile.readEntry());
              writeStream.on("error", (e) => {
                zipFile.close();
                reject(
                  new FileError("回滚解压失败", {
                    projectId,
                    projectPath,
                    zipPath,
                    originalError:
                      e && e.message
                        ? sanitizeSensitivePaths(e.message)
                        : e && e.message,
                  })
                );
              });
            })
            .catch((e) => {
              zipFile.close();
              reject(
                new FileError("回滚解压失败", {
                  projectId,
                  projectPath,
                  zipPath,
                  originalError:
                    e && e.message
                      ? sanitizeSensitivePaths(e.message)
                      : e && e.message,
                })
              );
            });
        });
      });

      zipFile.on("end", () => {
        zipFile.close();
        resolve();
      });

      zipFile.on("error", (e) => {
        zipFile.close();
        reject(
          new FileError("回滚解压失败", {
            projectId,
            projectPath,
            zipPath,
            originalError:
              e && e.message
                ? sanitizeSensitivePaths(e.message)
                : e && e.message,
          })
        );
      });
    });
  });

  log(projectId, "INFO", `项目已从备份恢复: ${zipPath}`, {
    projectId,
    projectPath,
    zipPath,
    elapsedMs: Date.now() - startTime,
  });
}

/**
 * 删除缺失的文件
 * @param {string} baseDir 基础目录
 * @param {Set<string>} keepRelativePaths 需要保留的文件路径集合
 * @param {Array<string>} excludeDirNames 需要排除的目录名集合
 */
async function pruneMissingFiles(baseDir, keepRelativePaths, excludeDirNames) {
  const excludeSet = new Set(excludeDirNames || []);
  // 需要保护的文件名（返回内容时排除的文件，例如 AGENT.md/CLAUDE.md），清理缺失文件时也不能删除
  const protectedFileNames = new Set(
    (config.CONTENT_TRAVERSE_EXCLUDE_FILES || []).map((name) => String(name).trim())
  );
  async function walkAndPrune(currentDir) {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        // 跳过配置中的排除目录
        if (excludeSet.has(entry.name)) {
          continue;
        }
        await walkAndPrune(fullPath);
      } else if (entry.isFile()) {
        // 1. 隐藏文件（以 . 开头）不能删除
        if (entry.name.startsWith(".")) {
          continue;
        }
        // 2. 内容排除列表中的文件（如 AGENT.md / CLAUDE.md）不能删除
        if (protectedFileNames.has(entry.name)) {
          continue;
        }
        // 其余文件如果不在本次提交的保留列表中，则删除
        if (!keepRelativePaths.has(relativePath)) {
          try {
            await fs.promises.unlink(fullPath);
          } catch (_) {}
        }
      }
    }
  }
  await walkAndPrune(baseDir);
}

/**
 * 删除空目录
 * @param {string} baseDir 基础目录
 * @param {Array<string>} excludeDirNames 需要排除的目录名集合
 */
async function removeEmptyDirectories(baseDir, excludeDirNames) {
  const excludeSet = new Set(excludeDirNames || []);
  async function postOrderRemove(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeSet.has(entry.name)) {
          continue;
        }
        await postOrderRemove(fullPath);
      }
    }
    // 再次读取，若为空则删除（根目录不删）
    const after = await fs.promises.readdir(dir);
    if (after.length === 0 && path.resolve(dir) !== path.resolve(baseDir)) {
      try {
        await fs.promises.rmdir(dir);
      } catch (_) {}
    }
  }
  await postOrderRemove(baseDir);
}

export {
  copyDirectoryFiltered,
  backupProjectToZip,
  restoreProjectFromZip,
  pruneMissingFiles,
  removeEmptyDirectories,
};

