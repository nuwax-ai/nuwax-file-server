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
    throw new ValidationError("源项目ID不能为空", {field: "sourceProjectId",});
  }
  if (!targetProjectId) {
    throw new ValidationError("目标项目ID不能为空", {field: "targetProjectId",});
  }

  const projectSourceDir = config.PROJECT_SOURCE_DIR;
  const sourceProjectPath = path.join(projectSourceDir, sourceProjectId);
  const targetProjectPath = path.join(projectSourceDir, targetProjectId);

  // 检查源项目是否存在
  if (!fs.existsSync(sourceProjectPath)) {
    throw new BusinessError(`源项目 ${sourceProjectId} 不存在`, {
      sourceProjectId,
      sourceProjectPath,
    });
  }

  // 检查目标项目是否已存在
  if (fs.existsSync(targetProjectPath)) {
    throw new BusinessError(`目标项目 ${targetProjectId} 已存在`, {
      targetProjectId,
      targetProjectPath,
    });
  }

  try {
    log(targetProjectId, "INFO", `开始复制项目从 ${sourceProjectId} 到 ${targetProjectId}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 创建目标项目目录
    fs.mkdirSync(targetProjectPath, { recursive: true });
    log(targetProjectId, "INFO", `目标项目目录创建成功: ${targetProjectPath}`, {
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

    log(targetProjectId, "INFO", `项目复制成功: ${targetProjectId}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 为目标项目创建 .npmrc 配置文件
    await createPnpmNpmrc(targetProjectPath, targetProjectId);

    return {
      success: true,
      message: `项目 ${sourceProjectId} 已成功复制到 ${targetProjectId}`,
      sourceProjectId,
      targetProjectId,
      targetProjectPath,
    };
  } catch (error) {
    log(targetProjectId, "ERROR", `复制项目失败: ${error.message}`, {
      sourceProjectId,
      targetProjectId,
    });

    // 失败时清理目标项目目录
    if (fs.existsSync(targetProjectPath)) {
      try {
        await fs.promises.rm(targetProjectPath, { recursive: true, force: true });
        log(targetProjectId, "INFO", "复制失败，目标项目目录已清理", {
          targetProjectId,
        });
      } catch (cleanupError) {
        log(targetProjectId, "ERROR", `清理目标项目目录失败: ${cleanupError.message}`, {
          targetProjectId,
          originalError: cleanupError.message,
        });
      }
    }

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`复制项目失败: ${error.message}`, {
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


