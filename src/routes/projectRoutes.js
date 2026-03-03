import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import iconv from "iconv-lite";
import projectService from "../service/projectService.js";
import {
  getProjectContent,
  getProjectContentByVersion,
} from "../utils/project/getContentUtils.js";
import { uploadAttachmentFile } from "../utils/project/uploadAttachmentFileUtils.js";
import { copyProject } from "../utils/project/copyProjectUtils.js";
import config from "../appConfig/index.js";
import { log } from "../utils/log/logUtils.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
  FileError,
  asyncHandler,
} from "../utils/error/errorHandler.js";

const projectRouter = express.Router();

// 配置multer用于文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // 先保存到临时目录，后续在路由处理器中移动到项目目录
    const uploadDir = path.join(config.UPLOAD_PROJECT_DIR, "temp");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (config.UPLOAD_ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      // 将文件类型错误转换为 ValidationError
      cb(
        new ValidationError("文件类型不被允许", {
          fileExtension: ext,
          allowedExtensions: config.UPLOAD_ALLOWED_EXTENSIONS,
        }),
        false
      );
    }
  },
  limits: {
    fileSize: config.UPLOAD_MAX_FILE_SIZE_BYTES,
  },
});

// 为上传附件文件创建独立的multer配置，支持更多文件类型
const attachmentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(config.UPLOAD_PROJECT_DIR, "temp");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

// 允许的附件文件扩展名（常见文档、图片、PDF等）
const ATTACHMENT_ALLOWED_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
];

const uploadAttachment = multer({
  storage: attachmentStorage,
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ATTACHMENT_ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      // 将文件类型错误转换为 ValidationError
      cb(
        new ValidationError("附件文件类型不被允许", {
          fileExtension: ext,
          allowedExtensions: ATTACHMENT_ALLOWED_EXTENSIONS,
        }),
        false
      );
    }
  },
  limits: {
    fileSize: config.UPLOAD_MAX_FILE_SIZE_BYTES,
  },
});

// 文件名解码中间件，用于正确处理中文文件名
function decodeFileNameMiddleware(req, res, next) {
  if (req.file && req.file.originalname) {
    try {
      // 保存原始文件名用于日志
      const beforeDecode = req.file.originalname;
      // 尝试将文件名从 latin1 解码为 UTF-8
      // 这是一个常见的编码问题，当文件名包含中文字符时
      const decodedName = iconv.decode(
        Buffer.from(req.file.originalname, "latin1"),
        "utf8"
      );
      req.file.originalname = decodedName;
      log("system", "INFO", "文件名解码成功", {
        before: beforeDecode,
        after: decodedName,
      });
    } catch (err) {
      // 如果解码失败，记录日志但继续处理
      log("system", "WARN", "文件名解码失败", {
        originalName: req.file.originalname,
        error: err.message,
      });
    }
  }
  next();
}

// 路由配置
const routes = [
  {
    path: "/create-project",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId } = req.body;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      const result = await projectService.createProject(String(projectId));
      res.status(200).json(result);
    }),
  },
  {
    path: "/upload-project",
    method: "post",
    handler: upload.single("file"),
    customHandler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, pid, basePath } = req.body;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!codeVersion) {
        throw new ValidationError("代码版本不能为空", { field: "codeVersion" });
      }
      if (!req.file) {
        throw new ValidationError("请上传压缩包文件", { field: "zipFile" });
      }

      // 处理文件上传（移动到项目目录）
      const uploadResult = await projectService.handleFileUpload(
        String(projectId),
        codeVersion,
        req.file
      );

      // 更新req.file.path为新的路径
      req.file.path = uploadResult.filePath;

      try {
        const result = await projectService.uploadProject(
          String(projectId),
          req.file.path,
          req,
          codeVersion,
          pid,
          basePath
        );
        res.status(200).json(result);
      } catch (err) {
        // 失败时清理项目目录（uploadProject内部已经处理，这里作为额外保障）
        try {
          await projectService.cleanupProjectDirectory(String(projectId));
        } catch (cleanupErr) {
          log(projectId, "ERROR", "路由层清理项目目录失败", {
            projectId,
            error: cleanupErr.message,
          });
        }

        // 清理上传的文件
        if (req.file && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (cleanupErr) {
            log(projectId, "ERROR", "清理上传文件失败", {
              projectId,
              error: cleanupErr.message,
            });
          }
        }
        throw err; // 重新抛出错误，让全局错误处理器处理
      }
    }),
  },
  {
    path: "/get-project-content",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { projectId, command, proxyPath } = req.query;
      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      // 构建项目路径
      const projectPath = path.join(config.PROJECT_SOURCE_DIR, projectId);

      // 检查项目目录是否存在
      if (!fs.existsSync(projectPath)) {
        throw new ValidationError("项目不存在", { field: "projectId" });
      }

      // 获取项目内容
      try {
        const result = await getProjectContent(
          projectPath,
          command,
          proxyPath
        );
        res.status(200).json({ success: true, ...result });
      } catch (err) {
        const message = err?.message || "查询失败";
        res.status(500).json({ success: false, message });
      }
    }),
  },
  {
    path: "/get-project-content-by-version",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, command, proxyPath } = req.query;
      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!codeVersion) {
        throw new ValidationError("代码版本不能为空", { field: "codeVersion" });
      }
      try {
        const result = await getProjectContentByVersion(
          String(projectId),
          codeVersion,
          command,
          proxyPath
        );
        res.status(200).json({ success: true, ...result });
      } catch (err) {
        const message = err?.message || "查询失败";
        res.status(500).json({ success: false, message });
      }
    }),
  },
  {
    path: "/backup-current-version",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion } = req.body;

      const result = await projectService.backupCurrentVersion(
        String(projectId),
        codeVersion
      );
      res.status(200).json({ success: true, ...result });
    }),
  },
  {
    path: "/export-project",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, exportType, config } = req.body;

      const result = await projectService.exportProject(
        String(projectId),
        codeVersion,
        exportType,
        config
      );

      // 检查zip文件是否存在
      if (!fs.existsSync(result.zipPath)) {
        throw new SystemError("导出的zip文件不存在", {
          zipPath: result.zipPath,
        });
      }

      // 设置响应头，指定文件下载
      const fileName = path.basename(result.zipPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );

      res.sendFile(result.zipPath, (err) => {
        if (err) {
          log(projectId, "ERROR", "发送zip文件失败", {
            projectId,
            error: err.message,
          });
          if (!res.headersSent) {
            res.status(500).json({ success: false, message: "文件发送失败" });
          }
        } else {
          log(projectId, "INFO", "zip文件发送成功", {
            projectId,
            zipPath: result.zipPath,
          });
        }
      });
    }),
  },

  {
    path: "/delete-project",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { projectId, pid } = req.query;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      const result = await projectService.deleteProject(
        String(projectId),
        pid,
        req
      );
      res.status(200).json(result);
    }),
  },
  {
    path: "/upload-attachment-file",
    method: "post",
    handler: uploadAttachment.single("file"),
    decodeMiddleware: decodeFileNameMiddleware,
    customHandler: asyncHandler(async (req, res) => {
      const { projectId, fileName } = req.body;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!req.file) {
        throw new ValidationError("请上传文件", { field: "file" });
      }

      try {
        const result = await uploadAttachmentFile(
          String(projectId),
          req.file,
          fileName
        );
        res.status(200).json({ success: true, ...result });
      } catch (err) {
        // 失败时清理上传的文件
        if (req.file && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (cleanupErr) {
            log(projectId, "ERROR", "清理上传文件失败", {
              projectId,
              error: cleanupErr.message,
            });
          }
        }
        throw err; // 重新抛出错误，让全局错误处理器处理
      }
    }),
  },
  {
    path: "/copy-project",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { sourceProjectId, targetProjectId } = req.body;

      if (!sourceProjectId) {
        throw new ValidationError("源项目ID不能为空", {
          field: "sourceProjectId",
        });
      }
      if (!targetProjectId) {
        throw new ValidationError("目标项目ID不能为空", {
          field: "targetProjectId",
        });
      }

      const result = await copyProject(
        String(sourceProjectId),
        String(targetProjectId)
      );
      res.status(200).json(result);
    }),
  },
];

// Multer错误处理中间件
function multerErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    // Multer错误会被全局错误处理器捕获并处理
    return next(err);
  }
  // 如果是 ValidationError，直接传递给错误处理器
  if (err.name === "ValidationError" || err instanceof ValidationError) {
    return next(err);
  }
  next(err);
}

// 注册路由
routes.forEach((route) => {
  if (route.customHandler) {
    // 对于有自定义处理器的路由
    const middlewares = [];

    // 先添加multer中间件
    if (route.handler) {
      middlewares.push(route.handler);
    }

    // 再添加文件名解码中间件（如果有）
    if (route.decodeMiddleware) {
      middlewares.push(route.decodeMiddleware);
    }

    // 添加错误处理中间件
    middlewares.push(multerErrorHandler);

    // 最后添加自定义处理器
    middlewares.push(route.customHandler);

    // 注册所有中间件
    projectRouter[route.method](route.path, ...middlewares);
  } else {
    // 普通路由直接注册处理器
    projectRouter[route.method](route.path, route.handler);
  }
});

export default projectRouter;
