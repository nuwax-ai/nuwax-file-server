import fs from "fs";
import path from "path";
import { FileError } from "../error/errorHandler.js";

/**
 * 校验 zip 条目路径，防止 Zip Slip（路径穿越）
 * @param {string} extractPath 解压根目录
 * @param {string} entryName zip 内相对路径
 * @returns {string} 安全的绝对目标路径
 */
function assertSafeZipEntryPath(extractPath, entryName) {
  const raw = String(entryName || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new FileError(`Unsafe zip entry path: ${entryName}`, {
      entryName,
    });
  }

  const normalized = raw.replace(/^\/+/, "");

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new FileError(`Unsafe zip entry path: ${entryName}`, {
      entryName,
    });
  }

  const targetPath = path.resolve(extractPath, ...segments);
  const basePath = path.resolve(extractPath);
  if (targetPath !== basePath && !targetPath.startsWith(basePath + path.sep)) {
    throw new FileError(`Unsafe zip entry path: ${entryName}`, {
      entryName,
      targetPath,
      basePath,
    });
  }

  return targetPath;
}

/**
 * 安全移动目录（跨设备时回退为 copy）
 */
async function moveDirectory(srcDir, destDir) {
  try {
    await fs.promises.rename(srcDir, destDir);
  } catch (err) {
    if (err.code === "EXDEV") {
      async function copyRecursive(src, dest) {
        const stat = await fs.promises.lstat(src);
        if (stat.isDirectory()) {
          await fs.promises.mkdir(dest, { recursive: true });
          const items = await fs.promises.readdir(src);
          for (const item of items) {
            await copyRecursive(path.join(src, item), path.join(dest, item));
          }
        } else {
          await fs.promises.copyFile(src, dest);
        }
      }

      await copyRecursive(srcDir, destDir);
      await fs.promises.rm(srcDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * 移动文件或目录到目标路径（目标已存在时先删除）
 */
async function movePath(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    return;
  }
  if (fs.existsSync(destPath)) {
    await fs.promises.rm(destPath, { recursive: true, force: true });
  }

  const stat = await fs.promises.lstat(srcPath);
  if (stat.isDirectory()) {
    await moveDirectory(srcPath, destPath);
    return;
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  try {
    await fs.promises.rename(srcPath, destPath);
  } catch (err) {
    if (err.code === "EXDEV") {
      await fs.promises.copyFile(srcPath, destPath);
      await fs.promises.unlink(srcPath);
    } else {
      throw err;
    }
  }
}

export { assertSafeZipEntryPath, moveDirectory, movePath };
