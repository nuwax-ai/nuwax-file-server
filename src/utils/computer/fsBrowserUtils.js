import fs from "fs";
import os from "os";
import path from "path";

import { ValidationError } from "../error/errorHandler.js";

/**
 * 文件系统目录浏览（目录选择弹窗用）：按绝对路径列一层子项，不锚定工作空间。
 * 跨平台：mac/Linux 根为 "/"，Windows 根为盘符列表；返回路径分隔符统一为 "/"
 * （与 workspaceDir 校验/落库的规范化一致，Windows 侧 fs 均接受正斜杠）。
 * 返回目录与文件，是否可选（文件置灰）由前端按 isDir 判断。
 */

/** 分隔符统一为 / 并折叠连续分隔符（保留 UNC 的前导 //） */
function toDisplayPath(p) {
  const unc = p.startsWith("\\\\") || p.startsWith("//");
  let s = String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (unc) {
    s = "/" + s;
  }
  return s;
}

/**
 * 浏览起点：根目录列表 + 用户 home。
 * - win32：逐一探测 A:/ ~ Z:/ 存在的盘符
 * - 其余平台："/"
 * home 单独返回，前端作为快捷入口
 */
export async function listFsRoots() {
  const home = toDisplayPath(os.homedir());
  const roots = [];
  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ":/";
      try {
        await fs.promises.stat(drive);
        roots.push({ name: drive, path: drive, isDir: true });
      } catch {
        // 不存在的盘符跳过
      }
    }
  } else {
    roots.push({ name: "/", path: "/", isDir: true });
  }
  return { roots, home };
}

/** 绝对路径入参校验（浏览/新建/重命名共用）：非空字符串、无 NUL、宿主语义绝对路径 */
function validateAbsolutePath(dirPath, field = "path") {
  if (!dirPath || typeof dirPath !== "string" || dirPath.includes("\0")) {
    throw new ValidationError(`${field} is required`, { field });
  }
  // file-server 与目标机器同机运行，用宿主 path 模块做本机语义校验
  if (!path.isAbsolute(dirPath)) {
    throw new ValidationError(`${field} must be absolute`, { field });
  }
}

/**
 * 校验目录/文件名（mkdir 的 dirName、rename 的 newName 共用），名称原样保留不 trim
 * （macOS/Linux 允许前后空格；纯空白名拒绝）。
 * / 与 \ 均拒绝：\ 在 win32 是分隔符，且 toDisplayPath 会把 \ 归一为 /，
 * POSIX 下合法的反斜杠名会导致回显路径与实际路径错乱。
 * 长度上限 255 为近似护栏（UTF-16 码元计数）：文件系统真实上限按字节计（ext4/APFS 均 255 字节，
 * 与 UTF-16 计数不严格相等），超限名由 OS 报 ENAMETOOLONG 兜底进
 * "cannot create/rename directory" 分支，不做更精确的字节数校验。
 */
function validateEntryName(name, field) {
  const value = String(name ?? "");
  if (!value.trim() || value.includes("\0")) {
    throw new ValidationError(`${field} is required`, { field });
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new ValidationError(`${field} must not contain path separators`, { field });
  }
  if (value === "." || value === "..") {
    throw new ValidationError(`${field} must not be a relative segment`, { field });
  }
  if (value.length > 255) {
    throw new ValidationError(`${field} exceeds 255 characters`, { field });
  }
  return value;
}

/**
 * 列出目录下一层子项（目录 + 文件），目录在前、按名称自然排序（大小写不敏感）。
 * 隐藏文件（. 开头）默认返回，由前端决定展示样式。
 * 符号链接按目标类型展示（指向目录则可进入），并标记 isSymlink 供前端标注。
 * 目录不存在 / 无权限 / 不是目录时抛 ValidationError，由调用方透出给前端提示。
 * @param {string} dirPath 绝对路径
 */
export async function listFsChildren(dirPath) {
  validateAbsolutePath(dirPath);
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    throw new ValidationError(`cannot read directory (${error.code || error.message})`, {
      field: "path",
    });
  }
  const result = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    const isSymlink = entry.isSymbolicLink();
    if (isSymlink) {
      try {
        isDir = (await fs.promises.stat(path.join(dirPath, entry.name))).isDirectory();
      } catch {
        // 目标不可达的悬空链接：按文件展示，前端置灰
      }
    }
    result.push({
      name: entry.name,
      path: toDisplayPath(path.join(dirPath, entry.name)),
      isDir,
      isSymlink,
    });
  }
  result.sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );
  return { path: toDisplayPath(dirPath), entries: result };
}

/**
 * 在 parentPath 下新建一层目录（目录选择弹窗"新建文件夹"）。
 * 非递归：父目录须已存在（来自浏览选择）；名称支持中文等任意合法文件名。
 * 重名 / 父目录不存在等以 ValidationError 透出给前端提示。
 * @param {string} parentPath 父目录绝对路径
 * @param {string} dirName 新目录名
 */
export async function createFsDirectory(parentPath, dirName) {
  validateAbsolutePath(parentPath, "parentPath");
  const name = validateEntryName(dirName, "dirName");
  const target = path.join(parentPath, name);
  try {
    await fs.promises.mkdir(target); // 不递归：父目录必须存在
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ValidationError(`directory already exists: ${name}`, { field: "dirName" });
    }
    if (error.code === "ENOENT") {
      throw new ValidationError("parent directory does not exist", { field: "parentPath" });
    }
    throw new ValidationError(`cannot create directory (${error.code || error.message})`, {
      field: "dirName",
    });
  }
  return {
    path: toDisplayPath(target),
    name,
    parentPath: toDisplayPath(parentPath),
    isDir: true,
    isSymlink: false,
  };
}

/**
 * 同目录重命名（目录选择弹窗）。newName 仅是名字（校验拒绝分隔符），不支持跨目录移动。
 * 目标名先预检再 rename：POSIX 的 rename 指向已存在空目录时会静默替换，预检保证跨平台
 * 一致的 "already exists" 报错；大小写不敏感文件系统（macOS/Windows）上仅改大小写的
 * 重命名会被判为重名而拒绝，属可接受的取舍。
 * @param {string} dirPath 现目录绝对路径
 * @param {string} newName 新名字
 */
export async function renameFsDirectory(dirPath, newName) {
  validateAbsolutePath(dirPath);
  const name = validateEntryName(newName, "newName");
  const parent = path.dirname(dirPath);
  if (parent === dirPath) {
    // 覆盖 POSIX "/" 与 win32 "C:/" 等根目录
    throw new ValidationError("cannot rename the root directory", { field: "path" });
  }
  const target = path.join(parent, name);
  let targetExists;
  try {
    await fs.promises.stat(target);
    targetExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new ValidationError(`cannot rename (${error.code || error.message})`, { field: "path" });
    }
    targetExists = false;
  }
  if (targetExists) {
    throw new ValidationError(`name already exists: ${name}`, { field: "newName" });
  }
  try {
    await fs.promises.rename(dirPath, target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ValidationError("directory does not exist", { field: "path" });
    }
    throw new ValidationError(`cannot rename directory (${error.code || error.message})`, {
      field: "newName",
    });
  }
  return {
    path: toDisplayPath(target),
    name,
    parentPath: toDisplayPath(parent),
    isDir: true,
    isSymlink: false,
  };
}
