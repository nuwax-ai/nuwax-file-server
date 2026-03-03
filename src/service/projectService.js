import { log } from "../utils/log/logUtils.js";
import config from "../appConfig/index.js";
import path from "path";
import fs from "fs";
import { extractZip } from "../utils/common/zipUtils.js";
import { startDevServer } from "../utils/build/startDevUtils.js";
import { restartDevServer } from "../utils/build/restartDevUtils.js";
import { stopDevServer } from "../utils/build/stopDevUtils.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
  FileError,
  ResourceError,
} from "../utils/error/errorHandler.js";
import { sanitizeSensitivePaths } from "../utils/common/sensitiveUtils.js";
import { removeNodeModules } from "../utils/buildDependency/dependencyManager.js";
import {
  backupProjectToZip,
  copyDirectoryFiltered,
} from "../utils/project/backupUtils.js";
import { createPnpmNpmrc } from "../utils/common/npmrcUtils.js";

/**
 * 创建项目目录
 * @param {string} projectId - 项目ID
 * @returns {Promise<Object>} 创建结果
 */
async function createProject(projectId) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }

  //项目源文件所在目录
  const projectSourceDir = config.PROJECT_SOURCE_DIR;
  const projectPath = path.join(projectSourceDir, projectId);

  // 检查目录是否已存在
  if (fs.existsSync(projectPath)) {
    throw new BusinessError(`项目目录 ${projectId} 已存在`, {
      projectId,
      projectPath,
    });
  }

  try {
    // 创建项目目录
    fs.mkdirSync(projectPath, { recursive: true });
    log(projectId, "INFO", `项目目录创建成功: ${projectPath}`, { projectId });
    // 准备模板路径
    const initDir = config.INIT_PROJECT_DIR;
    const templateZipPath = path.join(
      initDir,
      `${config.INIT_PROJECT_NAME}.zip`
    );
    const templateDir = path.join(initDir, config.INIT_PROJECT_NAME);

    // 如果模板目录不存在，则尝试从zip解压
    if (!fs.existsSync(templateDir)) {
      if (!fs.existsSync(templateZipPath)) {
        log(projectId, "ERROR", `初始化模板不存在: ${templateZipPath}`, {
          projectId,
          templateZipPath,
        });
        throw new ResourceError("初始化模板不存在", {});
      }
      log(
        projectId,
        "INFO",
        `模板目录不存在，开始解压模板: ${templateZipPath}`,
        {
          projectId,
          templateZipPath,
        }
      );
      await extractZip(templateZipPath, templateDir);
      log(projectId, "INFO", "模板解压完成", { projectId });
      if (!fs.existsSync(templateDir)) {
        throw new SystemError("模板解压后目录仍不存在", {});
      }
    }

    // 将模板内容复制到项目目录（不包含顶层 react-vite 目录）
    const entries = await fs.promises.readdir(templateDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const srcPath = path.join(templateDir, entry.name);
      const destPath = path.join(projectPath, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.mkdir(destPath, { recursive: true });
        // 复制目录
        await copyDirectoryFiltered(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(srcPath, destPath);
      }
    }

    log(projectId, "INFO", `项目 ${projectId} 初始化成功`, { projectId });

    // 为项目创建 .npmrc 配置文件
    await createPnpmNpmrc(projectPath, projectId);

    return {
      success: true,
      message: `项目 ${projectId} 创建成功`,
      projectPath: projectPath,
    };
  } catch (error) {
    log(projectId, "ERROR", `项目 ${projectId} 初始化失败: ${error.message}`, {
      projectId,
    });
    throw new SystemError(`项目 ${projectId} 初始化失败: ${error.message}`, {
      projectId,
      projectPath,
      originalError: error.message,
    });
  }
}

/**
 * 检查并移除顶层文件夹
 * @param {string} projectPath - 项目路径
 * @returns {Promise<void>}
 */
async function removeTopLevelFolder(projectPath) {
  const entries = await fs.promises.readdir(projectPath, {
    withFileTypes: true,
  });

  // 过滤噪声条目
  const noisePatterns = config.TOP_LEVEL_NOISE_PATTERNS;

  const filteredEntries = entries.filter((entry) => {
    const name = entry.name;

    // 过滤以点开头的隐藏文件/目录（所有以点开头的都算噪声）
    if (name.startsWith(".")) {
      return false;
    }

    // 过滤其他噪声条目
    return !noisePatterns.some((pattern) => {
      if (pattern.endsWith("*")) {
        return name.startsWith(pattern.slice(0, -1));
      }
      return name === pattern;
    });
  });

  // 如果过滤后只有一个目录，则认为是顶层文件夹
  if (filteredEntries.length === 1 && filteredEntries[0].isDirectory()) {
    const topLevelDir = path.join(projectPath, filteredEntries[0].name);
    const tempDir = path.join(projectPath, "..", `temp_${Date.now()}`);

    // 将顶层文件夹内容移动到临时目录
    await fs.promises.rename(topLevelDir, tempDir);

    // 将临时目录内容移回项目目录
    const tempEntries = await fs.promises.readdir(tempDir);
    for (const entry of tempEntries) {
      const srcPath = path.join(tempDir, entry);
      const destPath = path.join(projectPath, entry);
      await fs.promises.rename(srcPath, destPath);
    }

    // 删除临时目录
    await fs.promises.rmdir(tempDir);
  }
}

/**
 * 清理项目目录（删除整个项目目录）
 * @param {string} projectId - 项目ID
 * @returns {Promise<void>}
 */
async function cleanupProjectDirectory(projectId) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);

  if (fs.existsSync(projectPath)) {
    try {
      log(projectId, "INFO", `开始清理项目目录: ${projectPath}`, { projectId });
      await fs.promises.rm(projectPath, { recursive: true, force: true });
      log(projectId, "INFO", `项目目录清理完成: ${projectPath}`, { projectId });
    } catch (error) {
      log(projectId, "ERROR", `清理项目目录失败: ${error.message}`, {
        projectId,
        projectPath,
        originalError: error.message,
      });
      throw new SystemError(`清理项目目录失败: ${error.message}`, {
        projectId,
        projectPath,
        originalError: error.message,
      });
    }
  } else {
    log(projectId, "INFO", `项目目录不存在，无需清理: ${projectPath}`, {
      projectId,
    });
  }
}

/**
 * 检查目录是否为空
 */
function isDirectoryEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return true;
  }

  try {
    const entries = fs.readdirSync(dirPath);
    // 过滤掉隐藏文件和系统文件
    const filteredEntries = entries.filter((entry) => {
      return !entry.startsWith(".") && entry !== "node_modules";
    });
    return filteredEntries.length === 0;
  } catch (error) {
    const projectId = path.basename(dirPath);
    log(projectId, "ERROR", `检查目录是否为空失败: ${error.message}`, {
      dirPath,
    });
    return true; // 出错时默认认为为空
  }
}

/**
 * 上传项目压缩包
 */
async function uploadProject(
  projectId,
  zipFilePath,
  req,
  codeVersion,
  pid,
  basePath
) {
  // 项目源文件所在目录
  const projectSourceDir = config.PROJECT_SOURCE_DIR;
  const projectPath = path.join(projectSourceDir, projectId);

  try {
    // 检查项目目录是否为空
    const isEmpty = isDirectoryEmpty(projectPath);

    if (!isEmpty) {
      // 目录非空，需要备份当前项目
      log(projectId, "INFO", `项目目录非空，开始备份当前版本`, { projectId });

      // 检查是否已存在 codeVersion-1 的备份
      const prevVersion = parseInt(codeVersion) - 1;
      const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
      const backupZipPath = path.join(
        backupDir,
        `${projectId}-v${prevVersion}.zip`
      );

      if (!fs.existsSync(backupZipPath)) {
        // 备份当前项目
        try {
          await backupProjectOfVersion(projectId, prevVersion);
          log(projectId, "INFO", `当前版本已备份: ${backupZipPath}`, {
            projectId,
          });
        } catch (backupError) {
          log(projectId, "ERROR", `备份当前版本失败: ${backupError.message}`, {
            projectId,
          });
          throw new SystemError(`备份当前版本失败: ${backupError.message}`, {
            projectId,
            originalError: backupError.message,
          });
        }
      } else {
        log(projectId, "INFO", `备份文件已存在，跳过备份: ${backupZipPath}`, {
          projectId,
        });
      }

      // 停止旧版本的dev服务器
      if (pid && !isNaN(Number(pid))) {
        const pidNum = Number(pid);
        log(projectId, "INFO", `正在停止旧版本dev服务器，PID: ${pidNum}`, {
          projectId,
        });
        try {
          await stopDevServer(req, projectId, pidNum, { strict: true });
          log(projectId, "INFO", `旧版本dev服务器已停止`, { projectId });
        } catch (stopError) {
          log(
            projectId,
            "WARN",
            `停止旧版本dev服务器失败: ${stopError.message}`,
            {
              projectId,
              pid: pidNum,
            }
          );
          // 停止失败不影响后续流程，继续执行
        }
      }

      // 清空项目目录
      if (fs.existsSync(projectPath)) {
        log(projectId, "INFO", `正在清空项目目录: ${projectPath}`, {
          projectId,
        });
        await fs.promises.rm(projectPath, { recursive: true, force: true });
      }
    } else {
      log(projectId, "INFO", `项目目录为空，直接部署新项目`, { projectId });
    }

    // 创建项目目录
    fs.mkdirSync(projectPath, { recursive: true });
    log(projectId, "INFO", `项目目录创建成功: ${projectPath}`, { projectId });

    // 解压压缩包到项目目录
    log(projectId, "INFO", "开始解压压缩包", { projectId });
    await extractZip(zipFilePath, projectPath);
    log(projectId, "INFO", "压缩包解压完成", { projectId });

    // 检查并移除顶层文件夹
    log(projectId, "INFO", "检查并处理顶层文件夹", { projectId });
    await removeTopLevelFolder(projectPath);

    // 检查并删除 node_modules 文件夹
    log(projectId, "INFO", "检查并删除 node_modules 文件夹", { projectId });
    await removeNodeModules(projectPath);

    // 为项目创建 .npmrc 配置文件
    await createPnpmNpmrc(projectPath, projectId);

    // 不需要启动dev,前端会调用启动
    return {
      success: true,
      message: `项目 ${projectId} 上传成功`,
      projectId: projectId,
      codeVersion: codeVersion,
    };
  } catch (error) {
    log(projectId, "ERROR", `上传项目失败: ${error.message}`, { projectId });

    // 上传失败时清理项目目录
    try {
      await cleanupProjectDirectory(projectId);
      log(projectId, "INFO", "上传失败，项目目录已清理", { projectId });
    } catch (cleanupError) {
      log(projectId, "ERROR", `清理项目目录失败: ${cleanupError.message}`, {
        projectId,
        originalError: cleanupError.message,
      });
      // 清理失败不影响主错误抛出
    }

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`上传项目失败: ${error.message}`, {
        projectId,
        projectPath,
        zipFilePath,
        originalError: error.message,
      });
    }

    throw error;
  }
}

/**
 * 备份项目为指定版本zip
 * @param {string} projectId 项目ID
 * @param {number|string} codeVersion 版本号
 * @returns {Promise<string>} zip文件路径
 */
async function backupProjectOfVersion(projectId, codeVersion) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion不能为空", {
      field: "codeVersion",
    });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    throw new ResourceError("项目不存在", { projectId });
  }

  // 构建zip文件路径
  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const zipName = `${projectId}-v${versionNum}.zip`;
  const outZipPath = path.join(backupDir, zipName);

  // 进行备份
  return await backupProjectToZip(projectId, projectPath, outZipPath);
}

/**
 * 处理上传的文件（移动到项目目录）
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 代码版本
 * @param {Object} file 上传的文件对象（来自multer）
 * @returns {Promise<Object>} 处理结果，包含文件路径
 */
async function handleFileUpload(projectId, codeVersion, file) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  if (!codeVersion) {
    throw new ValidationError("代码版本不能为空", { field: "codeVersion" });
  }
  if (!file) {
    throw new ValidationError("请上传压缩包文件", { field: "zipFile" });
  }

  // 创建项目目录
  const projectPath = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  // 将文件从临时目录移动到项目目录
  const tempFilePath = file.path;
  const projectFilePath = path.join(
    projectPath,
    `${projectId}-v${codeVersion}.zip`
  );

  try {
    fs.renameSync(tempFilePath, projectFilePath);
    log(projectId, "INFO", "文件保存成功", {
      projectId,
      codeVersion,
      filePath: projectFilePath,
    });
    return { success: true, filePath: projectFilePath };
  } catch (moveErr) {
    log(projectId, "ERROR", "移动文件失败", {
      projectId,
      codeVersion,
      error: moveErr.message,
    });

    // 清理临时文件
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupErr) {
        log(projectId, "ERROR", "清理临时文件失败", {
          projectId,
          error: cleanupErr.message,
        });
      }
    }
    throw new SystemError("文件保存失败", {
      projectId,
      codeVersion,
      originalError: moveErr.message,
    });
  }
}

/**
 * 删除项目
 * @param {string} projectId - 项目ID
 * @param {string|number} pid - 进程ID（可选）
 * @returns {Promise<Object>} 删除结果
 */
async function deleteProject(projectId, pid, req) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }

  // 使用特殊的日志标识符，避免日志输出到项目目录
  const logId = null;

  try {
    // 1. 如果有pid，先停止开发服务器
    if (pid && !isNaN(Number(pid))) {
      const pidNum = Number(pid);
      log(
        logId,
        "INFO",
        `[delete-project] 正在停止开发服务器，PID: ${pidNum}`,
        {
          projectId,
          pid: pidNum,
        }
      );

      try {
        await stopDevServer(req, projectId, pidNum, { strict: true });
        log(logId, "INFO", `[delete-project] 开发服务器已停止`, { projectId });
      } catch (stopError) {
        log(
          logId,
          "WARN",
          `[delete-project] 停止开发服务器失败: ${stopError.message}`,
          {
            projectId,
            pid: pidNum,
          }
        );
        // 停止失败不影响后续删除流程，继续执行
      }
    }

    // 2. 删除项目相关目录
    const directoriesToDelete = [
      path.join(config.UPLOAD_PROJECT_DIR, projectId),
      path.join(config.PROJECT_SOURCE_DIR, projectId),
      path.join(config.DIST_TARGET_DIR, projectId),
      path.join(config.LOG_BASE_DIR, projectId),
    ];

    const deletedDirs = [];
    const failedDirs = [];

    for (const dirPath of directoriesToDelete) {
      if (fs.existsSync(dirPath)) {
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          deletedDirs.push(dirPath);
          log(logId, "INFO", `[delete-project] 目录删除成功: ${dirPath}`, {
            projectId,
          });
        } catch (error) {
          failedDirs.push({ path: dirPath, error: error.message });
          log(logId, "ERROR", `[delete-project] 目录删除失败: ${dirPath}`, {
            projectId,
            error: error.message,
          });
        }
      } else {
        log(
          logId,
          "INFO",
          `[delete-project] 目录不存在，跳过删除: ${dirPath}`,
          {
            projectId,
          }
        );
      }
    }

    // 3. 返回删除结果
    const result = {
      success: true,
      message: `项目 ${projectId} 删除完成`,
      projectId,
      deletedDirectories: deletedDirs,
      failedDirectories: failedDirs,
    };

    if (failedDirs.length > 0) {
      result.message += `，但有 ${failedDirs.length} 个目录删除失败`;
      log(logId, "WARN", "[delete-project] 部分目录删除失败", {
        projectId,
        failedDirs,
      });
    }

    log(logId, "INFO", `[delete-project] 项目删除完成: ${projectId}`, {
      projectId,
    });
    return result;
  } catch (error) {
    log(logId, "ERROR", `[delete-project] 删除项目失败: ${error.message}`, {
      projectId,
      originalError: error.message,
    });

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`删除项目失败: ${error.message}`, {
        projectId,
        originalError: error.message,
      });
    }

    throw error;
  }
}

/**
 * 导出当前项目为zip包
 * @param {string} projectId 项目ID
 * @param {number|string} codeVersion 导出版本号
 * @param {string} exportType 导出类型(LATEST,PUBLISHED)
 * @param {Object} configParam 配置数据
 * @returns {Promise<{success:boolean, projectId:string, zipPath:string}>}
 */
async function exportProject(projectId, codeVersion, exportType, configParam) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion不能为空", {
      field: "codeVersion",
    });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion必须是数字", {
      field: "codeVersion",
    });
  }

  const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    throw new ResourceError("项目不存在", { projectId });
  }

  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  const zipName = `${projectId}-v${versionNum}.zip`;
  const zipPath = path.join(backupDir, zipName);

  // 如果导出类型不是LATEST，直接查找现成的zip包返回
  if (exportType !== "LATEST") {
    if (fs.existsSync(zipPath)) {
      log(projectId, "INFO", `使用已存在的导出文件: ${zipPath}`, {
        projectId,
        zipPath,
      });
      return { success: true, projectId, zipPath };
    } else {
      throw new ResourceError(`指定版本的zip包不存在: ${zipPath}`, {
        projectId,
        zipPath,
      });
    }
  }

  // 导出类型是LATEST，直接打zip包
  const configFilePath = path.join(projectPath, "cpage_config.json");
  let configFileCreated = false;

  try {
    // 如果提供了config参数，先写入项目根目录
    if (configParam) {
      try {
        const configJson = JSON.stringify(configParam, null, 2);
        await fs.promises.writeFile(configFilePath, configJson, "utf8");
        configFileCreated = true;
        log(projectId, "INFO", `已创建配置文件: ${configFilePath}`, {
          projectId,
          configFilePath,
        });
      } catch (configErr) {
        log(projectId, "ERROR", `创建配置文件失败: ${configErr.message}`, {
          projectId,
          error: configErr.message,
        });
        throw new FileError("创建配置文件失败", {
          projectId,
          configFilePath,
          originalError: configErr.message,
        });
      }
    }

    // 执行导出（不管有没有现成的zip包，都直接打zip包）
    const outZipPath = await backupProjectOfVersion(projectId, codeVersion);
    log(projectId, "INFO", `项目已导出: ${outZipPath}`, {
      projectId,
      zipPath: outZipPath,
    });
    return { success: true, projectId, zipPath: outZipPath };
  } catch (e) {
    if (!e.isOperational) {
      throw new SystemError("导出项目失败", {
        projectId,
        originalError:
          e && e.message ? sanitizeSensitivePaths(e.message) : e && e.message,
      });
    }
    throw e;
  } finally {
    // 如果有创建配置文件，导出完成后删除
    if (configFileCreated && fs.existsSync(configFilePath)) {
      try {
        await fs.promises.unlink(configFilePath);
        log(projectId, "INFO", `已删除临时配置文件: ${configFilePath}`, {
          projectId,
          configFilePath,
        });
      } catch (deleteErr) {
        log(projectId, "WARN", `删除临时配置文件失败: ${deleteErr.message}`, {
          projectId,
          error: deleteErr.message,
        });
        // 删除失败不影响导出结果
      }
    }
  }
}

/**
 * 备份当前项目为指定版本zip
 */
async function backupCurrentVersion(projectId, codeVersion) {
  if (!projectId) {
    throw new ValidationError("项目ID不能为空", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion不能为空", {
      field: "codeVersion",
    });
  }

  try {
    const zipPath = await backupProjectOfVersion(projectId, codeVersion);
    log(projectId, "INFO", `当前版本已备份: ${zipPath}`, {
      projectId,
      zipPath,
    });
    return { success: true, projectId, zipPath };
  } catch (e) {
    if (!e.isOperational) {
      throw new SystemError("备份当前版本失败", {
        projectId,
        originalError:
          e && e.message ? sanitizeSensitivePaths(e.message) : e && e.message,
      });
    }
    throw e;
  }
}

export {
  createProject,
  uploadProject,
  backupCurrentVersion,
  exportProject,
  backupProjectOfVersion,
  cleanupProjectDirectory,
  handleFileUpload,
  deleteProject,
};
export default {
  createProject,
  uploadProject,
  backupCurrentVersion,
  exportProject,
  backupProjectOfVersion,
  cleanupProjectDirectory,
  handleFileUpload,
  deleteProject,
};
