import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { log, getLogDir, getCSTDateString, getCSTTimestampString } from "../log/logUtils.js";
import logCacheManager from "../log/logCacheManager.js";
import { ProcessError, BusinessError, ValidationError } from "../error/errorHandler.js";
import ERROR_CODES from "../error/errorCodes.js";
import { sanitizeSensitivePaths } from "../common/sensitiveUtils.js";
import config from "../../appConfig/index.js";
import {
  waitPortListening,
  waitPortFromPid,
  waitPortFromLog,
  getPidsByPort,
} from "../buildArg/portUtils.js";
import ExtraArgsUtils from "../buildArg/extraArgsUtils.js";
import { ensureDevBinariesExecutable } from "../buildPermission/permissionManager.js";
import { installDependencies } from "../buildDependency/dependencyManager.js";
import portPool from "../buildArg/portPool.js";
import { isProjectAlive } from "../buildJudge/aliveJudgeUtils.js";

/**
 * 从日志文件中提取执行命令后的所有行
 * 支持多种构建工具和框架：
 * - 构建工具: vite, webpack, rollup, parcel, esbuild, tsc, ts-node
 * - 框架: next, nuxt, astro, svelte, remix
 * - 包管理器: pnpm, npm, yarn, bun
 * - 脚本执行: node, 自定义脚本
 *
 * @param {string} logPath 日志文件路径
 * @param {string} projectId 项目ID
 * @param {number} pid 进程ID
 * @returns {string} 执行命令后的所有输出（已脱敏）
 */
function extractCommandOutputFromLog(logPath, projectId, pid) {
  let commandOutput = "开发服务器启动失败";
  try {
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, "utf8");
      const lines = logContent.split("\n");

      // 查找执行命令的行，支持多种构建工具和框架
      let commandStartIndex = -1;

      // 第一轮：优先查找明确的命令执行行
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (
          // 直接命令格式: > vite, > webpack, > next, > nuxt 等
          line.match(
            /^>\s*(vite|webpack|next|nuxt|rollup|parcel|esbuild|tsc|ts-node|astro|svelte|remix)/
          ) ||
          // 包管理器运行命令: > pnpm run dev, > npm run start 等
          line.match(
            /^>\s*(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve|build|watch|start:dev)/
          ) ||
          // 直接执行脚本: > node server.js, > node index.js 等
          line.match(/^>\s*node\s+\S+\.(js|ts|mjs)$/) ||
          // 自定义脚本执行标记
          line.includes("开始执行脚本: dev") ||
          line.includes("开始执行脚本: start") ||
          line.includes("开始执行脚本: serve") ||
          line.includes("开始执行脚本: build")
        ) {
          commandStartIndex = i;
          break;
        }
      }

      // 第二轮：如果没有找到命令行，查找构建工具输出标记
      if (commandStartIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (
            // 构建工具特定输出标记
            line.includes("VITE") ||
            line.includes("Webpack") ||
            line.includes("Next.js") ||
            line.includes("Nuxt") ||
            line.includes("Rollup") ||
            line.includes("Parcel") ||
            line.includes("Astro") ||
            line.includes("Svelte") ||
            line.includes("Remix") ||
            // 开发服务器启动标记
            line.includes("Local:") ||
            line.includes("Network:") ||
            line.includes("ready in") ||
            line.includes("compiled successfully") ||
            line.includes("dev server running") ||
            line.includes("server started")
          ) {
            commandStartIndex = i;
            break;
          }
        }
      }

      // 第三轮：如果仍然没有找到，查找错误输出标记
      if (commandStartIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (
            line.includes("Error") ||
            line.includes("error") ||
            line.includes("failed") ||
            line.includes("Cannot find") ||
            line.includes("ERR_") ||
            line.includes("Command failed") ||
            line.includes("ELIFECYCLE") ||
            line.includes("npm ERR!") ||
            line.includes("pnpm ERR!")
          ) {
            commandStartIndex = i;
            break;
          }
        }
      }

      if (commandStartIndex >= 0) {
        // 提取命令执行后的所有行（包含错误行本身）
        const outputLines = lines.slice(commandStartIndex);
        commandOutput = outputLines.join("\n").trim();

        // 如果输出为空，返回默认信息
        if (!commandOutput) {
          commandOutput = "命令已执行，但无输出信息";
        }
      } else {
        // 如果没有找到命令开始标记，返回所有日志内容
        commandOutput = logContent.trim();
      }

      // 脱敏处理：移除敏感路径信息
      commandOutput = sanitizeSensitivePaths(commandOutput);

      // 如果输出太长，截取最后的部分（保留更多信息）
      if (commandOutput.length > 1000) {
        commandOutput = commandOutput.substring(commandOutput.length - 1000);
      }
    }
  } catch (readError) {
    log(projectId, "WARN", "读取日志文件失败", {
      projectId,
      pid: pid,
      error: readError.message,
    });
  }

  return commandOutput;
}

// 进程注册表：维护运行dev的项目
// key: projectId
// value: { pid, logPath, startedAt, port}
const runningDevProcesses = new Map();

// 项目级启动锁，避免并发重复启动同一项目
const startingProjects = new Set();

/**
 * 获取运行中的进程信息
 * @param {string} projectId 项目ID
 * @returns {Object|null} 进程信息
 */
function getRunningProcess(projectId) {
  return runningDevProcesses.get(projectId) || null;
}

/**
 * 设置运行中的进程信息
 * @param {string} projectId 项目ID
 * @param {Object} processInfo 进程信息
 */
function setRunningProcess(projectId, processInfo) {
  runningDevProcesses.set(projectId, processInfo);
}

/**
 * 删除运行中的进程信息
 * @param {string} projectId 项目ID
 */
function deleteRunningProcess(projectId) {
  runningDevProcesses.delete(projectId);
}

/**
 * 检查项目是否正在启动中
 * @param {string} projectId 项目ID
 * @returns {boolean}
 */
function isProjectStarting(projectId) {
  return startingProjects.has(projectId);
}

/**
 * 添加项目到启动锁
 * @param {string} projectId 项目ID
 */
function addStartingProject(projectId) {
  startingProjects.add(projectId);
}

/**
 * 从启动锁中移除项目
 * @param {string} projectId 项目ID
 */
function removeStartingProject(projectId) {
  startingProjects.delete(projectId);
}

/**
 * 使用spawn非阻塞启动开发服务器,并把日志写入文件
 * @param {Object} options 启动选项
 * @param {Object} options.req 请求对象
 * @param {string} options.projectId 项目ID
 * @param {string} options.projectPath 项目路径
 * @param {string} options.devScript dev脚本内容
 * @param {Object} options.envExtra 额外的环境变量
 * @param {Array} options.extraArgs 额外的参数
 * @returns {Object} { pid, logPath, port }
 */
async function startDev_NonBlocking({
  req,
  projectId,
  projectPath,
  devScript,
}) {
  const lowerScript = (devScript || "").toLowerCase();
  const isVite = lowerScript.includes("vite");
  const isNext = lowerScript.includes("next");

  if (!isVite && !isNext) {
    throw new BusinessError("不支持的脚本类型" + devScript + "，请使用vite或next脚本", {
      projectId,
      code: ERROR_CODES.INVALID_SCRIPT_TYPE,
    });
  }

  // 创建日志目录
  const logDir = getLogDir(projectId);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  // 主日志文件
  const today = getCSTDateString(); // 格式: YYYY-MM-DD (东八区)
  const logPath = path.join(logDir, `dev-${today}.log`);

  // 临时日志用于端口解析
  const tempLogPath = path.join(
    logDir,
    `dev-temp-${Date.now().toString()}.log`
  );

  let outStream, tempOutStream, child;
  let streamsClosed = false;
  let childExited = false;
  let allocatedPort = null; // 跟踪分配的端口，用于失败时释放

  // 标记缓存是否已失效（避免频繁删除缓存）
  let cacheInvalidated = false;

  // 创建安全的写入函数
  const safeWrite = (stream, data, streamName, flush = false) => {
    // 分别检查流的状态，而不是使用共享的 streamsClosed
    if (!stream || stream.destroyed) {
      // 只有在需要时才输出调试信息，避免日志过多
      if (stream && stream.destroyed) {
        log(projectId, "DEBUG", `${streamName}流已销毁，跳过写入`, {
          destroyed: true,
        });
      }
      return false;
    }
    
    // 如果全局标记已关闭，也不写入
    if (streamsClosed) {
      return false;
    }
    
    try {
      // 在data前拼接时间戳 [2025/10/12 11:51:09] (东八区)
      const timestamp = getCSTTimestampString();
      const dataWithTimestamp = `[${timestamp}] ` + data;
      const result = stream.write(dataWithTimestamp);
      
      // 如果需要立即刷新（关键日志），使用 cork/uncork 机制强制刷新缓冲区
      if (flush && typeof stream.cork === 'function' && typeof stream.uncork === 'function') {
        // cork() 暂停写入，uncork() 立即刷新所有缓冲数据
        // 这里我们先 cork 再 uncork，强制刷新当前缓冲区
        stream.cork();
        // 使用 setImmediate 确保在下一个事件循环刷新
        setImmediate(() => {
          try {
            if (!stream.destroyed) {
              stream.uncork();
            }
          } catch (e) {
            // 忽略 uncork 错误
          }
        });
      }
      
      // 如果缓存已启用，标记缓存失效（只标记一次）
      // 避免频繁删除缓存，让下次读取时自动重新加载
      if (logCacheManager.isEnabled() && !cacheInvalidated) {
        logCacheManager.delete(String(projectId));
        cacheInvalidated = true;
      }
      
      return result;
    } catch (err) {
      log(projectId, "WARN", `${streamName}写入错误`, { 
        error: err.message,
        code: err.code,
        streamName: streamName,
      });
      // 只有在严重错误时才关闭所有流
      // 临时日志的错误不应该影响主日志
      if (err.code === "ERR_STREAM_WRITE_AFTER_END" || err.code === "EPIPE") {
        // 只关闭出错的流，不影响其他流
        try {
          if (stream && !stream.destroyed) {
            stream.end();
          }
        } catch (closeErr) {
          log(projectId, "WARN", `关闭${streamName}流时出错`, { error: closeErr.message });
        }
      }
      return false;
    }
  };

  // 安全关闭流的函数
  const safeCloseStreams = () => {
    if (streamsClosed) return;
    streamsClosed = true;

    try {
      if (outStream && !outStream.destroyed) {
        outStream.end();
      }
    } catch (err) {
      log(projectId, "WARN", "关闭主日志流时出错", { error: err.message });
    }

    try {
      if (tempOutStream && !tempOutStream.destroyed) {
        tempOutStream.end();
      }
    } catch (err) {
      log(projectId, "WARN", "关闭临时日志流时出错", { error: err.message });
    }
  };

  // 添加流错误处理
  const handleStreamError = (streamName, err) => {
    log(projectId, "WARN", `${streamName}流错误`, { error: err.message });
    // 如果是写入错误且子进程已退出，则关闭流
    if (
      (err.code === "ERR_STREAM_WRITE_AFTER_END" || err.code === "EPIPE") &&
      childExited
    ) {
      safeCloseStreams();
    }
  };

  try {
    // 在启动前确保可执行权限
    try {
      await ensureDevBinariesExecutable(projectPath);
    } catch (_) {}

    // 创建日志文件写入流
    outStream = fs.createWriteStream(logPath, { flags: "a" });
    tempOutStream = fs.createWriteStream(tempLogPath, { flags: "a" });

    // 组合为单个子进程内串行执行：先 dev-inject，再 vite-plugin-design-mode
    // 使用 set +e 忽略错误，确保两个命令都会执行，无论第一个是否成功
    // 注意：即使预处理命令失败，也不会阻塞后续依赖安装和 dev 启动，仅做“尽力而为”的处理
    const preCmd = "set +e ; pnpm dlx @xagi/dev-inject@latest install --framework ; pnpm dlx @xagi/vite-plugin-design-mode@latest install ; set -e";

    // 在安装依赖之前先执行预处理命令（失败不影响后续流程）
    await new Promise((resolve) => {
      try {
        const preProcess = spawn("bash", ["-lc", preCmd], {
          cwd: projectPath,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });

        preProcess.stdout.on("data", (data) => {
          const msg = data.toString();
          safeWrite(outStream, msg, "主日志");
          safeWrite(tempOutStream, msg, "临时日志");
        });

        preProcess.stderr.on("data", (data) => {
          const msg = data.toString();
          safeWrite(outStream, msg, "主日志");
          safeWrite(tempOutStream, msg, "临时日志");
        });

        preProcess.on("error", (err) => {
          const errorMessage = `预处理命令执行出错（忽略并继续后续流程）: ${err.message}\n`;
          safeWrite(outStream, errorMessage, "主日志", true);
          safeWrite(tempOutStream, errorMessage, "临时日志", true);
          resolve();
        });

        preProcess.on("close", (code) => {
          if (code !== 0) {
            const errorMessage = `预处理命令退出码为 ${code}（忽略并继续后续流程）\n`;
            safeWrite(outStream, errorMessage, "主日志", true);
            safeWrite(tempOutStream, errorMessage, "临时日志", true);
          }
          resolve();
        });
      } catch (error) {
        const errorMessage = `预处理命令启动失败（忽略并继续后续流程）: ${error.message}\n`;
        safeWrite(outStream, errorMessage, "主日志", true);
        safeWrite(tempOutStream, errorMessage, "临时日志", true);
        resolve();
      }
    });

    // 安装依赖（日志会同时写入主日志和临时日志）
    try {
      await installDependencies(req, projectId, projectPath, {
        outStream,
        tempOutStream,
        safeWrite,
      });
    } catch (error) {
      // 安装失败时记录错误并抛出（safeWrite 会自动添加时间戳）- 立即刷新到磁盘
      const errorMessage = `依赖安装失败: ${error.message}\n`;
      safeWrite(outStream, errorMessage, "主日志", true);  // flush = true
      safeWrite(tempOutStream, errorMessage, "临时日志", true);  // flush = true
      throw error;
    }

    // 在日志文件开头写入开始执行
    const startMessage = `开始执行脚本: dev\n`;
    safeWrite(outStream, startMessage, "主日志");
    safeWrite(tempOutStream, startMessage, "临时日志");

    // 构建 dev 命令参数
    const npmArgs = [];

    // 额外参数和环境变量（端口将在内部从端口池获取）
    const { extraArgs, envExtra, port } = await ExtraArgsUtils.processExtraArgs({
      devScript,
      projectId,
      req,
    });
    
    // 记录分配的端口，用于失败时释放
    allocatedPort = port;

    // 透传额外参数到脚本
    if (extraArgs && extraArgs.length > 0) {
      npmArgs.push(...extraArgs);
    }

    const escapeArg = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const extraArgsEscaped = (npmArgs && npmArgs.length > 0)
      ? npmArgs.map(escapeArg).join(" ")
      : "";

    // 记录参数信息以便调试
    if (extraArgsEscaped) {
      log(projectId, "INFO", "生成的额外参数", {
        extraArgs: extraArgs,
        npmArgs: npmArgs,
        extraArgsEscaped: extraArgsEscaped,
      });
    }

    // 检测命令是否需要通过 npx 执行
    // 如果命令是纯命令名（如 vite, next）而不是路径，应该使用 npx
    const needsNpx = (script) => {
      if (!script || typeof script !== "string") return false;
      const trimmed = script.trim();
      // 如果包含路径分隔符（/ 或 \），说明是路径，不需要 npx
      if (trimmed.includes("/") || trimmed.includes("\\")) return false;
      // 提取第一个词（命令名）
      const firstWord = trimmed.split(/\s+/)[0];
      // 如果是常见的构建工具命令名，且不是路径，需要 npx
      const commandsNeedingNpx = ["vite", "next", "webpack", "rollup", "parcel", "esbuild", "tsc", "ts-node", "astro", "svelte", "remix", "nuxt"];
      return commandsNeedingNpx.includes(firstWord);
    };

    let fullCommand;
    let execCommand = ""; // 用于记录实际执行的命令
    if (isVite) {
      // 移除脚本中已存在的 --host / --base（包含等号或跟随值），避免重复冲突
      const sanitizeCliFlags = (script, flagsToRemove) => {
        if (!script || typeof script !== "string") return script;
        let result = script;
        for (const flag of flagsToRemove) {
          // 1) 移除 --flag=value 形式
          const eqPattern = new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}=\\S+`, "g");
          result = result.replace(eqPattern, "");
          // 2) 移除 --flag <value> 形式，<value> 为非以 - 开头的单词（含路径）
          const spacedPattern = new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\s+([^\s-][^\s]*)`, "g");
          result = result.replace(spacedPattern, "");
          // 3) 移除仅有 --flag（无值）
          const barePattern = new RegExp(`${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\b`, "g");
          result = result.replace(barePattern, "");
        }
        // 归一多余空白
        return result.replace(/\s{2,}/g, " ").trim();
      };

      const cleanedScript = sanitizeCliFlags(devScript, ["--host", "--base"]);
      const appended = extraArgsEscaped ? ` ${extraArgsEscaped}` : "";
      // 如果需要 npx，使用 npx 执行命令
      const commandPrefix = needsNpx(cleanedScript) ? "npx" : "";
      execCommand = commandPrefix ? `${commandPrefix} ${cleanedScript}${appended}` : `${cleanedScript}${appended}`;
      // 使用 exec 替换 shell 进程，确保 child.pid 直接对应 vite 进程
      fullCommand = `exec ${execCommand}`;
    } else if (isNext) {
      const appended = extraArgsEscaped ? ` ${extraArgsEscaped}` : "";
      // 如果需要 npx，使用 npx 执行命令
      const commandPrefix = needsNpx(devScript) ? "npx" : "";
      execCommand = commandPrefix ? `${commandPrefix} ${devScript}${appended}` : `${devScript}${appended}`;
      fullCommand = `exec ${execCommand}`;
    } else {
      const extraForNpm = extraArgsEscaped ? ` -- ${extraArgsEscaped}` : "";
      execCommand = `pnpm run dev${extraForNpm}`;
      fullCommand = `exec ${execCommand}`;
    }

    // 将实际执行的命令写入日志文件
    if (execCommand) {
      const commandMessage = `> ${execCommand}\n`;
      safeWrite(outStream, commandMessage, "主日志");
      safeWrite(tempOutStream, commandMessage, "临时日志");
    }

    // 打印将要执行的完整命令与上下文，便于排查
    try {
      log(projectId, "INFO", "开启子进程,串行执行预处理并启动 dev:", {
        command: fullCommand,
        cwd: projectPath,
        devScript,
        extraArgs,
        envExtraKeys: Object.keys(envExtra || {}),
      });
    } catch (_) {}

    // 使用 shell 执行，以便在同一子进程中串行执行两步
    child = spawn("sh", ["-c", fullCommand], {
      cwd: projectPath,
      env: {
        PATH: process.env.PATH,        // 必需：找到命令
        //HOME: process.env.HOME,        // 用户配置目录
        NODE_ENV: 'development',      //不能指定production,否则hmr会失效
        ...envExtra,                    // 项目特定变量
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 添加日志流的错误处理
    outStream.on("error", (err) => {
      log(projectId, "ERROR", "主日志流错误", { 
        error: err.message,
        code: err.code,
        path: logPath,
        destroyed: outStream.destroyed,
      });
      handleStreamError("主日志", err);
    });
    tempOutStream.on("error", (err) => {
      log(projectId, "ERROR", "临时日志流错误", { 
        error: err.message,
        code: err.code,
        path: tempLogPath,
        destroyed: tempOutStream.destroyed,
      });
      handleStreamError("临时日志", err);
    });

    // 安全地重定向子进程输出到双日志文件
    if (child.stdout) {
      child.stdout.on("data", (data) => {
        // 使用安全的写入函数，避免向已关闭的流写入
        const mainWriteOk = safeWrite(outStream, data, "主日志");
        const tempWriteOk = safeWrite(tempOutStream, data, "临时日志");
        
        // 如果任一写入失败，记录详细信息（但不影响另一个流）
        if (!mainWriteOk || !tempWriteOk) {
          log(projectId, "DEBUG", "日志写入状态", {
            mainWriteOk,
            tempWriteOk,
            mainDestroyed: outStream ? outStream.destroyed : null,
            tempDestroyed: tempOutStream ? tempOutStream.destroyed : null,
            streamsClosed,
          });
        }
      });
      child.stdout.on("error", (err) => {
        log(projectId, "WARN", "子进程stdout错误", { error: err.message });
      });
      child.stdout.on("end", () => {
        // stdout 流结束时，不立即关闭日志流，等待子进程完全退出
        log(projectId, "INFO", "子进程stdout流已结束", { pid: child.pid });
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        // 使用安全的写入函数，避免向已关闭的流写入
        const mainWriteOk = safeWrite(outStream, data, "主日志");
        const tempWriteOk = safeWrite(tempOutStream, data, "临时日志");
        
        // 如果任一写入失败，记录详细信息（但不影响另一个流）
        if (!mainWriteOk || !tempWriteOk) {
          log(projectId, "DEBUG", "日志写入状态(stderr)", {
            mainWriteOk,
            tempWriteOk,
            mainDestroyed: outStream ? outStream.destroyed : null,
            tempDestroyed: tempOutStream ? tempOutStream.destroyed : null,
            streamsClosed,
          });
        }
      });
      child.stderr.on("error", (err) => {
        log(projectId, "WARN", "子进程stderr错误", { error: err.message });
      });
      child.stderr.on("end", () => {
        // stderr 流结束时，不立即关闭日志流，等待子进程完全退出
        log(projectId, "INFO", "子进程stderr流已结束", { pid: child.pid });
      });
    }

    // 监听子进程退出事件，安全关闭日志流
    child.on("exit", (code, signal) => {
      childExited = true;
      log(projectId, "INFO", "子进程已退出", {
        pid: child.pid,
        code,
        signal,
      });
      // 延迟关闭流，确保所有数据都已写入
      setTimeout(() => {
        safeCloseStreams();
      }, 200);
    });

    child.on("error", (err) => {
      log(projectId, "WARN", "子进程错误", { error: err.message });
      childExited = true;
      log(projectId, "ERROR", "子进程启动失败", {
        pid: child.pid,
        error: err.message,
      });
      safeCloseStreams();
    });

    runningDevProcesses.set(projectId, {
      pid: child.pid,
      logPath,
      startedAt: Date.now(),
    });

    child.unref();// 解除子进程与父进程的关联，子进程可以独立运行

    // 如果使用了 exec 命令（替换进程），需要等待 exec 完成进程替换
    // exec 会在 preCmd 成功后替换 shell 进程为实际服务进程（如 vite）
    // 这种情况下 child.pid 会直接对应服务进程，但仍需稍等确保替换完成
    const usesExec = fullCommand && fullCommand.includes("exec ");
    if (usesExec) {
      // 等待 200ms 确保 exec 完成进程替换
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    log(projectId, "INFO", "使用端口池分配的端口和当前进程ID", {
        projectId,
        pid: child.pid,
        port: port
    });

    // 轮询等待项目对外可访问，最多 30s
    const basePathFromReq =
      (req && req.query && req.query.basePath) ||
      (req && req.body && req.body.basePath) ||
      undefined;
    const resolvedBasePath = basePathFromReq || "/";
    const maxAliveWaitMs = 30000;
    const alivePollIntervalMs = 1000;
    const aliveCheckTimeoutPerRequest = 1500;

    let projectAlive = false;
    const aliveStartedAt = Date.now();
    // 启动后先等待 1s 再开始轮询，给框架预留初始化时间
    await new Promise((resolve) => setTimeout(resolve, alivePollIntervalMs));
    while (Date.now() - aliveStartedAt < maxAliveWaitMs) {
      projectAlive = await isProjectAlive(projectId, port, basePathFromReq, {
        timeoutMs: aliveCheckTimeoutPerRequest,
      });
      if (projectAlive) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, alivePollIntervalMs));
    }

    if (!projectAlive) {
      const waitSeconds = Math.round(maxAliveWaitMs / 1000);
      log(projectId, "WARN", "开发服务器在限定时间内仍不可访问", {
        port,
        pid: child.pid,
        basePath: resolvedBasePath,
        waitSeconds,
      });
    } else {
      log(projectId, "INFO", "项目可访问校验通过", {
        port,
        basePath: resolvedBasePath,
        elapsedMs: Date.now() - aliveStartedAt,
      });
    }

    // 回填端口和实际进程ID
    const info = runningDevProcesses.get(projectId);
    if (info) {
      info.port = port;
      info.pid = child.pid; // 进程组pid
      runningDevProcesses.set(projectId, info);
    }

    log(projectId, "INFO", "开发服务器启动成功", {
      projectId,
      pid: child.pid,
      port: port,
    });

    //要返回进程组pid和端口，因为后续需要通过进程组pid来停止进程
    return { pid: child.pid, port: port };
  } catch (error) {
    // 启动失败，释放已分配的端口
    if (allocatedPort) {
      portPool.release(String(projectId));
      log(projectId, "INFO", "启动失败，已释放端口", { 
        port: allocatedPort,
        error: error.message 
      });
    }
    // 重新抛出错误
    throw error;
  } finally {
    // 只有在发生异常或子进程启动失败时才立即清理资源
    // 正常情况下，流会在子进程退出时自动关闭
    if (childExited || !child || !child.pid) {
      safeCloseStreams();
    }
  }
}

/**
 * 停止指定的进程
 * @param {string} projectId 项目ID
 * @param {number} pid 进程ID
 * @returns {Promise<boolean>} 是否成功停止
 */
async function killProcess(projectId, pid) {
  const pidNum = Number(pid);
  if (!Number.isFinite(pidNum)) {
    return false;
  }

  // 首先检查进程是否存在
  if (!isProcessRunning(pidNum)) {
    log(projectId, "INFO", "进程已不存在", { pid: pidNum });
    runningDevProcesses.delete(projectId);
    return true;
  }

  let killed = false;
  let killMethod = "";

  try {
    // 优先杀进程组（detached）
    process.kill(-pidNum);
    killed = true;
    killMethod = "进程组";
    log(projectId, "INFO", "通过进程组杀死进程", { pid: pidNum });
  } catch (e) {
    if (e && (e.code === "ESRCH" || e.errno === "ESRCH")) {
      // 进程组不存在，不能认为已杀死；继续尝试对单个进程发送信号
      killed = false;
      killMethod = "进程组(不存在)";
      log(projectId, "INFO", "进程组不存在，回退尝试单个进程kill", { pid: pidNum });
    } else {
      log(projectId, "WARN", "杀死进程组失败", {
        pid: pidNum,
        error: e.message,
      });
    }
  }

  if (!killed) {
    try {
      process.kill(pidNum);
      killed = true;
      killMethod = "单个进程";
      log(projectId, "INFO", "通过单个进程杀死进程", { pid: pidNum });
    } catch (e) {
      if (e && (e.code === "ESRCH" || e.errno === "ESRCH")) {
        killed = true;
        killMethod = "单个进程(不存在)";
        log(projectId, "INFO", "进程不存在，视为已停止", { pid: pidNum });
      } else {
        log(projectId, "ERROR", "杀死进程失败", {
          pid: pidNum,
          error: e.message,
        });
      }
    }
  }

  // 验证进程是否真的被杀死了
  if (killed) {
    // 等待一小段时间让进程完全退出
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (!isProcessRunning(pidNum)) {
      log(projectId, "INFO", "进程已成功停止", {
        pid: pidNum,
        method: killMethod,
      });
      runningDevProcesses.delete(projectId);
      return true;
    } else {
      log(projectId, "WARN", "进程仍然存在，kill可能失败", {
        pid: pidNum,
        method: killMethod,
      });
      return false;
    }
  }

  return killed;
}

/**
 * 检查进程是否正在运行
 * @param {number} pid 进程ID
 * @returns {boolean}
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0); // 发送信号0检查进程是否存在
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      // 进程存在，但当前用户无权限发送信号
      return true;
    }
    if (err && err.code === 'ESRCH') {
      // 进程不存在
      return false;
    }
    // 其他错误，保守返回 false，或根据需要上报日志
    return false;
  }
}

/**
 * 等待进程停止
 * @param {string} projectId 项目ID
 * @param {number} pid 进程ID
 * @returns {Promise<Object>} { stopped: boolean, attempts: number }
 */
async function waitForProcessStop(projectId, pid) {
  let attempts = 0;
  const maxAttempts = config.DEV_SERVER_STOP_MAX_ATTEMPTS;
  while (isProcessRunning(pid) && attempts < maxAttempts) {
    await new Promise((resolve) =>
      setTimeout(resolve, config.DEV_SERVER_STOP_CHECK_INTERVAL)
    );
    attempts++;
  }

  const stopped = !isProcessRunning(pid);
  return { stopped, attempts };
}

/**
 * 列出所有运行中的进程
 * @returns {Array} 进程列表
 */
function listRunningProcesses() {
  const list = Array.from(runningDevProcesses.entries()).map(([id, info]) => ({
    projectId: id,
    pid: info.pid,
    type: info.type,
    startedAt: info.startedAt,
    port: info.port,
  }));
  return list;
}

export {
  getRunningProcess,
  setRunningProcess,
  deleteRunningProcess,
  isProjectStarting,
  addStartingProject,
  removeStartingProject,
  startDev_NonBlocking,
  killProcess,
  isProcessRunning,
  waitForProcessStop,
  listRunningProcesses,
};
