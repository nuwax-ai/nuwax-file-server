import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import {
  ValidationError,
  SystemError,
  ResourceError,
} from "../error/errorHandler.js";
import { extractZip } from "../common/zipUtils.js";
import { getFrameworkInfo } from "./frameworkDetectorUtils.js";

/**
 * 检查文件是否为二进制文件
 */
async function isBinaryFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    // 检查是否包含null字节
    if (buffer.includes(0)) {
      return true;
    }

    // 检查是否包含非ASCII字符
    const text = buffer.toString("utf-8");
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      if (
        charCode < 32 &&
        charCode !== 9 &&
        charCode !== 10 &&
        charCode !== 13
      ) {
        return true;
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * 检查文件是否为图片文件
 */
function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"].includes(
    ext
  );
}

/**
 * 递归遍历目录，获取所有文件信息
 * @param {string} dirPath 目录路径
 * @param {string} projectId 项目ID
 * @param {string} basePath 计算相对路径的基准路径，默认为 PROJECT_SOURCE_DIR + projectId
 * @returns {Array} 文件信息数组
 */
async function traverseDirectory(targetDir, basePath, projectId, proxyPath) {
  const files = [];
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });

  // 对文件条目进行排序，确保返回顺序一致
  // 先按类型排序（目录在前，文件在后），然后按名称排序
  entries.sort((a, b) => {
    // 如果一个是目录，一个是文件，目录排在前面
    if (a.isDirectory() && !b.isDirectory()) {
      return -1;
    }
    if (!a.isDirectory() && b.isDirectory()) {
      return 1;
    }
    // 如果类型相同，按名称排序（不区分大小写）
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);

    // 跳过隐藏文件（以 . 开头的文件）
    if (entry.name.startsWith(".")) {
      continue;
    }

    // 跳过指定的排除文件（优先使用内容专用排除列表）
    const contentExcludeFiles =
      config.CONTENT_TRAVERSE_EXCLUDE_FILES ||
      [];
    if (contentExcludeFiles.includes(entry.name)) {
      continue;
    }

    // 跳过指定的排除目录
    if (
      entry.isDirectory() &&
      config.TRAVERSE_EXCLUDE_DIRS.includes(entry.name)
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      // 递归处理子目录
      const subFiles = await traverseDirectory(fullPath, basePath, projectId, proxyPath);
      files.push(...subFiles);
    } else {
      // 处理文件
      try {
        const stats = await fs.promises.stat(fullPath);
        // 使用传入的 basePath 或默认的 PROJECT_SOURCE_DIR + projectId
        const referencePath =
          basePath || path.join(config.PROJECT_SOURCE_DIR, projectId);
        const relativePath = path.relative(referencePath, fullPath);

        const isBinary = await isBinaryFile(fullPath);
        
        // 判断是否为当前项目目录
        // const isCurrentProject = !basePath ||
        //   path.resolve(basePath) ===
        //     path.resolve(path.join(config.PROJECT_SOURCE_DIR, projectId));
        
        // 判断是否为历史版本目录
        // const isHistoryVersion = basePath &&
        //   path.resolve(basePath) ===
        //     path.resolve(path.join(config.PROJECT_SOURCE_DIR, "_his", projectId));

        // 生成文件代理URL
        const fileProxyUrl = `${proxyPath}/${relativePath}`;

        const fileInfo = {
          name: relativePath,
          binary: isBinary,
          sizeExceeded: stats.size > config.MAX_INLINE_FILE_SIZE_BYTES,
          contents: "",
          fileProxyUrl: fileProxyUrl,
        };

        // 如果文件大小未超过阈值
        if (!fileInfo.sizeExceeded) {
          if (fileInfo.binary) {
            // 二进制文件转换为base64
            if (isImageFile(fullPath)) {
              const buffer = fs.readFileSync(fullPath);
              fileInfo.contents = buffer.toString("base64");
            }
            // 非图片的二进制文件不返回内容
          } else {
            // 文本文件直接读取内容
            fileInfo.contents = fs.readFileSync(fullPath, "utf-8");
          }
        }

        files.push(fileInfo);
      } catch (error) {
        log(projectId, "WARN", `处理文件失败: ${fullPath} - ${error.message}`, {
          filePath: fullPath,
          error: error.message,
        });
      }
    }
  }

  return files;
}

/**
 * 获取项目内容
 * @param {string} projectPath 项目路径
 * @param {string} command 命令参数，如果为 'cpage_config' 则返回 cpage_config.json，否则过滤掉它
 * @returns {Object} 包含文件列表的结果对象
 */
async function getProjectContent(projectPath, command, proxyPath) {
  const projectId = path.basename(projectPath);

  try {
    log(projectId, "INFO", "开始获取项目内容", { projectPath, command });

    const files = await traverseDirectory(projectPath, null, projectId, proxyPath);

    // 根据 command 参数过滤 cpage_config.json
    let filteredFiles = files;
    if (command !== "cpage_config") {
      filteredFiles = files.filter((file) => file.name !== "cpage_config.json");
    }

    // 获取框架信息
    const frameworkInfo = getFrameworkInfo(projectPath);

    const result = {
      files: filteredFiles,
      ...frameworkInfo,
    };

    log(
      projectId,
      "INFO",
      `项目内容获取完成，共${filteredFiles.length}个文件`,
      {
        projectPath,
        fileCount: filteredFiles.length,
        command,
      }
    );

    return result;
  } catch (error) {
    log(projectId, "ERROR", `获取项目内容失败: ${error.message}`, {
      projectPath,
      originalError: error.message,
    });

    throw new SystemError(`获取项目内容失败: ${error.message}`, {
      projectPath,
      originalError: error.message,
    });
  }
}

/**
 * 根据版本号获取项目内容
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 代码版本
 * @param {string} command 命令参数，如果为 'cpage_config' 则返回 cpage_config.json，否则过滤掉它
 * @returns {Object} 包含文件列表的结果对象
 */
async function getProjectContentByVersion(projectId, codeVersion, command, proxyPath) {
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("代码版本必须是数字", { field: "codeVersion" });
  }

  // 构建备份文件路径
  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  const backupZipPath = path.join(backupDir, `${projectId}-v${versionNum}.zip`);

  // 检查备份文件是否存在
  if (!fs.existsSync(backupZipPath)) {
    throw new ResourceError(`版本 ${versionNum} 的备份文件不存在`, {
      projectId,
      codeVersion: versionNum,
      backupZipPath,
    });
  }

  // 创建临时解压目录
  const tempExtractDir = path.join(config.PROJECT_SOURCE_DIR, "_his", projectId);

  try {
    // 清理临时目录（如果存在）
    if (fs.existsSync(tempExtractDir)) {
      await fs.promises.rm(tempExtractDir, { recursive: true, force: true });
    }

    // 创建临时目录
    await fs.promises.mkdir(tempExtractDir, { recursive: true });

    log(projectId, "INFO", `开始解压版本 ${versionNum} 的备份文件`, {
      projectId,
      codeVersion: versionNum,
      backupZipPath,
      tempExtractDir,
    });

    // 解压备份文件到临时目录
    await extractZip(backupZipPath, tempExtractDir);

    log(projectId, "INFO", `版本 ${versionNum} 备份文件解压完成`, {
      projectId,
      codeVersion: versionNum,
      tempExtractDir,
    });

    // 获取项目内容 - 使用统一的遍历函数，传入解压目录作为基准路径
    const files = await traverseDirectory(
      tempExtractDir,
      tempExtractDir,
      projectId,
      proxyPath
    );

    // 根据 command 参数过滤 cpage_config.json
    let filteredFiles = files;
    if (command !== "cpage_config") {
      filteredFiles = files.filter((file) => file.name !== "cpage_config.json");
    }

    const result = { files: filteredFiles };

    log(projectId, "INFO", `版本 ${versionNum} 项目内容获取完成`, {
      projectId,
      codeVersion: versionNum,
      fileCount: result.files ? result.files.length : 0,
      command,
    });

    return result;
  } finally {
    // 清理临时目录
    try {
      if (fs.existsSync(tempExtractDir)) {
        await fs.promises.rm(tempExtractDir, { recursive: true, force: true });
        log(projectId, "INFO", `临时目录已清理: ${tempExtractDir}`, {
          projectId,
          codeVersion: versionNum,
        });
      }
    } catch (cleanupError) {
      log(projectId, "WARN", `清理临时目录失败: ${cleanupError.message}`, {
        projectId,
        codeVersion: versionNum,
        tempExtractDir,
        error: cleanupError.message,
      });
    }
  }
}

export {
  getProjectContent,
  getProjectContentByVersion,
  traverseDirectory,
  isBinaryFile,
  isImageFile,
};

