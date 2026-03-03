import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";
import config from "../../appConfig/index.js";
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

//项目源文件所在目录
const projectSourceDir = config.PROJECT_SOURCE_DIR;

// 启动开发服务器
async function startDevServer(req, projectId) {
  
  // if (isProjectStarting(projectId)) {
  //   throw new BusinessError("该项目正在启动中，请稍后重试", {
  //     projectId,
  //     code: ERROR_CODES.PROJECT_STARTING,
  //   });
  // }

  addStartingProject(projectId);
  try {
    log(projectId, "INFO", "启动开发服务器", {
      projectId,
      requestId: req.requestId,
    });
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
      throw new BusinessError("缺少dev脚本，请在package.json中添加dev脚本", { projectId });
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
            log(projectId, "WARN", "检测到 Rollup 原生包与 libc 不匹配，清理依赖后重装", {
              projectId,
              isMusl,
              glibcVersion: glibcVersion || null,
            });
            await removeNodeModules(projectPath, projectId);
          }
        }
      }
    } catch (e) {
      log(projectId, "WARN", "Linux 原生包匹配检测失败（忽略继续）", {
        error: e && e.message,
      });
    }

    // 尝试为后续 dev 进程注入回退环境，优先使用 WASM/JS，避免 .node 装载
    try {
      process.env.ROLLUP_WASM = process.env.ROLLUP_WASM || "1";
      process.env.ROLLUP_DISABLE_NATIVE = process.env.ROLLUP_DISABLE_NATIVE || "1";
    } catch (_) {}

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

    log(projectId, "INFO", "开始以非阻塞方式执行 dev 脚本", {
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
      message: "开发服务器已启动",
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
