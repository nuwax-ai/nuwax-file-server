import express from "express";
import multer from "multer";
import { asyncHandler, ValidationError } from "../utils/error/errorHandler.js";
import codeService from "../service/codeService.js";
import { log } from "../utils/log/logUtils.js";
import config from "../appConfig/index.js";

const codeRouter = express.Router();

// 配置multer用于内存存储（适合小文件）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.UPLOAD_SINGLE_FILE_SIZE_BYTES, // 从环境变量读取文件大小限制
  },
});

// 路由配置
const routes = [
  {
    path: "/specified-files-update",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, files } = req.body || {};
      log(projectId, "INFO", "部分文件更新", {
        projectId,
        codeVersion,
        filesCount: files ? files.length : 0,
      });

      // 解码文件内容（前端使用 encodeURIComponent 编码）
      if (files && Array.isArray(files)) {
        files.forEach((fileOp) => {
          if (!fileOp) return;

          // 只要有 contents 就解码
          if (typeof fileOp.contents === "string" && fileOp.contents) {
            try {
              fileOp.contents = decodeURIComponent(fileOp.contents);
            } catch (err) {
              log(projectId, "WARN", "解码文件内容失败", {
                fileName: fileOp.path,
                error: err.message,
              });
              // 如果解码失败，保持原样（可能前端没有编码）
            }
          }
        });
      }

      const result = await codeService.specifiedFilesUpdate(
        String(projectId),
        String(codeVersion),
        files,
        req
      );
      res.status(200).json(result);
    }),
  },
  {
    path: "/all-files-update",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, files, basePath, pid } = req.body || {};
      log(projectId, "INFO", "提交文件", {
        projectId,
        codeVersion,
        basePath,
        pid,
      });

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (codeVersion === undefined || codeVersion === null) {
        throw new ValidationError("codeVersion不能为空", {
          field: "codeVersion",
        });
      }
      if (!Array.isArray(files)) {
        throw new ValidationError("files必须是数组", { field: "files" });
      }

      // 解码文件内容（前端使用 encodeURIComponent 编码）
      if (files && Array.isArray(files)) {
        files.forEach((file) => {
          if (file && typeof file.contents === "string" && file.contents) {
            try {
              file.contents = decodeURIComponent(file.contents);
            } catch (err) {
              log(projectId, "WARN", "解码文件内容失败", {
                fileName: file.name,
                error: err.message,
              });
              // 如果解码失败，保持原样（可能前端没有编码）
            }
          }
        });
      }

      const result = await codeService.allFilesUpdate(
        String(projectId),
        String(codeVersion),
        files,
        req
      );
      res.status(200).json(result);
    }),
  },
  {
    path: "/upload-single-file",
    method: "post",
    middleware: upload.single("file"),
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, filePath } = req.body || {};
      const file = req.file; // 从 multer 中间件获取上传的文件

      log(projectId, "INFO", "上传单个文件", {
        projectId,
        codeVersion,
        filePath,
      });

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (codeVersion === undefined || codeVersion === null) {
        throw new ValidationError("codeVersion不能为空", {
          field: "codeVersion",
        });
      }
      if (!file) {
        throw new ValidationError("文件不能为空", { field: "file" });
      }
      if (!filePath || typeof filePath !== "string") {
        throw new ValidationError("文件路径不能为空", { field: "filePath" });
      }

      // 记录接收到的文件信息，用于调试
      log(projectId, "INFO", "接收到的文件信息", {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        bufferLength: file.buffer ? file.buffer.length : 0,
        bufferIsBuffer: Buffer.isBuffer(file.buffer),
      });

      // 构建文件对象，统一使用buffer（multer memoryStorage对所有文件类型都提供buffer）
      const fileObj = {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      };

      const result = await codeService.uploadSingleFile(
        String(projectId),
        String(codeVersion),
        fileObj,
        filePath,
        req
      );
      res.status(200).json(result);
    }),
  },
  {
    path: "/rollback-version",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, codeVersion, rollbackTo } = req.body || {};
      log(projectId, "INFO", "回滚版本", {
        projectId,
        codeVersion,
        rollbackTo,
      });

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (codeVersion === undefined || codeVersion === null) {
        throw new ValidationError("codeVersion不能为空", {
          field: "codeVersion",
        });
      }
      if (rollbackTo === undefined || rollbackTo === null) {
        throw new ValidationError("rollbackTo不能为空", {
          field: "rollbackTo",
        });
      }

      const result = await codeService.rollbackVersion(
        String(projectId),
        String(codeVersion),
        String(rollbackTo),
        req
      );
      res.status(200).json(result);
    }),
  },
];

// 注册路由
routes.forEach((route) => {
  if (route.middleware) {
    // 如果有中间件，先注册中间件再注册处理器
    codeRouter[route.method](route.path, route.middleware, route.handler);
  } else {
    // 没有中间件，直接注册处理器
    codeRouter[route.method](route.path, route.handler);
  }
});

export default codeRouter;
