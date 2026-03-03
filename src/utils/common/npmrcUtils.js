import fs from "fs";
import path from "path";
import { log, getCSTDateTimeString } from "../log/logUtils.js";

/**
 * 为项目创建优化的 .npmrc 配置文件
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（用于日志）
 * @returns {Promise<Object>} 创建结果
 */
async function createPnpmNpmrc(projectPath, projectId = null) {
  const logId = projectId || path.basename(projectPath);
  const npmrcPath = path.join(projectPath, ".npmrc");

  // .npmrc 配置内容
  const npmrcContent = `# pnpm 磁盘空间优化配置
# 自动生成于 ${getCSTDateTimeString()}

package-import-method=hardlink
auto-install-peers=true
registry=https://registry.npmmirror.com
`;

  try {
    // 检查 .npmrc 是否已存在
    if (fs.existsSync(npmrcPath)) {
      log(logId, "INFO", ".npmrc 文件已存在，跳过创建", {
        projectPath,
        npmrcPath,
      });
      return {
        success: true,
        created: false,
        message: ".npmrc 文件已存在",
        npmrcPath,
      };
    }

    // 创建 .npmrc 文件
    await fs.promises.writeFile(npmrcPath, npmrcContent, "utf8");

    log(logId, "INFO", ".npmrc 文件创建成功", {
      projectPath,
      npmrcPath,
    });

    return {
      success: true,
      created: true,
      message: ".npmrc 文件创建成功",
      npmrcPath,
    };
  } catch (error) {
    log(logId, "WARN", `.npmrc 文件创建失败: ${error.message}`, {
      projectPath,
      npmrcPath,
      error: error.message,
    });

    // 创建 .npmrc 失败不应该阻止主流程，只记录警告
    return {
      success: false,
      created: false,
      message: `.npmrc 文件创建失败: ${error.message}`,
      error: error.message,
    };
  }
}

export { createPnpmNpmrc };


