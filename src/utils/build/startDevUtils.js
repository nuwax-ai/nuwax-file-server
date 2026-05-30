import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";
import { BusinessError, FileError, ResourceError } from "../error/errorHandler.js";
import ERROR_CODES from "../error/errorCodes.js";
import {
  getRunningProcess,
  isProjectStarting,
  addStartingProject,
  removeStartingProject,
  startDev_NonBlocking,
} from "./processManager.js";
import { removeNodeModules } from "../buildDependency/dependencyManager.js";
import { createPnpmNpmrc } from "../common/npmrcUtils.js";
import { copyNodeModulesFromCache, isK8sMode } from "../common/templateCacheUtils.js";
import {
  extractIsolationContext,
  resolveProjectPath,
} from "../common/projectPathUtils.js";

// 启动开发服务器
async function startDevServer(req, projectId) {

  if (isProjectStarting(projectId)) {
    throw new BusinessError("该项目正在启动中，请稍后重试", {
      projectId,
      code: ERROR_CODES.PROJECT_STARTING,
    });
  }

  addStartingProject(projectId);
  try {
    log(projectId, "INFO", "Start starting development server", {
      projectId,
      requestId: req.requestId,
    });
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
      throw new BusinessError("Project missing dev script, please add dev script in package.json", { projectId });
    }

    // Linux 环境下：检测 libc 类型与已安装 Rollup 原生包是否匹配，若不匹配则清理依赖
    try {
      const isLinux = process.platform === "linux";
      if (isLinux) {
        const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
        const glibcVersion = report && report.header && report.header.glibcVersionRuntime;
        const isMusl = !glibcVersion; // 没有 glibc 版本通常意味着 musl（如 Alpine）

        const pnpmDir = path.join(projectPath, "node_modules", ".pnpm");
        if (fs.existsSync(pnpmDir)) {
          const entries = await fs.promises.readdir(pnpmDir, { withFileTypes: true });
          const hasRollupGnu = entries.some((ent) => ent.isDirectory() && (ent.name || "").includes("@rollup+rollup-linux-x64-gnu"));
          const hasRollupMusl = entries.some((ent) => ent.isDirectory() && (ent.name || "").includes("@rollup+rollup-linux-x64-musl"));

          // 在 musl 系统上若装了 gnu 变体，或在 glibc 系统上若装了 musl 变体，则清理
          const mismatch = (isMusl && hasRollupGnu) || (!isMusl && hasRollupMusl);
          if (mismatch) {
            log(projectId, "WARN", "Detected Rollup native package does not match libc, clean dependencies and reinstall", {
              projectId,
              isMusl,
              glibcVersion: glibcVersion || null,
            });
            await removeNodeModules(projectPath, projectId);
          }
        }
      }
    } catch (e) {
      log(projectId, "WARN", "Linux native package matching detection failed (ignore continue)", {
        error: e && e.message,
      });
    }

    // 尝试为后续 dev 进程注入回退环境，优先使用 WASM/JS，避免 .node 装载
    try {
      process.env.ROLLUP_WASM = process.env.ROLLUP_WASM || "1";
      process.env.ROLLUP_DISABLE_NATIVE = process.env.ROLLUP_DISABLE_NATIVE || "1";
    } catch (_) {}

    // docker-compose 模式：检测 symlink 断链并恢复（容器重启后临时目录可能丢失）
    // k8s 模式：node_modules 在 JuiceFS 上，Pod 迁移后仍完好，无需检测
    if (!isK8sMode()) {
      try {
        const nodeModulesPath = path.join(projectPath, "node_modules");
        let needCopy = false;

        try {
          const lstat = fs.lstatSync(nodeModulesPath);
          if (lstat.isSymbolicLink()) {
            if (!fs.existsSync(nodeModulesPath)) {
              log(projectId, "WARN", "node_modules symlink is broken, will restore from cache", {
                projectId,
                requestId: req.requestId,
              });
              needCopy = true;
            }
          }
        } catch (e) {
          log(projectId, "INFO", "node_modules not found, will try to copy from cache", {
            projectId,
            requestId: req.requestId,
          });
          needCopy = true;
        }

        if (needCopy) {
          log(projectId, "INFO", "Attempting to restore node_modules from template cache", {
            projectId,
            requestId: req.requestId,
          });
          await copyNodeModulesFromCache(projectPath, projectId);
        }
      } catch (e) {
        log(projectId, "WARN", "Failed to check/restore node_modules, will proceed anyway", {
          projectId,
          requestId: req.requestId,
          error: e && e.message,
        });
      }
    }

    // 确保 .npmrc 存在且使用 copy 模式（避免 pnpm 默认 hardlink 在 JuiceFS 上失败）
    await createPnpmNpmrc(projectPath, projectId);

    // 如果已在运行，则直接返回信息
    // if (getRunningProcess(projectId)) {
    //   const p = getRunningProcess(projectId);
    //   log(projectId, "INFO", "项目已在运行，直接返回信息", {
    //     projectId,
    //     requestId: req.requestId,
    //   });
    //   return {
    //     success: true,
    //     message: "已在运行",
    //     projectId,
    //     pid: p.pid,
    //     port: p.port,
    //   };
    // }

    log(projectId, "INFO", "Start executing dev script in non-blocking mode", {
      projectId,
      requestId: req.requestId,
    });

    const { pid, port: actualPort } = await startDev_NonBlocking({
      req,
      projectId,
      projectPath,
      devScript,
    });
    return {
      success: true,
      message: "Development server started",
      projectId,
      pid,
      port: actualPort,
    };
  } finally {
    // 无论成功、失败都清理锁
    removeStartingProject(projectId);
  }
}

export { startDevServer };
