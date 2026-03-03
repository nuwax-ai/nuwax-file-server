import express from "express";
import JSONbig from "json-bigint";
import swaggerUi from "swagger-ui-express";
import swaggerSpecs from "./config/swagger.js";
import config from "./appConfig/index.js";
import { log, logger } from "./utils/log/logUtils.js";
import logCacheManager from "./utils/log/logCacheManager.js";
import { errorHandler, notFoundHandler } from "./utils/error/errorHandler.js";
import router from "./routes/router.js";
import { cleanupInitProjectOnStartup } from "./utils/project/initProjectCleanupUtils.js";
import { startScheduler, stopScheduler } from "./scheduler/pnpmPruneScheduler.js";
import path from "path";

const app = express();

// 解析 JSON 请求体，使用 json-bigint 处理大整数
app.use(
  express.json({
    limit: config.REQUEST_BODY_LIMIT,
    reviver: (key, value) => {
      // 对于大整数，保持为字符串
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        return value.toString();
      }
      return value;
    },
  })
);

// 解析 URL 编码的请求体
app.use(
  express.urlencoded({ extended: true, limit: config.REQUEST_BODY_LIMIT })
);

// 使用日志中间件
app.use(logger);

// 帮助方法：对 URL 路径做尽可能多次解码（处理客户端双重编码等情况）
const safeDecodePath = (p) => {
  let prev = p;
  try {
    // 连续解码直到不再变化或解码失败
    while (true) {
      const decoded = decodeURIComponent(prev);
      if (decoded === prev) break;
      prev = decoded;
    }
  } catch (e) {
    // 非法编码时直接返回当前结果，避免抛错
  }
  return prev;
};

// 静态文件服务：提供页面工程文件的直接访问
// 格式1: /api/page/static/<projectId>/<path/to/file> -> config.PROJECT_SOURCE_DIR
app.use("/api/page/static/:projectId", (req, res, next) => {
  const { projectId } = req.params;
  // req.path 是挂载点之后的路径，形如 "/path/to/file"
  let filePath = req.path || "/";
  if (!projectId || filePath === "/") {
    return res.status(404).send("Not Found");
  }

  // 设置 CORS 头，允许跨域访问静态资源（必须在 sendFile 之前设置）
  const origin = req.headers.origin;
  // 如果请求包含 Origin，使用具体的 origin；否则使用 *
  // 注意：当使用 credentials 时，不能使用 *，必须使用具体的 origin
  const allowOrigin = origin || "*";
  res.header("Access-Control-Allow-Origin", allowOrigin);
  res.header("Access-Control-Allow-Methods", "HEAD,GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Fragment");
  res.header("Access-Control-Expose-Headers", "Content-Type");
  if (origin) {
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Vary", "Origin");
  }

  // 处理 OPTIONS 预检请求
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  // 去掉前导 "/"，转成相对路径
  filePath = filePath.replace(/^\/+/, "");
  // 对可能被多次编码的路径做安全解码（支持中文等）
  const decodedPath = safeDecodePath(filePath);

  const fullPath = path.join(config.PROJECT_SOURCE_DIR, projectId, decodedPath);
  // 使用 headers 选项确保 CORS 头被保留
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "HEAD,GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Fragment",
  };
  if (origin) {
    corsHeaders["Access-Control-Allow-Credentials"] = "true";
    corsHeaders["Vary"] = "Origin";
  }

  return res.sendFile(
    fullPath,
    {
      dotfiles: "ignore",
      headers: corsHeaders,
    },
    (err) => {
      if (err) return next();
    }
  );
});

// 静态文件服务：提供桌面文件的直接访问
// 格式2: /api/computer/static/<userId>/<cId>/<path/to/file> -> config.COMPUTER_WORKSPACE_DIR
app.use("/api/computer/static/:userId/:cId", (req, res, next) => {
  const { userId, cId } = req.params;
  let filePath = req.path || "/";

  if (!userId || !cId || filePath === "/") {
    return res.status(404).send("Not Found");
  }

  // 设置 CORS 头，允许跨域访问静态资源（必须在 sendFile 之前设置）
  const origin = req.headers.origin;
  // 如果请求包含 Origin，使用具体的 origin；否则使用 *
  // 注意：当使用 credentials 时，不能使用 *，必须使用具体的 origin
  const allowOrigin = origin || "*";
  res.header("Access-Control-Allow-Origin", allowOrigin);
  res.header("Access-Control-Allow-Methods", "HEAD,GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control");
  res.header("Access-Control-Expose-Headers", "Content-Type");
  if (origin) {
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Vary", "Origin");
  }

  // 处理 OPTIONS 预检请求
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  // 去掉前导 "/"，确保是相对路径
  filePath = filePath.replace(/^\/+/, "");
  // 安全多次解码，解决 "%25E4%25BD%25A0" 这种双重编码的中文
  const decodedPath = safeDecodePath(filePath);

  const fullPath = path.join(
    config.COMPUTER_WORKSPACE_DIR,
    userId,
    cId,
    decodedPath
  );

  // 使用 headers 选项确保 CORS 头被保留
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "HEAD,GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control",
  };
  if (origin) {
    corsHeaders["Access-Control-Allow-Credentials"] = "true";
    corsHeaders["Vary"] = "Origin";
  }

  return res.sendFile(
    fullPath,
    {
      dotfiles: "ignore",
      headers: corsHeaders,
    },
    (err) => {
      if (err) return next();
    }
  );
});

// Swagger API 文档
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpecs, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "nuwax-file-server API 文档",
  })
);

// 使用路由配置
app.use(router);

// 404处理中间件（必须在所有路由之后）
app.use(notFoundHandler);

// 全局错误处理中间件（必须在最后）
app.use(errorHandler);

// 启动服务器
const server = app.listen(config.PORT, async () => {
  log(
    "default",
    "INFO",
    `Server is running on port ${config.PORT} (${config.NODE_ENV} mode)`
  );

  // 项目启动时清理初始化项目文件夹,目的是更新初始化包时,只需要更新zip包
  await cleanupInitProjectOnStartup(config);

  // 启动 pnpm prune 定时任务
  try {
    startScheduler();
  } catch (error) {
    log("default", "ERROR", `pnpm prune 定时任务启动失败: ${error.message}`);
  }
});

// 设置服务器超时时间 10 分钟（默认是 120 秒）
// 对于长时间运行的操作（如依赖安装、构建）是必要的
server.timeout = 600000; // 10 分钟
server.keepAliveTimeout = 610000; // 略大于 timeout
server.headersTimeout = 620000; // 略大于 keepAliveTimeout

// 优雅退出处理
const gracefulShutdown = (signal) => {
  log("default", "INFO", `收到 ${signal} 信号，准备优雅退出...`);
  
  // 停止定时任务
  stopScheduler();
  
  // 清理日志缓存管理器（清理定时器）
  try {
    logCacheManager.destroy();
    log("default", "INFO", "日志缓存管理器已清理");
  } catch (error) {
    log("default", "ERROR", `清理日志缓存管理器失败: ${error.message}`);
  }
  
  // 关闭服务器
  server.close(() => {
    log("default", "INFO", "服务器已关闭");
    process.exit(0);
  });

  // 如果 30 秒后还未退出，强制退出
  setTimeout(() => {
    log("default", "ERROR", "强制退出（超时）");
    process.exit(1);
  }, 30000);
};

// 监听退出信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
