import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";
import config from "../../appConfig/index.js";
import { BusinessError, FileError, ResourceError } from "../error/errorHandler.js";
import {
  isProjectStarting,
  addStartingProject,
  removeStartingProject,
  startDev_NonBlocking,
} from "./processManager.js";
import ERROR_CODES from "../error/errorCodes.js";
import { stopDevServer } from "./stopDevUtils.js";
import { removeNodeModules } from "../buildDependency/dependencyManager.js";
import { createPnpmNpmrc } from "../common/npmrcUtils.js";

//项目源文件所在目录
const projectSourceDir = config.PROJECT_SOURCE_DIR;

// 重启开发服务器
async function restartDevServer(req, projectId) {
  log(projectId, "INFO", "开始重启开发服务器", {
    projectId,
    requestId: req.requestId,
  });

  // 检查项目是否存在
  const projectPath = path.join(projectSourceDir, projectId);
  const jsonFilePath = path.join(projectPath, "package.json");
  const exists = fs.existsSync(jsonFilePath);
  if (!exists) {
    log(projectId, "WARN", "项目缺少package.json文件", {
      projectId,
      requestId: req.requestId,
    });
    throw new ResourceError("项目缺少package.json文件", {
      projectId,
      projectPath,
    });
  }

  let jsonContent;
  try {
    jsonContent = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
  } catch (error) {
    throw new FileError("package.json文件格式错误", {
      projectId,
      jsonFilePath,
      originalError: error.message,
    });
  }

  const jsonScripts = jsonContent.scripts;
  const devScript = jsonScripts.dev;
  if (!devScript) {
    log(projectId, "WARN", "项目缺少dev脚本", {
      projectId,
      requestId: req.requestId,
    });
    throw new BusinessError("项目缺少dev脚本", { projectId });
  }

  // 如果项目正在启动中，等待完成
  // if (isProjectStarting(projectId)) {
  //   throw new BusinessError("该项目正在启动中，请稍后重试", {
  //     projectId,
  //     code: ERROR_CODES.PROJECT_STARTING,
  //   });
  // }

  addStartingProject(projectId);

  try {
    // 1. 停止现有的开发服务器
    const pidFromQuery = req.query.pid;

    await stopDevServer(req, projectId, pidFromQuery, {
      strict: false, // 非严格模式，停止失败不抛出异常
      waitForStop: true, // 等待进程完全停止
    });

    // 2. 删除node_modules
    log(projectId, "INFO", "开始删除node_modules和lock文件", {
      projectId,
      requestId: req.requestId,
    });
    await removeNodeModules(projectPath, projectId);

    // 3. 创建.npmrc文件
    log(projectId, "INFO", "创建.npmrc文件", {
      projectId,
      requestId: req.requestId,
    });
    await createPnpmNpmrc(projectPath, projectId);

    // 4. 启动dev服务器（依赖安装会在 startDev_NonBlocking 中执行）
    log(projectId, "INFO", "开始启动dev服务器", {
      projectId,
      requestId: req.requestId,
    });

    const { pid, port: actualPort } = await startDev_NonBlocking({
      req,
      projectId,
      projectPath,
      devScript,
    });

    log(projectId, "INFO", "dev服务器重启完成", {
      projectId,
      pid,
      port: actualPort,
      requestId: req.requestId,
    });

    return {
      success: true,
      message: "开发服务器重启成功",
      projectId,
      pid,
      port: actualPort,
    };
  } finally {
    removeStartingProject(projectId);
  }
}

export { restartDevServer };
