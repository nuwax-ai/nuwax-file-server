import { ValidationError, ProcessError } from "../error/errorHandler.js";
import {
  killProcess,
  getRunningProcess,
  waitForProcessStop,
} from "./processManager.js";
import { log, getLogDir } from "../log/logUtils.js";
import logCacheManager from "../log/logCacheManager.js";
import portPool from "../buildArg/portPool.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";



function findPidsByProjectId(projectId) {
  try {
    const cmd = "ps -Ao pid,command -ww";
    const output = execSync(cmd, { encoding: "utf8" });
    const lines = output.split("\n");
    const pids = [];
    const preciseNeedle = "/" + String(projectId);

    // 匹配包含 /{projectId} 的路径片段，避免误匹配
    for (const line of lines) {
      if (!line) continue;
      if (line.includes(preciseNeedle)) {
        const trimmed = line.trim();
        const firstSpace = trimmed.indexOf(" ");
        const pidStr = firstSpace > 0 ? trimmed.slice(0, firstSpace) : trimmed;
        const pidNum = Number(pidStr);
        if (Number.isFinite(pidNum)) {
          pids.push(pidNum);
        }
      }
    }

    // 回退：使用宽松的包含 projectId 匹配（可能带来噪声）
    if (pids.length === 0) {
      for (const line of lines) {
        if (!line) continue;
        if (line.includes(String(projectId))) {
          const trimmed = line.trim();
          const firstSpace = trimmed.indexOf(" ");
          const pidStr = firstSpace > 0 ? trimmed.slice(0, firstSpace) : trimmed;
          const pidNum = Number(pidStr);
          if (Number.isFinite(pidNum)) {
            pids.push(pidNum);
          }
        }
      }
    }

    return Array.from(new Set(pids));
  } catch (_) {
    return [];
  }
}

/**
 * 停止开发服务器
 * @param {Object} req 请求对象
 * @param {string} projectId 项目ID
 * @param {number|string} pid 进程ID（可选，如果不提供会从运行表中获取）
 * @param {Object} options 选项
 * @param {boolean} options.strict 是否严格模式，严格模式下停止失败会抛出异常
 * @param {boolean} options.waitForStop 是否等待进程完全停止
 * @returns {Promise<Object>} 停止结果
 *
 * 功能说明：
 * 1. 确定要停止的进程ID
 * 2. 停止进程
 * 3. 等待进程完全停止（可选）
 * 4. 清理项目下的所有临时日志文件（dev-temp-*.log）
 */
async function stopDevServerByPid(req, projectId, pid, options = {}) {
  const { strict = true, waitForStop = false } = options;

  log(projectId, "INFO", "Start stopping development server", {
    projectId,
    pid,
    strict,
    waitForStop,
    requestId: req.requestId,
  });

  let pidToKill = null;
  let existingProcess = null;

  // 1. 确定要停止的进程ID
  if (pid !== undefined && pid !== null) {
    const pidNum = Number(pid);
    if (Number.isFinite(pidNum)) {
      pidToKill = pidNum;
      log(projectId, "INFO", "Stop development server using incoming pid", {
        projectId,
        pid: pidToKill,
        requestId: req.requestId,
      });
    } else {
      log(projectId, "WARN", "Incoming pid is invalid", {
        projectId,
        invalidPid: pid,
        requestId: req.requestId,
      });

      if (strict) {
        throw new ValidationError("Process ID is invalid", { field: "pid", value: pid });
      }
    }
  }

  // 如果传入的pid无效或未提供，从运行表中获取
  if (!pidToKill) {
    existingProcess = getRunningProcess(projectId);
    if (existingProcess) {
      pidToKill = existingProcess.pid;
      log(projectId, "INFO", "Get pid to stop development server from running table", {
        projectId,
        pid: pidToKill,
        requestId: req.requestId,
      });
    } else {
      log(projectId, "INFO", "No development server process found to stop", {
        projectId,
        requestId: req.requestId,
      });

      if (strict) {
        throw new ProcessError("No running development server process found", { projectId });
      }

      // 即使未找到进程，也尝试释放端口（可能进程已意外退出）
      portPool.release(String(projectId));
      log(projectId, "INFO", "Port released (process not running)", {
        projectId,
        requestId: req.requestId,
      });

      return {
        success: true,
        message: "No running process found",
        projectId,
        pid: null,
      };
    }
  }

  // 2. 停止进程
  const killed = await killProcess(projectId, pidToKill);

  if (killed) {
    log(projectId, "INFO", "Development server stopped", {
      projectId,
      pid: pidToKill,
      requestId: req.requestId,
    });
  } else {
    log(projectId, "WARN", "Failed to stop development server", {
      projectId,
      pid: pidToKill,
      requestId: req.requestId,
    });

    if (strict) {
      throw new ProcessError("Failed to stop process", { projectId, pid: pidToKill });
    }
  }

  // 3. 等待进程完全停止（可选）
  if (waitForStop && killed) {
    const { stopped, attempts } = await waitForProcessStop(
      projectId,
      pidToKill
    );

    if (!stopped) {
      log(projectId, "WARN", "Process stop timeout", {
        projectId,
        pid: pidToKill,
        attempts,
        requestId: req.requestId,
      });

      if (strict) {
        throw new ProcessError("Process stop timeout", {
          projectId,
          pid: pidToKill,
          attempts,
        });
      }
    } else {
      log(projectId, "INFO", "Process confirmed stopped", {
        projectId,
        pid: pidToKill,
        attempts,
        requestId: req.requestId,
      });
    }
  }

  // 4. 清理项目下的所有临时日志文件
  try {
    const logDir = getLogDir(projectId);
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      const tempFiles = files.filter(
        (file) => file.startsWith("dev-temp-") && file.endsWith(".log")
      );

      if (tempFiles.length > 0) {
        let deletedCount = 0;
        for (const tempFile of tempFiles) {
          try {
            const tempFilePath = path.join(logDir, tempFile);
            fs.unlinkSync(tempFilePath);
            deletedCount++;
          } catch (err) {
            log(projectId, "WARN", "Failed to delete temporary log file", {
              projectId,
              tempFile,
              error: err.message,
              requestId: req.requestId,
            });
          }
        }

        log(projectId, "INFO", "Temporary log file cleanup completed", {
          projectId,
          deletedCount,
          totalTempFiles: tempFiles.length,
          requestId: req.requestId,
        });
      }
    }
  } catch (err) {
    log(projectId, "WARN", "Error cleaning temporary log files", {
      projectId,
      error: err.message,
      requestId: req.requestId,
    });
  }

  // 5. 删除该项目的日志缓存
  try {
    if (logCacheManager.isEnabled()) {
      logCacheManager.delete(projectId);
      log(projectId, "INFO", "Log cache cleaned", {
        projectId,
        requestId: req.requestId,
      });
    }
  } catch (err) {
    log(projectId, "WARN", "Error cleaning log cache", {
      projectId,
      error: err.message,
      requestId: req.requestId,
    });
  }

  // 6. 停止成功后释放端口
  if (killed) {
    portPool.release(String(projectId));
    log(projectId, "INFO", "Port released", {
      projectId,
      requestId: req.requestId,
    });
  }

  return {
    success: true,
    message: killed ? "Stopped" : "Failed to stop but continue execution",
    projectId,
    pid: pidToKill,
  };
}

async function stopDevServerByProjectId(req, projectId, options = {}) {
  const { strict = true, waitForStop = false } = options;

  log(projectId, "INFO", "Start stopping development server(stop all by projectId)", {
    projectId,
    strict,
    waitForStop,
    requestId: req.requestId,
  });

  // 忽略传入的 pid，按 projectId 通过系统进程检索
  const uniquePids = findPidsByProjectId(projectId);
  const candidates = uniquePids.map((pid) => ({ pid }));

  if (!candidates || candidates.length === 0) {
    log(projectId, "INFO", "No development server process found to stop", {
      projectId,
      requestId: req.requestId,
    });

    // if (strict) {
    //   throw new ProcessError("未找到运行中的开发服务器进程", { projectId });
    // }

    // 即使未找到进程，也尝试释放端口（可能进程已意外退出）
    portPool.release(String(projectId));
    log(projectId, "INFO", "Port released (process not running)", {
      projectId,
      requestId: req.requestId,
    });

    return {
      success: true,
      message: "No running process found",
      projectId,
      pid: null,
    };
  }

  const results = [];

  for (const thePid of uniquePids) {
    const killed = await killProcess(projectId, thePid);
    results.push({ pid: thePid, killed });

    if (waitForStop && killed) {
      const { stopped, attempts } = await waitForProcessStop(projectId, thePid);
      log(projectId, stopped ? "INFO" : "WARN", stopped ? "Process confirmed stopped" : "Process stop timeout", {
        projectId,
        pid: thePid,
        attempts,
        requestId: req.requestId,
      });

      if (!stopped && strict) {
        throw new ProcessError("Process stop timeout", {
          projectId,
          pid: thePid,
          attempts,
        });
      }
    } else if (!killed && strict) {
      throw new ProcessError("Failed to stop process", { projectId, pid: thePid });
    }
  }

  // 清理项目下的所有临时日志文件
  try {
    const logDir = getLogDir(projectId);
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      const tempFiles = files.filter(
        (file) => file.startsWith("dev-temp-") && file.endsWith(".log")
      );

      if (tempFiles.length > 0) {
        let deletedCount = 0;
        for (const tempFile of tempFiles) {
          try {
            const tempFilePath = path.join(logDir, tempFile);
            fs.unlinkSync(tempFilePath);
            deletedCount++;
          } catch (err) {
            log(projectId, "WARN", "Failed to delete temporary log file", {
              projectId,
              tempFile,
              error: err.message,
              requestId: req.requestId,
            });
          }
        }

        log(projectId, "INFO", "Temporary log file cleanup completed", {
          projectId,
          deletedCount,
          totalTempFiles: tempFiles.length,
          requestId: req.requestId,
        });
      }
    }
  } catch (err) {
    log(projectId, "WARN", "Error cleaning temporary log files", {
      projectId,
      error: err.message,
      requestId: req.requestId,
    });
  }

  // 删除该项目的日志缓存
  try {
    if (logCacheManager.isEnabled()) {
      logCacheManager.delete(projectId);
      log(projectId, "INFO", "Log cache cleaned", {
        projectId,
        requestId: req.requestId,
      });
    }
  } catch (err) {
    log(projectId, "WARN", "Error cleaning log cache", {
      projectId,
      error: err.message,
      requestId: req.requestId,
    });
  }

  const allKilled = results.every((r) => r.killed === true);
  
  // 停止成功后释放端口
  if (allKilled && results.length > 0) {
    portPool.release(String(projectId));
    log(projectId, "INFO", "Port released", {
      projectId,
      requestId: req.requestId,
    });
  }
  
  return {
    success: true,
    message: allKilled ? "Stopped" : "Partially stopped but continue execution",
    projectId,
    pid: null,
    killedPids: results,
  };
}


async function stopDevServer(req, projectId, pid, options = {}) {
  return await stopDevServerByProjectId(req, projectId, options);
}

export { stopDevServer };
