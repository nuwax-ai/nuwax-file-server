import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { log, logBuild } from "../log/logUtils.js";
import BuildErrorParser from "../error/buildErrorParser.js";
import config from "../../appConfig/index.js";
import {
  BusinessError,
  SystemError,
  FileError,
  ResourceError,
} from "../error/errorHandler.js";
import { installDependencies } from "../buildDependency/dependencyManager.js";

//项目源文件所在目录
const projectSourceDir = config.PROJECT_SOURCE_DIR;
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
      const msg = `未找到dist目录: ${sourceDir}`;
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

    const okMsg = `dist目录已拷贝到: ${targetDir}`;
    log(projectId, "INFO", okMsg, { projectId });
    outStream && outStream.write(`${okMsg}\n`);
  } catch (err) {
    const errMsg = `拷贝dist目录失败: ${err.message}`;
    log(projectId, "ERROR", errMsg, { projectId });
    outStream && outStream.write(`${errMsg}\n`);
    throw err;
  }
}

//执行build脚本
function runBuildScript(projectId, projectPath, scriptName, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const argsPart =
      Array.isArray(extraArgs) && extraArgs.length > 0
        ? " -- " + extraArgs.map((s) => String(s)).join(" ")
        : "";
    const command = `cd ${projectPath} && pnpm run ${scriptName}${argsPart}`;
    logBuild(projectId, "INFO", "执行命令", { command });
    // 同步输出到普通日志也打印一次，便于从统一日志流检索
    try {
      log(projectId, "INFO", "执行构建脚本", { command, cwd: projectPath });
    } catch (_) {}

    exec(
      command,
      {
        env: process.env, // 继承父进程的环境变量，包括 pnpm 配置
        maxBuffer: 10 * 1024 * 1024, // 10MB 缓冲区
      },
      (error, stdout, stderr) => {
      if (error) {
        logBuild(projectId, "ERROR", "执行错误", {
          error: error.message,
          stderr,
        });

        // 使用错误解析器提供用户友好的错误信息
        const errorParser = new BuildErrorParser();
        const errorMessage = stderr || error.message;
        const userFriendlyMessage = errorParser.parseBuildError(
          errorMessage,
          projectId
        );

        // 创建包含用户友好信息的构建错误
        const buildError = new SystemError(userFriendlyMessage, {
          originalError: error.message,
          command: command,
        });

        return reject(buildError);
      }
      logBuild(projectId, "INFO", "脚本执行完成", { stdout });
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
  const projectPath = path.join(projectSourceDir, projectId);
  const jsonFilePath = path.join(projectPath, "package.json");

  const exists = fs.existsSync(jsonFilePath);
  if (!exists) {
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
  const buildScript = jsonScripts.build;
  if (!buildScript) {
    log(projectId, "WARN", "项目缺少build脚本", {
      projectId,
      requestId: req.requestId,
    });
    throw new BusinessError("项目缺少build脚本", { projectId });
  }

  // 项目级互斥：同一项目仅允许一个构建
  if (buildingProjects.has(projectId)) {
    throw new BusinessError("该项目正在构建中", { projectId });
  }

  // 全局并发限制
  const max = Number.isFinite(config.MAX_BUILD_CONCURRENCY)
    ? config.MAX_BUILD_CONCURRENCY
    : 20;
  if (currentBuilds >= max) {
    throw new BusinessError("并发已满，请稍后重试", {
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
    log(projectId, "INFO", "开始安装依赖", { projectId });
    await installDependencies(req, projectId, projectPath);

    // 执行构建：Vite 直接使用 pnpm exec，避免 npm-run 参数分隔影响
    if (typeof buildScript === "string" && buildScript.includes("vite")) {
      const viteArgs = ["exec", "vite", "build", ...buildExtraArgs, "--debug"];
      const command = `cd ${projectPath} && pnpm ${viteArgs.join(" ")}`;
      logBuild(projectId, "INFO", "执行命令(直接vite)", { command });
      try {
        log(projectId, "INFO", "执行构建脚本(直接vite)", {
          command,
          cwd: projectPath,
        });
      } catch (_) {}
      await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
          if (error) {
            logBuild(projectId, "ERROR", "执行错误", {
              error: error.message,
              stderr,
            });
            const errorParser = new BuildErrorParser();
            const errorMessage = stderr || error.message;
            const userFriendlyMessage = errorParser.parseBuildError(
              errorMessage,
              projectId
            );
            const buildError = new SystemError(userFriendlyMessage, {
              originalError: error.message,
              command,
            });
            return reject(buildError);
          }
          logBuild(projectId, "INFO", "脚本执行完成", { stdout });
          resolve(stdout);
        });
      });
    } else {
      log(projectId, "INFO", "开始同步执行 build 脚本", { projectId });
      await runBuildScript(projectId, projectPath, "build", buildExtraArgs);
    }

    // 拷贝 dist
    await copyBuildOutputToTarget({ req, projectPath, projectId });
    return {
      success: true,
      message: "构建完成",
      projectId,
    };
  } finally {
    buildingProjects.delete(projectId);
    currentBuilds -= 1;
  }
}

export { buildProject, copyBuildOutputToTarget, runBuildScript };
