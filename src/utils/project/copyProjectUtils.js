import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { copyDirectoryFiltered } from "./backupUtils.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
} from "../error/errorHandler.js";
import { createPnpmNpmrc } from "../common/npmrcUtils.js";

/**
 * 复制项目
 * @param {string} sourceProjectId - 源项目ID
 * @param {string} targetProjectId - 目标项目ID
 * @returns {Promise<Object>} 复制结果
 */
async function copyProject(sourceProjectId, targetProjectId) {
  if (!sourceProjectId) {
    throw new ValidationError("Source project ID cannot be empty", {field: "sourceProjectId",});
  }
  if (!targetProjectId) {
    throw new ValidationError("Target project ID cannot be empty", {field: "targetProjectId",});
  }

  const projectSourceDir = config.PROJECT_SOURCE_DIR;
  const sourceProjectPath = path.join(projectSourceDir, sourceProjectId);
  const targetProjectPath = path.join(projectSourceDir, targetProjectId);

  // 检查源项目是否存在
  if (!fs.existsSync(sourceProjectPath)) {
    throw new BusinessError(`Source project ${sourceProjectId} does not exist`, {
      sourceProjectId,
      sourceProjectPath,
    });
  }

  // 检查目标项目是否已存在
  if (fs.existsSync(targetProjectPath)) {
    throw new BusinessError(`Target project ${targetProjectId} already exists`, {
      targetProjectId,
      targetProjectPath,
    });
  }

  try {
    log(targetProjectId, "INFO", `Start copying project from ${sourceProjectId} to ${targetProjectId}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 创建目标项目目录
    fs.mkdirSync(targetProjectPath, { recursive: true });
    log(targetProjectId, "INFO", `Target project directory created successfully: ${targetProjectPath}`, {
      targetProjectId,
    });

    // 复制源项目内容到目标项目目录
    const entries = await fs.promises.readdir(sourceProjectPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const srcPath = path.join(sourceProjectPath, entry.name);
      const destPath = path.join(targetProjectPath, entry.name);

      if (entry.isDirectory()) {
        await fs.promises.mkdir(destPath, { recursive: true });
        // 使用 copyDirectoryFiltered 来复制目录内容，排除不必要的文件
        await copyDirectoryFiltered(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(srcPath, destPath);
      }
    }

    log(targetProjectId, "INFO", `Project copied successfully: ${targetProjectId}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 为目标项目创建 .npmrc 配置文件
    await createPnpmNpmrc(targetProjectPath, targetProjectId);

    return {
      success: true,
      message: `Project ${sourceProjectId} successfully copied to ${targetProjectId}`,
      sourceProjectId,
      targetProjectId,
      targetProjectPath,
    };
  } catch (error) {
    log(targetProjectId, "ERROR", `Copy project failed: ${error.message}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 失败时清理目标项目目录
    if (fs.existsSync(targetProjectPath)) {
      try {
        await fs.promises.rm(targetProjectPath, { recursive: true, force: true });
        log(targetProjectId, "INFO", "Copy failed, target project directory cleaned", {
          targetProjectId,
        });
      } catch (cleanupError) {
        log(targetProjectId, "ERROR", `Clean target project directory failed: ${cleanupError.message}`, {
          targetProjectId,
          originalError: cleanupError.message,
        });
      }
    }

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`Copy project failed: ${error.message}`, {
        sourceProjectId,
        targetProjectId,
        sourceProjectPath,
        targetProjectPath,
        originalError: error.message,
      });
    }

    throw error;
  }
}

export { copyProject };


