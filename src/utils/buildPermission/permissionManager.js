import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";

/**
 * 递归修复目录下所有可执行文件的权限
 * @param {string} dir 目录路径
 */
async function fixExecutablePermissionsRecursive(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归处理子目录
        await fixExecutablePermissionsRecursive(fullPath);
      } else if (entry.isFile()) {
        // 检查是否为可执行文件（通过文件名或扩展名判断）
        const isExecutable =
          entry.name.includes("bin") ||
          entry.name.endsWith(".exe") ||
          !entry.name.includes(".") ||
          entry.name.match(/^(esbuild|vite|webpack|rollup)$/);

        if (isExecutable) {
          try {
            await fs.promises.chmod(fullPath, 0o755);
            // 移除隔离标记
            await new Promise((resolve) => {
              exec(`xattr -d com.apple.quarantine "${fullPath}"`, () =>
                resolve()
              );
            });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

/**
 * 修复可执行权限：为 node_modules/.bin 及被指向的目标脚本添加可执行权限
 * @param {string} projectPath 项目路径
 */
async function ensureDevBinariesExecutable(projectPath) {
  try {
    const nodeModulesDir = path.join(projectPath, "node_modules");
    if (!fs.existsSync(nodeModulesDir)) return;

    // 1. 处理 .bin 目录
    const binDir = path.join(nodeModulesDir, ".bin");
    if (fs.existsSync(binDir)) {
      const entries = await fs.promises.readdir(binDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(binDir, entry.name);

        // 给 .bin 下的文件加执行权限
        try {
          await fs.promises.chmod(filePath, 0o755);
        } catch (_) {}

        // 处理文件内容为相对路径的情况（例如仅包含 ../vite/bin/vite.js）
        try {
          const content = await fs.promises.readFile(filePath, "utf8");
          const trimmed = content.trim();
          const looksLikeSinglePath =
            trimmed && !trimmed.startsWith("#!/") && !trimmed.includes("\n");
          if (looksLikeSinglePath) {
            const targetAbs = path.resolve(path.dirname(filePath), trimmed);
            if (fs.existsSync(targetAbs)) {
              // 先给目标加执行权限
              try {
                await fs.promises.chmod(targetAbs, 0o755);
              } catch (_) {}

              // 将占位文件替换为指向目标的符号链接，确保相对路径相对于 .bin 目录
              try {
                const relativeFromBin = path.relative(
                  path.dirname(filePath),
                  targetAbs
                );
                await fs.promises.unlink(filePath).catch(() => {});
                await fs.promises.symlink(relativeFromBin, filePath);
              } catch (_) {
                // 如果创建符号链接失败，退化为写入一个带 shebang 的 shim
                const shim = `#!/usr/bin/env bash\nDIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\nexec \"$DIR/${trimmed}\" \"$@\"\n`;
                try {
                  await fs.promises.writeFile(filePath, shim, "utf8");
                  await fs.promises.chmod(filePath, 0o755);
                } catch (_) {}
              }
            }
          }
        } catch (_) {}

        // 尝试移除隔离标记（macOS）
        try {
          await new Promise((resolve) => {
            exec(`xattr -d com.apple.quarantine "${filePath}"`, () =>
              resolve()
            );
          });
        } catch (_) {}
      }
    }

    // 2. 处理常见的二进制包目录（如 @esbuild、esbuild 等）
    const binaryPackages = ["@esbuild", "esbuild", "vite", "webpack", "rollup"];
    for (const pkg of binaryPackages) {
      const pkgDir = path.join(nodeModulesDir, pkg);
      if (fs.existsSync(pkgDir)) {
        await fixExecutablePermissionsRecursive(pkgDir);
      }
    }
  } catch (e) {
    // 仅记录，不阻断启动流程
    log(null, "WARN", "修复可执行权限时出现问题（忽略继续）", {
      error: e && e.message,
    });
  }
}

export { fixExecutablePermissionsRecursive, ensureDevBinariesExecutable };
