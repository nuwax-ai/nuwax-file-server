import fs from "fs";
import path from "path";
import yauzl from "yauzl";
import { FileError } from "../error/errorHandler.js";

/**
 * 解压zip文件到指定目录
 * @param {string} zipPath - zip文件路径
 * @param {string} extractPath - 解压目标路径
 * @returns {Promise<void>}
 */
function extractZip(zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        return reject(
          new FileError(`无法打开压缩包: ${err.message}`, {
            zipPath,
            originalError: err.message,
          })
        );
      }

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // 目录条目
          const dirPath = path.join(extractPath, entry.fileName);
          try {
            fs.mkdirSync(dirPath, { recursive: true });
          } catch (mkdirErr) {
            // 线上实测：某些 zip 中会出现「文件路径和目录路径冲突」或其他奇怪目录结构，
            // 在深层路径上 mkdir 时可能抛出 ENOTDIR / EEXIST / 其它错误。
            // 这类错误通常不影响我们真正关心的业务文件（如 skills 下的代码），
            // 如果直接 reject，会导致整个工作空间创建失败（500）。
            //
            // 为了提升健壮性，这里统一降级为「跳过当前目录条目并继续后续解压」，同时输出 warning 方便排查。
            console.warn(
              "[extractZip] mkdir for directory entry failed, skip this dir",
              {
                dirPath,
                code: mkdirErr.code,
                message: mkdirErr.message,
              }
            );
            zipfile.readEntry();
            return;
          }
          zipfile.readEntry();
        } else {
          // 文件条目
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              return reject(
                new FileError(`读取压缩包条目失败: ${err.message}`, {
                  entry: entry.fileName,
                  originalError: err.message,
                })
              );
            }

            const filePath = path.join(extractPath, entry.fileName);
            const dirPath = path.dirname(filePath);

            try {
              // 确保目录存在
              fs.mkdirSync(dirPath, { recursive: true });
            } catch (mkdirErr) {
              // 同样存在文件/目录冲突或异常目录结构的情况。
              // 为了避免单个异常条目导致整个解压失败，这里统一跳过该文件条目，仅记录 warning 日志。
              console.warn(
                "[extractZip] mkdir for file entry failed, skip this file",
                {
                  dirPath,
                  filePath,
                  code: mkdirErr.code,
                  message: mkdirErr.message,
                }
              );
              zipfile.readEntry();
              return;
            }

            // 如果目标路径已经存在且是目录，说明 zip 里这个条目与现有目录冲突
            // 为了避免 EISDIR 错误，这里直接跳过该条目，并继续解压后续内容
            try {
              if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
                zipfile.readEntry();
                return;
              }
            } catch (statErr) {
              return reject(
                new FileError(`检查文件状态失败: ${statErr.message}`, {
                  filePath,
                  originalError: statErr.message,
                })
              );
            }

            const writeStream = fs.createWriteStream(filePath);
            readStream.pipe(writeStream);

            writeStream.on("close", () => {
              zipfile.readEntry();
            });

            writeStream.on("error", (err) => {
              reject(
                new FileError(`写入文件失败: ${err.message}`, {
                  filePath,
                  originalError: err.message,
                })
              );
            });
          });
        }
      });

      zipfile.on("end", () => {
        resolve();
      });

      zipfile.on("error", (err) => {
        reject(
          new FileError(`解压过程中发生错误: ${err.message}`, {
            zipPath,
            originalError: err.message,
          })
        );
      });
    });
  });
}

// 缓存zip文件的目录索引，避免重复遍历
// 键格式: zipPath:mtime:size，值: Map<normalizedPath, entry>
const zipIndexCache = new Map();
const MAX_CACHE_SIZE = 50;

/**
 * 获取zip文件的目录索引（缓存）
 * @param {string} zipPath - zip文件路径
 * @returns {Promise<Map<string, yauzl.Entry>|null>} 返回文件名到Entry的映射，失败返回null
 */
function getZipIndex(zipPath) {
  return new Promise((resolve) => {
    try {
      // 检查缓存
      const stats = fs.statSync(zipPath);
      const cacheKey = `${zipPath}:${stats.mtimeMs}:${stats.size}`;
      if (zipIndexCache.has(cacheKey)) {
        return resolve(zipIndexCache.get(cacheKey));
      }

      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          return resolve(null);
        }

        const index = new Map();
        zipfile.readEntry();
        
        zipfile.on("entry", (entry) => {
          // 标准化路径并存储
          const normalizedPath = entry.fileName.replace(/\\/g, "/");
          if (!/\/$/.test(entry.fileName)) {
            // 只索引文件，不索引目录
            index.set(normalizedPath, entry);
          }
          zipfile.readEntry();
        });

        zipfile.on("end", () => {
          zipfile.close();
          // 缓存索引（限制缓存大小，避免内存泄漏）
          if (zipIndexCache.size >= MAX_CACHE_SIZE) {
            // 删除最旧的缓存项（简单策略：清空一半）
            const keysToDelete = Array.from(zipIndexCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE / 2));
            keysToDelete.forEach(key => zipIndexCache.delete(key));
          }
          zipIndexCache.set(cacheKey, index);
          resolve(index);
        });

        zipfile.on("error", () => {
          zipfile.close();
          resolve(null);
        });
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 从zip文件中提取单个文件（优化版：使用索引快速定位）
 * @param {string} zipPath - zip文件路径
 * @param {string} filePathInZip - 文件在zip中的路径（相对路径）
 * @param {string} targetPath - 提取到的目标路径
 * @returns {Promise<boolean>} 如果文件存在并成功提取返回true，否则返回false
 */
function extractSingleFileFromZip(zipPath, filePathInZip, targetPath) {
  return new Promise(async (resolve) => {
    try {
      // 先获取索引，快速定位文件
      const index = await getZipIndex(zipPath);
      if (!index) {
        return resolve(false);
      }

      const normalizedPathInZip = filePathInZip.replace(/^[\/\\]+/, "").replace(/\\/g, "/");
      
      if (!index.has(normalizedPathInZip)) {
        // 文件不在索引中，直接返回false，避免打开zip文件
        return resolve(false);
      }

      // 文件存在，使用 lazyEntries: false 一次性加载所有条目，然后直接定位
      yauzl.open(zipPath, { lazyEntries: false }, (err, zipfile) => {
        if (err) {
          return resolve(false);
        }

        // 在所有条目中查找目标文件（使用索引已确认存在，这里只是获取entry对象）
        let targetEntry = null;
        for (const entry of zipfile.entries) {
          const entryPath = entry.fileName.replace(/\\/g, "/");
          if (entryPath === normalizedPathInZip && !/\/$/.test(entry.fileName)) {
            targetEntry = entry;
            break;
          }
        }

        if (!targetEntry) {
          zipfile.close();
          return resolve(false);
        }

        // 直接打开目标文件的流
        zipfile.openReadStream(targetEntry, (err, readStream) => {
          if (err || !readStream) {
            zipfile.close();
            return resolve(false);
          }

          const dirPath = path.dirname(targetPath);
          try {
            fs.mkdirSync(dirPath, { recursive: true });
          } catch (mkdirErr) {
            zipfile.close();
            return resolve(false);
          }

          const writeStream = fs.createWriteStream(targetPath);
          readStream.pipe(writeStream);

          writeStream.on("close", () => {
            zipfile.close();
            resolve(true);
          });

          writeStream.on("error", () => {
            zipfile.close();
            resolve(false);
          });
        });
      });
    } catch (e) {
      resolve(false);
    }
  });
}

export { extractZip, extractSingleFileFromZip };

