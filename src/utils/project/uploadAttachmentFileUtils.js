import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError, SystemError, FileError } from "../error/errorHandler.js";

/**
 * 上传附件文件到项目的 .attachments 目录
 * @param {string} projectId 项目ID
 * @param {Object} file multer文件对象
 * @param {string} fileName 可选，指定存储的文件名
 * @returns {Object} 包含fileName和relativePath的结果对象
 */
async function uploadAttachmentFile(projectId, file, fileName = null) {
  try {
    // 验证参数
    if (!projectId) {
      throw new ValidationError("项目ID不能为空", { field: "projectId" });
    }
    if (!file) {
      throw new ValidationError("文件不能为空", { field: "file" });
    }
    if (!file.path) {
      throw new ValidationError("文件路径无效", { field: "file.path" });
    }

    log(projectId, "INFO", "开始上传附件文件", {
      projectId,
      fileName,
      originalName: file.originalname,
      tempPath: file.path,
    });

    // 构建项目目录路径
    const projectDir = path.join(config.PROJECT_SOURCE_DIR, projectId);

    // 检查项目目录是否存在
    if (!fs.existsSync(projectDir)) {
      throw new ValidationError("项目不存在", { field: "projectId" });
    }

    // 构建附件目录路径
    const attachmentsDir = path.join(projectDir, ".attachments");

    // 创建附件目录（如果不存在）
    if (!fs.existsSync(attachmentsDir)) {
      await fs.promises.mkdir(attachmentsDir, { recursive: true });
      log(projectId, "INFO", "创建附件目录", { attachmentsDir });
    }

    // 确定最终的文件名
    let finalFileName;
    if (fileName) {
      finalFileName = fileName;
    } else {
      finalFileName = file.originalname;
    }

    let finalFilePath = path.join(attachmentsDir, finalFileName);

    // 检查文件是否已存在，如果存在则生成唯一文件名
    if (fs.existsSync(finalFilePath)) {
      const timestamp = Date.now();
      const randomSuffix = Math.round(Math.random() * 1e6);
      const fileExtension = path.extname(finalFileName);
      const baseName = path.basename(finalFileName, fileExtension);
      finalFileName = `${baseName}_${timestamp}_${randomSuffix}${fileExtension}`;
      finalFilePath = path.join(attachmentsDir, finalFileName);
    }

    // 移动文件从临时目录到附件目录
    // 使用copyFile + unlink代替rename，以支持跨设备（跨挂载点）的文件移动
    try {
      await fs.promises.rename(file.path, finalFilePath);
    } catch (renameError) {
      // 如果rename失败（通常是跨设备错误），则使用copyFile
      if (renameError.code === "EXDEV") {
        log(projectId, "INFO", "跨设备移动，使用复制方式", {
          tempPath: file.path,
          finalPath: finalFilePath,
        });
        await fs.promises.copyFile(file.path, finalFilePath);
        await fs.promises.unlink(file.path);
      } else {
        throw renameError;
      }
    }

    // 计算相对于项目目录的相对路径
    const relativePath = path.relative(projectDir, finalFilePath);

    log(projectId, "INFO", "附件文件上传成功", {
      projectId,
      originalName: file.originalname,
      fileName: finalFileName,
      relativePath,
      finalFilePath,
    });

    return {
      fileName: finalFileName,
      relativePath,
    };
  } catch (error) {
    // 如果出错，尝试清理临时文件
    if (file && file.path && fs.existsSync(file.path)) {
      try {
        await fs.promises.unlink(file.path);
        log(projectId, "INFO", "清理临时文件", { tempPath: file.path });
      } catch (cleanupError) {
        log(projectId, "WARN", "清理临时文件失败", {
          tempPath: file.path,
          error: cleanupError.message,
        });
      }
    }

    log(projectId, "ERROR", "上传附件文件失败", {
      projectId,
      originalName: file?.originalname,
      error: error.message,
    });

    // 重新抛出错误
    if (
      error instanceof ValidationError ||
      error instanceof SystemError ||
      error instanceof FileError
    ) {
      throw error;
    }

    throw new SystemError(`上传附件文件失败: ${error.message}`, {
      projectId,
      originalError: error.message,
    });
  }
}

export { uploadAttachmentFile };

