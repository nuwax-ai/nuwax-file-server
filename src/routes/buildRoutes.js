import express from "express";
import { startDevServer } from "../utils/build/startDevUtils.js";
import { restartDevServer } from "../utils/build/restartDevUtils.js";
import { keepAliveDevServer } from "../utils/build/keepAliveDevUtils.js";
import { stopDevServer } from "../utils/build/stopDevUtils.js";
import { buildProject } from "../utils/build/buildProjectUtils.js";
import { listRunningProcesses } from "../utils/build/processManager.js";
import BuildErrorParser from "../utils/error/buildErrorParser.js";
import { getDevLog } from "../utils/log/getDevLogUtils.js";
import logCacheManager from "../utils/log/logCacheManager.js";
import portPool from "../utils/buildArg/portPool.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
  ProcessError,
  asyncHandler,
} from "../utils/error/errorHandler.js";

const buildRouter = express.Router();

// 路由配置
const routes = [
  {
    path: "/start-dev",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      
      // 设置长超时时间：依赖安装可能需要较长时间
      req.setTimeout(600000); // 10分钟
      res.setTimeout(600000); // 10分钟

      const result = await startDevServer(req, String(projectId));
      res.json(result);
    }),
  },
  {
    path: "/keep-alive",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      const pid = req.query.pid;
      const port = req.query.port;
      const basePath = req.query.basePath;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!pid) {
        throw new ValidationError("进程ID不能为空", { field: "pid" });
      }
      if (!port) {
        throw new ValidationError("端口号不能为空", { field: "port" });
      }
      if (!basePath) {
        throw new ValidationError("basePath不能为空", { field: "basePath" });
      }

      const result = await keepAliveDevServer(
        req,
        String(projectId),
        pid,
        port,
        basePath,
      );
      res.json(result);
    }),
  },
  {
    path: "/build",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      // 设置长超时时间：构建可能需要较长时间
      req.setTimeout(600000); // 10分钟
      res.setTimeout(600000); // 10分钟

      const result = await buildProject(req, String(projectId));
      res.json(result);
    }),
  },
  {
    path: "/stop-dev",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      const pid = req.query.pid;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!pid) {
        throw new ValidationError("进程ID不能为空", { field: "pid" });
      }

      const result = await stopDevServer(req, String(projectId), pid, {
        strict: true,
      });
      
      res.json(result);
    }),
  },
  {
    path: "/restart-dev",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      // 设置长超时时间：重启包含依赖安装，可能需要较长时间
      req.setTimeout(600000); // 10分钟
      res.setTimeout(600000); // 10分钟

      const result = await restartDevServer(req, String(projectId));
      res.json(result);
    }),
  },
  {
    path: "/list-dev",
    method: "get",
    handler: (req, res) => {
      const list = listRunningProcesses();
      const result = { success: true, list };
      res.json(result);
    },
  },
  {
    path: "/parse-build-error",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { projectId, errorMessage } = req.body;

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }
      if (!errorMessage) {
        throw new ValidationError("错误消息不能为空", {
          field: "errorMessage",
        });
      }

      const errorParser = new BuildErrorParser();
      const userFriendlyMessage = errorParser.parseBuildError(
        errorMessage,
        String(projectId)
      );

      res.json({
        success: true,
        message: userFriendlyMessage,
      });
    }),
  },
  {
    path: "/get-dev-log",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const projectId = req.query.projectId;
      const startIndex = req.query.startIndex;
      const logType = req.query.logType || "temp";

      if (!projectId) {
        throw new ValidationError("项目ID不能为空", { field: "projectId" });
      }

      // 解析起始行号，默认为1
      const startLine = startIndex ? parseInt(startIndex, 10) : 1;
      if (isNaN(startLine) || startLine < 1) {
        throw new ValidationError("起始行号必须是正整数（从1开始）", {
          field: "startIndex",
          value: startIndex,
        });
      }

      const result = await getDevLog(String(projectId), startLine, logType);
      res.json(result);
    }),
  },
  {
    path: "/get-log-cache-stats",
    method: "get",
    handler: (req, res) => {
      const stats = logCacheManager.getStats();
      res.json({
        success: true,
        message: "获取日志缓存统计成功",
        stats,
      });
    },
  },
  {
    path: "/clear-all-log-cache",
    method: "get",
    handler: (req, res) => {
      logCacheManager.clear();
      res.json({
        success: true,
        message: "所有日志缓存已清理",
      });
    },
  },
  {
    path: "/port-pool-status",
    method: "get",
    handler: (req, res) => {
      const status = portPool.getStatus();
      res.json({
        success: true,
        message: "获取端口池状态成功",
        ...status,
      });
    },
  },
];

// 注册路由
routes.forEach((route) => {
  buildRouter[route.method](route.path, route.handler);
});

export default buildRouter;
