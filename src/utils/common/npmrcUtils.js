import fs from "fs";
import path from "path";
import { log, getCSTDateTimeString } from "../log/logUtils.js";
import { detectFilesystemType } from "./templateCacheUtils.js";

/**
 * 为项目创建优化的 .npmrc 配置文件
 *
 * 统一使用 package-import-method=copy：
 * - 避免 hardlink 在 JuiceFS/FUSE 上失败
 * - docker-compose 和 K8s 统一处理，不区分文件系统类型
 *
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（用于日志）
 * @returns {Promise<Object>} 创建结果
 */
async function createPnpmNpmrc(projectPath, projectId = null) {
  const logId = projectId || path.basename(projectPath);
  const npmrcPath = path.join(projectPath, ".npmrc");

  // 统一使用 copy 模式：避免 hardlink 在 JuiceFS/FUSE 上失败
  // docker-compose 和 K8s 统一处理，不区分文件系统类型
  const fsType = detectFilesystemType(projectPath);
  const importMethod = "copy";

  // pnpm store 路径：pnpm 不识别 PNPM_STORE_DIR 环境变量（它用 npm 约定 npm_config_store_dir）
  // 必须显式写入 .npmrc 的 store-dir= 配置行，否则 store 会落入项目目录（JuiceFS 上极慢）
  const storeDir =
    process.env.npm_config_store_dir || process.env.PNPM_STORE_DIR || "";
  const storeDirLine = storeDir ? `store-dir=${storeDir}\n` : "";

  // .npmrc 配置内容
  const npmrcContent = `# pnpm 优化配置
# 自动生成于 ${getCSTDateTimeString()}
# 文件系统类型: ${fsType}
package-import-method=${importMethod}
auto-install-peers=true
registry=https://registry.npmmirror.com
${storeDirLine}`;

  try {
    // 检查 .npmrc 是否已存在（在写入前记录，用于日志区分 created/updated）
    const existed = fs.existsSync(npmrcPath);

    if (existed) {
      const existingContent = fs.readFileSync(npmrcPath, "utf8");

      // 检查是否需要更新 import-method 或 store-dir
      // 用 ^\s* + m(多行) 标志排除注释行（# 开头），只匹配实际配置行
      const existingMethodMatch = existingContent.match(
        /^\s*package-import-method\s*=\s*(\S+)/m
      );
      const existingStoreMatch = existingContent.match(
        /^\s*store-dir\s*=\s*(\S+)/m
      );
      const existingMethod = existingMethodMatch
        ? existingMethodMatch[1]
        : null;
      const existingStoreDir = existingStoreMatch
        ? existingStoreMatch[1]
        : null;

      // 两项配置都正确时才跳过：import-method 匹配 且 store-dir 匹配（或无需设置 store-dir）
      const methodOk = existingMethod === importMethod;
      const storeOk = !storeDir || existingStoreDir === storeDir;

      if (methodOk && storeOk) {
        log(logId, "INFO", ".npmrc already optimal, skip creation", {
          projectPath,
          npmrcPath,
          importMethod,
          storeDir: existingStoreDir || "(not set)",
          fsType,
        });
        return {
          success: true,
          created: false,
          message: ".npmrc already optimal",
          npmrcPath,
          importMethod,
          storeDir: existingStoreDir,
          fsType,
        };
      }

      // 需要更新
      log(logId, "INFO", ".npmrc needs update", {
        projectPath,
        npmrcPath,
        existingMethod,
        newMethod: importMethod,
        existingStoreDir: existingStoreDir || "(not set)",
        newStoreDir: storeDir || "(not set)",
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
      storeDir: storeDir || "(not set)",
      fsType,
    });

    return {
      success: true,
      created: true,
      message: `.npmrc ${action} successfully`,
      npmrcPath,
      importMethod,
      storeDir,
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
