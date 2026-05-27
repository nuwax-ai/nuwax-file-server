import { exec, spawn } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";

/**
 * 获取文件修改时间
 * @param {string} filePath 文件路径
 * @returns {number} 修改时间戳（毫秒）
 */
function getFileMtime(filePath) {
  try {
    //同步读取文件的元信息，并返回该文件的最后修改时间的时间戳（毫秒）
    return fs.statSync(filePath).mtimeMs;
  } catch (e) {
    return 0;
  }
}

/**
 * 判断是否应该安装依赖
 * @param {string} projectPath 项目路径
 * @returns {boolean}
 */
function shouldInstallDeps(projectPath) {
  const pkgPath = path.join(projectPath, "package.json");
  const lockPathNpm = path.join(projectPath, "package-lock.json");
  const lockPathYarn = path.join(projectPath, "yarn.lock");
  const nodeModulesPath = path.join(projectPath, "node_modules");

  const nodeModulesExists = fs.existsSync(nodeModulesPath);
  if (!nodeModulesExists) return true;

  const pkgMtime = getFileMtime(pkgPath);
  const lockMtime = Math.max(
    getFileMtime(lockPathNpm),
    getFileMtime(lockPathYarn)
  );
  const nodeModulesMtime = getFileMtime(nodeModulesPath);

  // 如果 package.json 或锁文件比 node_modules 更新，则需要安装
  return Math.max(pkgMtime, lockMtime) > nodeModulesMtime;
}

/**
 * 检查并删除 node_modules 文件夹和 lock 文件
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（可选，用于日志）
 * @returns {Promise<void>}
 */
async function removeNodeModules(projectPath, projectId = null) {
  const nodeModulesPath = path.join(projectPath, "node_modules");
  const logId = projectId || path.basename(projectPath);

  if (fs.existsSync(nodeModulesPath)) {
    log(logId, "INFO", "Found node_modules folder, deleting", {
      projectPath,
      nodeModulesPath,
    });

    try {
      await fs.promises.rm(nodeModulesPath, { recursive: true, force: true });
      log(logId, "INFO", "node_modules folder deleted successfully", {
        projectPath,
        nodeModulesPath,
      });
    } catch (error) {
      log(logId, "WARN", `Failed to delete node_modules folder: ${error.message}`, {
        projectPath,
        nodeModulesPath,
        error: error.message,
      });
    }
  }

  // 删除 lock 文件
  const lockFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

  for (const lockFile of lockFiles) {
    const lockFilePath = path.join(projectPath, lockFile);

    if (fs.existsSync(lockFilePath)) {
      log(logId, "INFO", `Found ${lockFile} file, deleting`, {
        projectPath,
        lockFilePath,
      });

      try {
        await fs.promises.unlink(lockFilePath);
        log(logId, "INFO", `${lockFile} file deleted successfully`, {
          projectPath,
          lockFilePath,
        });
      } catch (error) {
        log(logId, "WARN", `Failed to delete ${lockFile} file: ${error.message}`, {
          projectPath,
          lockFilePath,
          error: error.message,
        });
      }
    }
  }
}

/**
 * 安装项目依赖
 * @param {Object} req 请求对象
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {Object} options 可选参数
 * @param {Object} options.outStream 主日志流（可选）
 * @param {Object} options.tempOutStream 临时日志流（可选）
 * @param {Function} options.safeWrite 安全写入函数（可选）
 * @returns {Promise<string>} 安装输出
 */
function installDependencies(req, projectId, projectPath, options = {}) {
  const { outStream, tempOutStream, safeWrite } = options;

  // 检测 node_modules 是否已存在（可能从模板缓存复制而来）
  // 如果已存在，pnpm install 只做增量验证和安装，速度更快
  const nodeModulesPath = path.join(projectPath, "node_modules");
  const isIncremental = fs.existsSync(nodeModulesPath);

  // 如果提供了日志流，使用 spawn 获取实时输出
  if (outStream && tempOutStream && safeWrite) {
    return new Promise((resolve, reject) => {
      // 优化 pnpm install 命令，提升在 Docker/容器环境中的性能
      // --prefer-offline: 优先使用本地缓存，减少网络请求
      // --reporter=silent: 静默模式，不输出进度信息，大幅提升 pipe 性能
      // 注意：--loglevel=error 只显示错误，避免频繁的 I/O 操作
      const command = `cd ${projectPath} && pnpm install --prefer-offline`;

      // 记录开始时间
      const startTime = Date.now();

      // 写入开始安装的日志（safeWrite 会自动添加时间戳）
      const installMode = isIncremental ? "incremental (node_modules from cache)" : "full install";
      const startMessage = `Start installing dependencies (${installMode})\nCommand: pnpm install --prefer-offline\n`;
      safeWrite(outStream, startMessage, "Main log");
      safeWrite(tempOutStream, startMessage, "Temp log");
      
      // 心跳定时器：每5秒输出一次，让用户知道还在进行中
      let heartbeatCount = 0;
      const heartbeatInterval = setInterval(() => {
        heartbeatCount++;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const heartbeatMsg = `Installing dependencies... (Elapsed time: ${elapsed} seconds)\n`;
        safeWrite(outStream, heartbeatMsg, "Main log");
        safeWrite(tempOutStream, heartbeatMsg, "Temp log");
      }, 5000); // 每5秒

      // 使用 spawn 获取实时输出
      // 重要：必须传递环境变量，这样 pnpm 才能使用配置的 store 路径、镜像等配置
      const child = spawn("sh", ["-c", command], {
        cwd: projectPath,
        env: process.env, // 继承父进程的环境变量，包括 pnpm 配置
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      // 实时输出到日志流
      if (child.stdout) {
        child.stdout.on("data", (data) => {
          const dataStr = data.toString();
          stdout += dataStr;
          safeWrite(outStream, dataStr, "Main log");
          safeWrite(tempOutStream, dataStr, "Temp log");
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data) => {
          const dataStr = data.toString();
          stderr += dataStr;
          safeWrite(outStream, dataStr, "Main log");
          safeWrite(tempOutStream, dataStr, "Temp log");
        });
      }

      child.on("exit", (code, signal) => {
        // 清除心跳定时器
        clearInterval(heartbeatInterval);
        
        // 计算总耗时
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        if (code !== 0) {
          const errorMessage = `Dependency installation failed (Elapsed time: ${totalTime} seconds)\nExit code: ${code}, Signal: ${signal}\n${stderr || 'No error information'}\n`;
          safeWrite(outStream, errorMessage, "Main log");
          safeWrite(tempOutStream, errorMessage, "Temp log");
          return reject(
            new Error(`Dependency installation failed: Exit code ${code}, Signal ${signal}\n${stderr}`)
          );
        }

        // 即使退出码为0，也检查stderr中是否有错误信息
        if (stderr && stderr.includes("Error") && !stderr.includes("warning")) {
          const warnMessage = `Warning occurred during dependency installation: ${stderr}\n`;
          safeWrite(outStream, warnMessage, "Main log");
          safeWrite(tempOutStream, warnMessage, "Temp log");
        }

        // 成功完成，输出摘要
        const successMessage = `✓ Dependency installation successful (Elapsed time: ${totalTime} seconds)\n`;
        safeWrite(outStream, successMessage, "Main log");
        safeWrite(tempOutStream, successMessage, "Temp log");
        
        // 记录摘要信息（包括 stdout 和 stderr 的内容）
        if (stdout || stderr) {
          const summaryMessage = `Installation details:\n${stdout || '(No standard output)'}${stderr ? '\nWarning information:\n' + stderr : ''}\n`;
          safeWrite(outStream, summaryMessage, "Main log");
          safeWrite(tempOutStream, summaryMessage, "Temp log");
        } else {
          // 静默模式下可能没有输出，主动说明
          const noOutputMsg = `(Silent mode: No detailed output, dependency successfully linked from store to node_modules)\n`;
          safeWrite(outStream, noOutputMsg, "Main log");
          safeWrite(tempOutStream, noOutputMsg, "Temp log");
        }
        
        resolve(stdout);
      });

      child.on("error", (error) => {
        // 清除心跳定时器
        clearInterval(heartbeatInterval);
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const errorMessage = `Dependency installation process error (Elapsed time: ${totalTime} seconds): ${error.message}\n`;
        safeWrite(outStream, errorMessage, "Main log");
        safeWrite(tempOutStream, errorMessage, "Temp log");
        reject(new Error(`Dependency installation failed: ${error.message}`));
      });
    });
  }

  // 如果没有提供日志流，使用原来的 exec 方式（保持向后兼容）
  return new Promise((resolve, reject) => {
    // 优化 pnpm install 命令，提升性能
    const command = `cd ${projectPath} && pnpm install --prefer-offline --reporter=silent --loglevel=error`;

    log(projectId, "INFO", "Start executing dependency installation command", {
      command,
      projectPath,
      installMode: isIncremental ? "incremental" : "full",
    });

    exec(
      command,
      {
        maxBuffer: 10 * 1024 * 1024,
        env: process.env, // 继承父进程的环境变量，包括 pnpm 配置
      },
      (error, stdout, stderr) => {
      if (error) {
        log(projectId, "ERROR", "Dependency installation failed", {
          error: error.message,
          code: error.code,
          stderr: stderr || error.message,
          stdout: stdout || "",
        });
        return reject(
          new Error(
            `Dependency installation failed: ${error.message}\n${stderr || error.message}`
          )
        );
      }

      // 即使退出码为0，也检查stderr中是否有错误信息
      if (stderr && stderr.includes("Error") && !stderr.includes("warning")) {
        log(projectId, "WARN", "Warning or error occurred during dependency installation", {
          stderr,
        });
        // 可以选择继续执行或拒绝
      }

      log(projectId, "INFO", "Dependency installation completed", {
        stdout: stdout.substring(0, 500), // 只记录前500个字符
      });
      resolve(stdout);
    });
  });
}

export { getFileMtime, shouldInstallDeps, installDependencies, removeNodeModules };
