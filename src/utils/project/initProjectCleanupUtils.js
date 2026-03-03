import fs from "fs";
import path from "path";
import { log } from "../log/logUtils.js";

/**
 * 删除初始化项目文件夹
 * @param {string} initProjectDir - 初始化项目目录路径
 * @param {string} initProjectName - 初始化项目名称
 * @returns {Promise<boolean>} - 删除是否成功
 */
async function deleteInitProjectFolder(initProjectDir, initProjectName) {
  try {
    const targetPath = path.join(initProjectDir, initProjectName);

    // 检查目标路径是否存在
    if (!fs.existsSync(targetPath)) {
      log("default", "INFO", `初始化项目文件夹不存在: ${targetPath}`);
      return true;
    }

    // 检查是否为目录
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      log("default", "WARN", `目标路径不是目录: ${targetPath}`);
      return false;
    }

    // 递归删除目录
    fs.rmSync(targetPath, { recursive: true, force: true });

    log("default", "INFO", `成功删除初始化项目文件夹: ${targetPath}`);
    return true;
  } catch (error) {
    log("default", "ERROR", `删除初始化项目文件夹失败: ${error.message}`);
    log(
      "default",
      "ERROR",
      `目标路径: ${path.join(initProjectDir, initProjectName)}`
    );
    return false;
  }
}

/**
 * 在项目启动时清理初始化项目文件夹
 * @param {Object} config - 配置对象
 * @returns {Promise<boolean>} - 清理是否成功
 */
async function cleanupInitProjectOnStartup(config) {
  try {
    const { INIT_PROJECT_DIR, INIT_PROJECT_NAME } = config;

    if (!INIT_PROJECT_DIR || !INIT_PROJECT_NAME) {
      log("default", "WARN", "INIT_PROJECT_DIR 或 INIT_PROJECT_NAME 配置缺失");
      return false;
    }

    log("default", "INFO", "开始清理初始化项目文件夹...");
    log("default", "INFO", `目标目录: ${INIT_PROJECT_DIR}`);
    log("default", "INFO", `项目名称: ${INIT_PROJECT_NAME}`);

    const success = await deleteInitProjectFolder(
      INIT_PROJECT_DIR,
      INIT_PROJECT_NAME
    );

    if (success) {
      log("default", "INFO", "初始化项目文件夹清理完成");
    } else {
      log("default", "ERROR", "初始化项目文件夹清理失败");
    }

    return success;
  } catch (error) {
    log("default", "ERROR", `清理初始化项目文件夹时发生错误: ${error.message}`);
    return false;
  }
}

export { deleteInitProjectFolder, cleanupInitProjectOnStartup };

