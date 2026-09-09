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

/**
 * 列出目录下一层子项（目录 + 文件），目录在前、按名称自然排序（大小写不敏感）。
 * 隐藏文件（. 开头）默认返回，由前端决定展示样式。
 * 符号链接按目标类型展示（指向目录则可进入），并标记 isSymlink 供前端标注。
 * 目录不存在 / 无权限 / 不是目录时抛 ValidationError，由调用方透出给前端提示。
 * @param {string} dirPath 绝对路径
 */
export async function listFsChildren(dirPath) {
  if (!dirPath || typeof dirPath !== "string" || dirPath.includes("\0")) {
    throw new ValidationError("path is required", { field: "path" });
  }
  // file-server 与目标机器同机运行，用宿主 path 模块做本机语义校验
  if (!path.isAbsolute(dirPath)) {
    throw new ValidationError("path must be absolute", { field: "path" });
  }
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
