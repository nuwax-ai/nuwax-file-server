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
 *
 * 支持 symlink 优化：如果 node_modules 是 symlink（指向本地磁盘），
 * 则先 unlink symlink（1 次 JuiceFS 元数据操作），再 rm -rf 本地目标（本地磁盘，快）。
 * 避免在 JuiceFS FUSE 上遍历删除 3000+ 文件（10+ 秒）。
 *
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（可选，用于日志）
 * @returns {Promise<void>}
 */
async function removeNodeModules(projectPath, projectId = null) {
  const nodeModulesPath = path.join(projectPath, "node_modules");
  const logId = projectId || path.basename(projectPath);

  // 检查 node_modules 是否存在（包括 symlink）
  let exists = false;
  let isSymlink = false;
  let symlinkTarget = null;

  try {
    const lstat = await fs.promises.lstat(nodeModulesPath);
    exists = true;
    isSymlink = lstat.isSymbolicLink();
    if (isSymlink) {
      symlinkTarget = await fs.promises.readlink(nodeModulesPath);
    }
  } catch (_) {
    // 不存在，跳过
  }

  if (exists) {
    if (isSymlink) {
      // symlink 策略：先删除 symlink（快），再删除本地目标（快）
      log(logId, "INFO", "Found node_modules symlink, using fast removal", {
        projectPath,
        symlink: nodeModulesPath,
        target: symlinkTarget,
      });

      try {
        // 1. 删除 symlink（1 次 JuiceFS 元数据操作，< 5ms）
        await fs.promises.unlink(nodeModulesPath);
        log(logId, "INFO", "Symlink removed", { nodeModulesPath });

        // 2. 删除本地磁盘上的目标目录（本地文件系统，快）
        if (symlinkTarget) {
          // 解析绝对路径
          const absoluteTarget = path.isAbsolute(symlinkTarget)
            ? symlinkTarget
            : path.resolve(path.dirname(nodeModulesPath), symlinkTarget);

          if (fs.existsSync(absoluteTarget)) {
            await fs.promises.rm(absoluteTarget, { recursive: true, force: true });
            log(logId, "INFO", "Local node_modules target removed", { absoluteTarget });

            // 清理父目录（如果为空）
            try {
              const parentDir = path.dirname(absoluteTarget);
              await fs.promises.rmdir(parentDir);
              log(logId, "INFO", "Empty parent directory removed", { parentDir });
            } catch (_) {
              // 目录不为空或删除失败，忽略
            }
          }
        }
      } catch (error) {
        log(logId, "WARN", `Failed to remove node_modules symlink: ${error.message}`, {
          error: error.message,
        });
      }
    } else {
      // 普通目录：直接删除（JuiceFS 上较慢，但必须这样做）
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
 * 预检：检测会导致 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY 的条件
 * 如果检测到，主动清理 node_modules（我们有 TTY 控制权，pnpm 没有）
 *
 * 触发场景：
 * - Pod 重启后，emptyDir 销毁，但 JuiceFS 上的 node_modules 引用旧的 store 路径
 * - pnpm store 从 JuiceFS 迁移到本地磁盘后，旧项目的 .modules.yaml 记录旧路径
 * - pnpm 检测到 store 不匹配，想清理但非 TTY 模式下直接中止
 *
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目ID（用于日志）
 * @returns {Promise<void>}
 */
async function preflightCleanNodeModules(projectPath, projectId) {
  const nodeModulesPath = path.join(projectPath, "node_modules");
  const logId = projectId || path.basename(projectPath);

  // 检查 node_modules 是否存在
  if (!fs.existsSync(nodeModulesPath)) {
    return; // 不存在，无需清理
  }

  // 检查 1: 断链 symlink（Pod 迁移后常见）
  try {
    const lstat = await fs.promises.lstat(nodeModulesPath);
    if (lstat.isSymbolicLink() && !fs.existsSync(nodeModulesPath)) {
      log(logId, "WARN", "Broken node_modules symlink detected, removing before install", {
        projectPath,
        nodeModulesPath,
      });
      await fs.promises.unlink(nodeModulesPath);
      return;
    }
  } catch (e) {
    log(logId, "WARN", `Failed to check node_modules symlink: ${e.message}`);
  }

  // 检查 2: store 路径不匹配（主要触发原因）
  // pnpm 在 node_modules/.modules.yaml 中记录 store 路径
  // 如果当前 PNPM_STORE_DIR 与记录的不一致，pnpm 会尝试清理
  try {
    const modulesYamlPath = path.join(nodeModulesPath, ".modules.yaml");
    if (fs.existsSync(modulesYamlPath)) {
      const content = await fs.promises.readFile(modulesYamlPath, "utf8");
      const storeMatch = content.match(/storeDir:\s*(.+)/);

      if (storeMatch) {
        const recordedStore = storeMatch[1].trim();
        const currentStore = process.env.PNPM_STORE_DIR || "";

        if (currentStore && recordedStore !== currentStore) {
          log(logId, "WARN",
            `Store path mismatch detected (node_modules from different store), ` +
            "removing node_modules to prevent ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY", {
              projectPath,
              recordedStoreDir: recordedStore,
              currentStoreDir: currentStore,
            });
          await removeNodeModules(projectPath, projectId);
        }
      }
    }
  } catch (e) {
    log(logId, "WARN", `Pre-flight store check failed: ${e.message}`);
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
async function installDependencies(req, projectId, projectPath, options = {}) {
  // 预检清理：检测并修复会导致 TTY abort 的条件
  await preflightCleanNodeModules(projectPath, projectId);

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

export { getFileMtime, shouldInstallDeps, installDependencies, removeNodeModules, preflightCleanNodeModules };
