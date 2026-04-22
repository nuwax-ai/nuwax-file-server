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
      log("default", "INFO", `Initialization project directory does not exist: ${targetPath}`);
      return true;
    }

    // 检查是否为目录
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      log("default", "WARN", `Target path is not a directory: ${targetPath}`);
      return false;
    }

    // 递归删除目录
    fs.rmSync(targetPath, { recursive: true, force: true });

    log("default", "INFO", `Successfully deleted initialization project directory: ${targetPath}`);
    return true;
  } catch (error) {
    log("default", "ERROR", `Delete initialization project directory failed: ${error.message}`);
    log(
      "default",
      "ERROR",
      `Target path: ${path.join(initProjectDir, initProjectName)}`
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
    const {
      INIT_PROJECT_DIR,
      INIT_PROJECT_NAME_REACT,
      INIT_PROJECT_NAME_VUE3,
    } = config;

    if (!INIT_PROJECT_DIR) {
      log("default", "WARN", "INIT_PROJECT_DIR configuration missing");
      return false;
    }

    const templateNameSet = new Set(
      [
        INIT_PROJECT_NAME_REACT,
        INIT_PROJECT_NAME_VUE3,
      ].filter(Boolean)
    );
    if (templateNameSet.size === 0) {
      log("default", "WARN", "Initialization template name configuration missing");
      return false;
    }

    log("default", "INFO", "Start cleaning initialization project directory...");
    log("default", "INFO", `Target directory: ${INIT_PROJECT_DIR}`);
    log("default", "INFO", `Template names: ${Array.from(templateNameSet).join(", ")}`);

    let allSuccess = true;
    for (const templateName of templateNameSet) {
      const success = await deleteInitProjectFolder(INIT_PROJECT_DIR, templateName);
      if (!success) {
        allSuccess = false;
      }
    }

    if (allSuccess) {
      log("default", "INFO", "Initialization project directory cleanup completed");
    } else {
      log("default", "ERROR", "Initialization project directory cleanup failed");
    }

    return allSuccess;
  } catch (error) {
    log("default", "ERROR", `Clean initialization project directory failed: ${error.message}`);
    return false;
  }
}

export { deleteInitProjectFolder, cleanupInitProjectOnStartup };

