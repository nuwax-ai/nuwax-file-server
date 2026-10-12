import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { log, logBuild } from "../log/logUtils.js";
import BuildErrorParser from "../error/buildErrorParser.js";
import config from "../../appConfig/index.js";
import {
  BusinessError,
  FileError,
  ResourceError,
} from "../error/errorHandler.js";
import { installDependencies } from "../buildDependency/dependencyManager.js";
import {
  extractIsolationContext,
  resolveProjectPath,
} from "../common/projectPathUtils.js";

const distTargetDir = config.DIST_TARGET_DIR;

// 构建并发控制（无队列）
const buildingProjects = new Set(); // 正在构建中的项目
let currentBuilds = 0; // 当前并行构建数

// 将dist目录拷贝到指定目录
async function copyBuildOutputToTarget({
  req,
  projectPath,
  projectId,
  outStream,
}) {
  try {
    const sourceDir = path.join(projectPath, "dist");
    const targetBase = distTargetDir;
    const targetDir = path.join(targetBase, projectId, "dist");

    if (!fs.existsSync(sourceDir)) {
      const msg = `dist directory not found: ${sourceDir}`;
      log(projectId, "WARN", msg, { projectId });
      outStream && outStream.write(`${msg}\n`);
      return;
    }

    // 确保目标父目录存在
    if (!fs.existsSync(targetBase)) {
      fs.mkdirSync(targetBase, { recursive: true });
    }

    // 先清空旧目录
    if (fs.existsSync(targetDir)) {
      await fs.promises.rm(targetDir, { recursive: true, force: true });
    }

    // 复制 dist -> 目标目录
    if (fs.promises.cp) {
      await fs.promises.cp(sourceDir, targetDir, { recursive: true });
    } else {
      // Node 版本不支持 fs.promises.cp 时的降级方案
      const copyRecursiveSync = (src, dest) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          for (const entry of fs.readdirSync(src)) {
            copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
          }
        } else {
          fs.copyFileSync(src, dest);
        }
      };
      copyRecursiveSync(sourceDir, targetDir);
    }

    const okMsg = `dist directory copied to: ${targetDir}`;
    log(projectId, "INFO", okMsg, { projectId });
    outStream && outStream.write(`${okMsg}\n`);
  } catch (err) {
    const errMsg = `Failed to copy dist directory: ${err.message}`;
    log(projectId, "ERROR", errMsg, { projectId });
    outStream && outStream.write(`${errMsg}\n`);
    throw err;
  }
}

/**
 * 组装构建脚本失败的业务错误：turbo/tsc 的错误明细多在 stdout（stderr 通常只有摘要），
 * 两者合并后交错误解析器生成友好信息，并将明细（截断）拼进 message 透传给调用方
 * （agent/用户要能看到具体报错）。用业务错误（4xx）而非系统错误（5xx）：调用方按业务
 * 失败处理并直接展示 message，平台侧 PageAppFileClient 走 4xx 分支即可解析到响应体。
 */
function composeBuildScriptError(projectId, command, error, stdout, stderr) {
  const rawOutput = [stderr, stdout].filter(Boolean).join("\n").trim() || error.message;
  const errorParser = new BuildErrorParser();
  const userFriendlyMessage = errorParser.parseBuildError(rawOutput, projectId);
  const maxRawLength = 6000;
  const truncatedRaw = rawOutput.length > maxRawLength
    ? rawOutput.slice(0, maxRawLength) + `\n... (output truncated, total ${rawOutput.length} chars)`
    : rawOutput;
  return new BusinessError(`${userFriendlyMessage}\n${truncatedRaw}`, {
    originalError: error.message,
    command,
  });
}

//执行build脚本
function runBuildScript(projectId, projectPath, scriptName, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const argsPart =
      Array.isArray(extraArgs) && extraArgs.length > 0
        ? " -- " + extraArgs.map((s) => String(s)).join(" ")
        : "";
    const command = `cd ${projectPath} && pnpm run ${scriptName}${argsPart}`;
    logBuild(projectId, "INFO", "Execute command", { command });
    // 同步输出到普通日志也打印一次，便于从统一日志流检索
    try {
      log(projectId, "INFO", "Execute build script", { command, cwd: projectPath });
    } catch (_) {}

    exec(
      command,
      {
        env: process.env, // 继承父进程的环境变量，包括 pnpm 配置
        maxBuffer: 10 * 1024 * 1024, // 10MB 缓冲区
      },
      (error, stdout, stderr) => {
      if (error) {
        logBuild(projectId, "ERROR", "Execution error", {
          error: error.message,
          stderr,
          stdout,
        });
        return reject(composeBuildScriptError(projectId, command, error, stdout, stderr));
      }
      logBuild(projectId, "INFO", "Script execution completed", { stdout });
      resolve(stdout);
    });
  });
}

/**
 * 构建项目
 * @param {Object} req 请求对象
 * @param {string} projectId 项目ID
 * @returns {Promise<Object>} 构建结果
 */
async function buildProject(req, projectId) {
  const isolationContext = extractIsolationContext(req?.query || {});
  const projectPath = resolveProjectPath(projectId, isolationContext);
  const jsonFilePath = path.join(projectPath, "package.json");

  const exists = fs.existsSync(jsonFilePath);
  if (!exists) {
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
  const buildScript = jsonScripts.build;
  if (!buildScript) {
    log(projectId, "WARN", "Project missing build script", {
      projectId,
      requestId: req.requestId,
    });
    throw new BusinessError("Project missing build script", { projectId });
  }

  // 项目级互斥：同一项目仅允许一个构建
  if (buildingProjects.has(projectId)) {
    throw new BusinessError("This project is being built", { projectId });
  }

  // 全局并发限制
  const max = Number.isFinite(config.MAX_BUILD_CONCURRENCY)
    ? config.MAX_BUILD_CONCURRENCY
    : 20;
  if (currentBuilds >= max) {
    throw new BusinessError("Concurrency is full, please try again later", {
      currentBuilds,
      maxConcurrency: max,
    });
  }

  // 直接执行同步构建（空闲）
  buildingProjects.add(projectId);
  currentBuilds += 1;
  try {
    // 读取并规范化 basePath（仅对 Vite 有效）
    let basePath = "";
    if (req && req.query && typeof req.query.basePath === "string") {
      basePath = req.query.basePath;
    }
    if (basePath) {
      if (!basePath.startsWith("/")) basePath = "/" + basePath;
      if (!basePath.endsWith("/")) basePath = basePath + "/";
    }

    const buildExtraArgs = [];
    // 若脚本包含 vite，则传入 --base
    if (
      typeof buildScript === "string" &&
      buildScript.includes("vite") &&
      basePath
    ) {
      buildExtraArgs.push("--base", basePath);
    }

    // 若使用 Vite 构建，追加 --debug 以输出调试信息
    if (typeof buildScript === "string" && buildScript.includes("vite")) {
      buildExtraArgs.push("--debug");
    }

    // 安装依赖
    log(projectId, "INFO", "Start installing dependencies", { projectId });
    await installDependencies(req, projectId, projectPath);

    // 执行构建：Vite 直接使用 pnpm exec，避免 npm-run 参数分隔影响
    if (typeof buildScript === "string" && buildScript.includes("vite")) {
      const viteArgs = ["exec", "vite", "build", ...buildExtraArgs, "--debug"];
      const command = `cd ${projectPath} && pnpm ${viteArgs.join(" ")}`;
      logBuild(projectId, "INFO", "Execute command(direct vite)", { command });
      try {
        log(projectId, "INFO", "Execute build script(direct vite)", {
          command,
          cwd: projectPath,
        });
      } catch (_) {}
      await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
          if (error) {
            logBuild(projectId, "ERROR", "Execution error", {
              error: error.message,
              stderr,
              stdout,
            });
            return reject(composeBuildScriptError(projectId, command, error, stdout, stderr));
          }
          logBuild(projectId, "INFO", "Script execution completed", { stdout });
          resolve(stdout);
        });
      });
    } else {
      log(projectId, "INFO", "Start synchronously executing build script", { projectId });
      await runBuildScript(projectId, projectPath, "build", buildExtraArgs);
    }

    // 拷贝 dist
    await copyBuildOutputToTarget({ req, projectPath, projectId });
    return {
      success: true,
      message: "Build completed",
      projectId,
    };
  } finally {
    buildingProjects.delete(projectId);
    currentBuilds -= 1;
  }
}

export { buildProject, copyBuildOutputToTarget, runBuildScript };
