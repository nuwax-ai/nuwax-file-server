import fs from "fs";
import path from "path";
import { log, getCSTDateTimeString } from "../log/logUtils.js";
import { detectFilesystemType } from "./templateCacheUtils.js";

/**
 * 为项目创建优化的 .npmrc 配置文件
 *
 * 根据项目所在的文件系统类型自动选择最优的 package-import-method：
 * - fuse (JuiceFS / NFS) → copy（避免 hardlink 并发竞争）
 * - local (ext4 / xfs / overlay) → hardlink（最快）
 *
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（用于日志）
 * @returns {Promise<Object>} 创建结果
 */
async function createPnpmNpmrc(projectPath, projectId = null) {
  const logId = projectId || path.basename(projectPath);
  const npmrcPath = path.join(projectPath, ".npmrc");

  // 根据文件系统类型选择 import-method
  const fsType = detectFilesystemType(projectPath);
  const importMethod = fsType === "fuse" ? "copy" : "hardlink";

  // .npmrc 配置内容
  const npmrcContent = `# pnpm 优化配置
# 自动生成于 ${getCSTDateTimeString()}
# 文件系统类型: ${fsType}
# pnpm store: ${process.env.PNPM_STORE_DIR || "(default)"}
package-import-method=${importMethod}
auto-install-peers=true
registry=https://registry.npmmirror.com
`;

  try {
    // 检查 .npmrc 是否已存在（在写入前记录，用于日志区分 created/updated）
    const existed = fs.existsSync(npmrcPath);

    if (existed) {
      const existingContent = fs.readFileSync(npmrcPath, "utf8");

      // 检查是否需要更新 import-method
      const existingMethodMatch = existingContent.match(
        /package-import-method\s*=\s*(\S+)/
      );
      const existingMethod = existingMethodMatch
        ? existingMethodMatch[1]
        : null;

      if (existingMethod === importMethod) {
        log(logId, "INFO", ".npmrc already optimal, skip creation", {
          projectPath,
          npmrcPath,
          importMethod,
          fsType,
        });
        return {
          success: true,
          created: false,
          message: ".npmrc already optimal",
          npmrcPath,
          importMethod,
          fsType,
        };
      }

      // 需要更新 import-method
      log(logId, "INFO", ".npmrc needs update", {
        projectPath,
        npmrcPath,
        existingMethod,
        newMethod: importMethod,
        fsType,
      });
    }

    // 创建或更新 .npmrc 文件
    await fs.promises.writeFile(npmrcPath, npmrcContent, "utf8");

    const action = existed ? "updated" : "created";
    log(logId, "INFO", `.npmrc ${action} successfully`, {
      projectPath,
      npmrcPath,
      importMethod,
      fsType,
    });

    return {
      success: true,
      created: true,
      message: `.npmrc ${action} successfully`,
      npmrcPath,
      importMethod,
      fsType,
    };
  } catch (error) {
    log(logId, "WARN", `.npmrc file creation failed: ${error.message}`, {
      projectPath,
      npmrcPath,
      error: error.message,
    });

    // 创建 .npmrc 失败不应该阻止主流程，只记录警告
    return {
      success: false,
      created: false,
      message: `.npmrc file creation failed: ${error.message}`,
      error: error.message,
    };
  }
}

export { createPnpmNpmrc };
