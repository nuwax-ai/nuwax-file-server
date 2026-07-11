import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";
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
import { copyNodeModulesFromCache } from "../common/templateCacheUtils.js";
import config from "../../appConfig/index.js";
import { shouldUseFastRestart } from "./restartDevPredicate.js";
import {
  extractIsolationContext,
  resolveProjectPath,
} from "../common/projectPathUtils.js";

// 重启开发服务器
async function restartDevServer(req, projectId) {
  log(projectId, "INFO", "Start restarting development server", {
    projectId,
    requestId: req.requestId,
  });

  // 检查项目是否存在
  const isolationContext = extractIsolationContext(req?.query || {});
  const projectPath = resolveProjectPath(projectId, isolationContext);
  const jsonFilePath = path.join(projectPath, "package.json");
  const exists = fs.existsSync(jsonFilePath);
  if (!exists) {
    log(projectId, "WARN", "Project missing package.json file", {
      projectId,
      requestId: req.requestId,
    });
    throw new ResourceError("Project missing package.json file", {
      projectId,
      projectPath,
    });
  }

  let jsonContent;
  try {
    jsonContent = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));
  } catch (error) {
    throw new FileError("package.json file format error", {
      projectId,
      jsonFilePath,
      originalError: error.message,
    });
  }

  const jsonScripts = jsonContent.scripts;
  const devScript = jsonScripts.dev;
  if (!devScript) {
    log(projectId, "WARN", "Project missing dev script", {
      projectId,
      requestId: req.requestId,
    });
    throw new BusinessError("Project missing dev script", { projectId });
  }

  // 如果项目正在启动中，拒绝并发请求
  if (isProjectStarting(projectId)) {
    throw new BusinessError("该项目正在重启中，请稍后重试", {
      projectId,
      code: ERROR_CODES.PROJECT_STARTING,
    });
  }

  addStartingProject(projectId);

  try {
    // 1. 停止现有的开发服务器
    const pidFromQuery = req.query.pid;

    await stopDevServer(req, projectId, pidFromQuery, {
      strict: false, // 非严格模式，停止失败不抛出异常
      waitForStop: true, // 等待进程完全停止
    });

    // 删除 node_modules + 从缓存恢复 —— 门控: 快路径跳过, 全路径保留原逻辑
    // - 快路径(FAST_RESTART_ENABLED 且 node_modules 已存在): 保留 node_modules + lockfile,
    //   由 installDependencies 内的 preflightCleanNodeModules 做外科式坏态修复 +
    //   pnpm install 增量 reconcile。省去 CephFS 上 rm -rf 几万小文件的 ~10s。
    // - 全路径(默认/docker-compose, 或 node_modules 不存在): rm -rf + 删 lockfile + 从缓存恢复。
    //   node_modules 不存在时强制走全路径, 让 copyNodeModulesFromCache 有机会用模板缓存。
    const nodeModulesPath = path.join(projectPath, "node_modules");
    let nodeModulesExists = false;
    try {
      // existsSync 跟随符号链接: 断链返回 false → 视为不存在 → 走全路径修复
      nodeModulesExists = fs.existsSync(nodeModulesPath);
    } catch (_) {
      // lstat 异常保守按不存在处理
    }

    const useFastRestart = shouldUseFastRestart({
      fastRestartEnabled: config.FAST_RESTART_ENABLED,
      nodeModulesExists,
    });

    if (useFastRestart) {
      log(
        projectId,
        "INFO",
        "Fast restart: preserve node_modules + lockfile, rely on pnpm incremental install",
        { projectId, requestId: req.requestId, fastRestart: true }
      );
      // 跳过 removeNodeModules + copyNodeModulesFromCache。
      // createPnpmNpmrc 幂等(已最优则 skip), 保留以确保 store-dir 正确。
      await createPnpmNpmrc(projectPath, projectId);
    } else {
      log(
        projectId,
        "INFO",
        "Full restart: remove node_modules and restore from cache",
        { projectId, requestId: req.requestId, fastRestart: false }
      );
      // symlink 模式: 只删 symlink (快); 普通目录: rm -rf (CephFS/JuiceFS 上较慢)
      await removeNodeModules(projectPath, projectId);
      await copyNodeModulesFromCache(projectPath, projectId);
      // 确保 .npmrc 存在且使用 copy 模式（避免 pnpm 默认 hardlink 在共享 FS 上失败）
      await createPnpmNpmrc(projectPath, projectId);
    }

    // 3. 启动dev服务器（依赖安装会在 startDev_NonBlocking 中执行，增量 pnpm install）
    log(projectId, "INFO", "Start starting dev server", {
      projectId,
      requestId: req.requestId,
    });

    const { pid, port: actualPort } = await startDev_NonBlocking({
      req,
      projectId,
      projectPath,
      devScript,
    });

    log(projectId, "INFO", "Dev server restart completed", {
      projectId,
      pid,
      port: actualPort,
      requestId: req.requestId,
    });

    return {
      success: true,
      message: "Development server restart successfully",
      projectId,
      pid,
      port: actualPort,
    };
  } finally {
    removeStartingProject(projectId);
  }
}

export { restartDevServer };
