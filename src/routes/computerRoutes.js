import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { ValidationError, asyncHandler } from "../utils/error/errorHandler.js";
import { log } from "../utils/log/logUtils.js";
import config from "../appConfig/index.js";
import { createWorkspace, pushSkillsToWorkspace, } from "../utils/computer/computerUtils.js";
import {
  getFileList,
  updateFiles,
  uploadFile,
  uploadFiles,
  downloadAllFiles,
} from "../utils/computer/computerFileUtils.js";

const computerRouter = express.Router();

// 使用磁盘存储，便于后续解压 zip
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        // 将临时上传目录放到 COMPUTER_WORKSPACE_DIR/<userId>/<cId>/.tmp 下
        const baseDir = config.COMPUTER_WORKSPACE_DIR;
        if (!baseDir) {
          return cb(
            new Error("COMPUTER_WORKSPACE_DIR 未配置，无法确定上传临时目录")
          );
        }

        const userId = req.body?.userId || "unknown";
        const cId = req.body?.cId || "unknown";
        const tmpUploadDir = path.join(
          baseDir,
          String(userId),
          String(cId),
          ".tmp"
        );
        if (!fs.existsSync(tmpUploadDir)) {
          fs.mkdirSync(tmpUploadDir, { recursive: true });
        }

        cb(null, tmpUploadDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".zip";
      const baseName = path.basename(file.originalname, ext);
      const uniqueSuffix = `${Date.now()}_${Math.round(Math.random() * 1e6)}`;
      cb(null, `${baseName}_${uniqueSuffix}${ext}`);
    },
  }),
  limits: {
    fileSize: config.UPLOAD_MAX_FILE_SIZE_BYTES,
  },
});

// Multer 错误处理中间件（复用通用模式）
function multerErrorHandler(err, req, res, next) {
  if (err && err.name === "MulterError") {
    return next(err);
  }
  if (err && (err.name === "ValidationError" || err instanceof ValidationError)) {
    return next(err);
  }
  next(err);
}

const routes = [
  {
    path: "/create-workspace",
    method: "post",
    middleware: upload.single("file"),
    handler: asyncHandler(async (req, res) => {
      const { userId, cId } = req.body || {};
      const file = req.file || null;
      const logId = `computer:${userId}:${cId}`;

      log(logId, "INFO", "创建工作空间请求", {
        userId,
        cId,
        hasFile: !!file,
        fileName: file?.originalname,
        fileSize: file?.size,
      });

      const result = await createWorkspace(userId, cId, file);

      res.status(200).json({
        success: true,
        ...result,
      });
    }),
  },

  {
    path: "/push-skills-to-workspace",
    method: "post",
    middleware: upload.single("file"),
    handler: asyncHandler(async (req, res) => {
      const { userId, cId } = req.body || {};
      const file = req.file || null;
      const logId = `computer:${userId}:${cId}`;

      log(logId, "INFO", "推送技能到工作空间请求", {
        userId,
        cId,
        hasFile: !!file,
        fileName: file?.originalname,
        fileSize: file?.size,
      });

      const result = await pushSkillsToWorkspace(userId, cId, file);

      res.status(200).json({
        success: true,
        ...result,
      });
    }),
  },

  {
    path: "/get-file-list",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { userId, cId, proxyPath } = req.query;
      const result = await getFileList(userId, cId, proxyPath);
      res.status(200).json({ success: true, ...result });
    }),
  },
  {
    path: "/files-update",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { userId, cId, files } = req.body || {};
      const logId = `computer:${userId}:${cId}`;
      log(logId, "INFO", "文件更新", {
        userId,
        cId,
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
              log(logId, "WARN", "解码文件内容失败", {
                fileName: fileOp.name,
                error: err.message,
              });
              // 如果解码失败，保持原样（可能前端没有编码）
            }
          }
        });
      }

      const result = await updateFiles(userId, cId, files);
      res.status(200).json(result);
    }),
  },
  {
    path: "/upload-file",
    method: "post",
    middleware: upload.single("file"),
    handler: asyncHandler(async (req, res) => {
      const { userId, cId, filePath } = req.body || {};
      const file = req.file; // 从 multer 中间件获取上传的文件
      const logId = `computer:${userId}:${cId}`;

      log(logId, "INFO", "上传单个文件", {
        userId,
        cId,
        filePath,
      });

      // 从磁盘读取文件内容（diskStorage 模式下 file.buffer 不存在）
      const fileBuffer = await fs.promises.readFile(file.path);

      // 构建文件对象，支持文本和二进制文件
      const fileObj = {
        buffer: fileBuffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      };

      try {
        const result = await uploadFile(userId, cId, fileObj, filePath);
        res.status(200).json(result);
      } finally {
        // 清理临时文件
        if (fs.existsSync(file.path)) {
          await fs.promises.unlink(file.path);
        }
      }
    }),
  },
  {
    path: "/upload-files",
    method: "post",
    middleware: upload.array("files"),
    handler: asyncHandler(async (req, res) => {
      const { userId, cId, filePaths } = req.body || {};
      const files = req.files || []; // 从 multer 中间件获取上传的文件数组
      const logId = `computer:${userId}:${cId}`;

      // 标准化 filePaths 为数组格式，兼容单文件上传时可能传入字符串的情况
      const normalizedFilePaths = Array.isArray(filePaths)
        ? filePaths
        : typeof filePaths === "string"
        ? [filePaths]
        : filePaths;

      log(logId, "INFO", "批量上传文件请求", {
        userId,
        cId,
        filesCount: files.length,
        filePathsCount: Array.isArray(normalizedFilePaths) ? normalizedFilePaths.length : 0,
      });

      // 从磁盘读取所有文件内容（diskStorage 模式下 file.buffer 不存在）
      const fileObjects = [];
      const tempFilePaths = [];

      try {
        for (const file of files) {
          tempFilePaths.push(file.path);
          const fileBuffer = await fs.promises.readFile(file.path);
          fileObjects.push({
            buffer: fileBuffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          });
        }

        // 调用批量上传工具函数
        const result = await uploadFiles(userId, cId, fileObjects, normalizedFilePaths);
        res.status(200).json(result);
      } finally {
        // 清理所有临时文件
        for (const tempPath of tempFilePaths) {
          if (fs.existsSync(tempPath)) {
            try {
              await fs.promises.unlink(tempPath);
            } catch (error) {
              log(logId, "WARN", "清理临时文件失败", {
                tempPath,
                error: error.message,
              });
            }
          }
        }
      }
    }),
  },
  {
    path: "/download-all-files",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { userId, cId } = req.query || {};
      const logId = `computer:${userId}:${cId}`;

      log(logId, "INFO", "下载全部文件请求", {
        userId,
        cId,
      });

      const { archive, zipFileName } = await downloadAllFiles(
        userId,
        cId
      );

      res.setHeader("Content-Type", "application/zip");
      // 兼容中文文件名
      const encodedName = encodeURIComponent(zipFileName);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
      );

      archive.on("error", (err) => {
        // 让全局错误处理中间件接管
        res.destroy(err);
      });

      archive.pipe(res);
      archive.finalize();
    }),
  },
];

routes.forEach((route) => {
  if (route.middleware) {
    // 如果有中间件，先注册中间件再注册处理器
    computerRouter[route.method](route.path, route.middleware, route.handler);
  } else if (route.customHandler) {
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
    computerRouter[route.method](route.path, ...middlewares);
  } else {
    // 普通路由直接注册处理器
    computerRouter[route.method](route.path, route.handler);
  }
});

export default computerRouter;


