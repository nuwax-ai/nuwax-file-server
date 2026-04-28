/**
 * 服务管理器模块
 *
 * 功能: 提供跨平台的服务启动、停止、重启、状态查询功能
 *
 * 跨平台支持:
 * - Windows: 使用 taskkill 命令
 * - Linux/macOS: 使用 kill 信号
 *
 * PID 文件管理:
 * - 使用 os.tmpdir() 获取临时目录
 * - Windows: %TEMP%/nuwax-file-server/server.pid
 * - Linux/macOS: /tmp/nuwax-file-server/server.pid
 */

import path from "path";
import os from "os";
import fs from "fs-extra";
import { spawn } from "cross-spawn";
import treeKill from "tree-kill";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import http from "http";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const esmRequire = createRequire(import.meta.url);

// 服务配置
const SERVICE_CONFIG = {
  // 服务名称
  name: 'nuwax-file-server',
  // PID 文件目录
  pidDir: path.join(os.tmpdir(), 'nuwax-file-server'),
  // PID 文件名
  pidFileName: 'server.pid',
  lockFileName: 'start.lock',
  // 默认停止超时时间（毫秒）
  defaultStopTimeout: 30000,
  // 默认启动健康检查超时时间（毫秒）
  defaultStartTimeout: 30000,
  // 启动锁陈旧超时时间（毫秒）
  staleLockTimeout: 120000,
  // 检查进程间隔（毫秒）
  checkInterval: 500,
};

/**
 * 获取 PID 文件完整路径
 * 
 * 使用 os.tmpdir() 确保跨平台兼容性
 * 
 * @returns {string} PID 文件路径
 */
function getPidFilePath() {
  return path.join(SERVICE_CONFIG.pidDir, SERVICE_CONFIG.pidFileName);
}

/**
 * 获取启动锁文件完整路径
 *
 * @returns {string} 锁文件路径
 */
function getLockFilePath() {
  return path.join(SERVICE_CONFIG.pidDir, SERVICE_CONFIG.lockFileName);
}

/**
 * 解析服务入口脚本路径（兼容 src 与 dist）
 *
 * @returns {string} server.js 完整路径
 */
function resolveServerScriptPath() {
  const candidates = [
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, 'server.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

/**
 * 读取 package 版本号（兼容 src 与 dist）
 *
 * @returns {string} 版本号
 */
function resolvePackageVersion() {
  const candidates = [
    '../../package.json',
    '../package.json',
  ];

  for (const relPath of candidates) {
    try {
      const pkg = esmRequire(relPath);
      if (pkg?.version) {
        return pkg.version;
      }
    } catch (err) {
      // 尝试下一个候选路径
    }
  }

  return 'unknown';
}

/**
 * 读取 PID 文件
 * 
 * 读取并解析 PID 文件内容
 * 
 * @returns {Object|null} PID 信息对象，如果文件不存在或解析失败则返回 null
 * @property {number} pid - 进程 ID
 * @property {string} startedAt - 启动时间 ISO 字符串
 * @property {string} env - 环境名称
 * @property {string} port - 端口号
 * @property {string} version - 版本号
 * @property {string} platform - 操作系统平台
 */
function readPidFile() {
  try {
    const pidPath = getPidFilePath();
    
    // 检查文件是否存在
    if (!fs.existsSync(pidPath)) {
      return null;
    }
    
    // 读取并解析文件内容
    const content = fs.readFileSync(pidPath, 'utf8');
    const pidInfo = JSON.parse(content);
    
    // 验证 PID 信息完整性
    if (!pidInfo || typeof pidInfo.pid !== 'number') {
      return null;
    }
    
    return pidInfo;
  } catch (err) {
    // 文件不存在或解析失败
    if (err.code !== 'ENOENT') {
      console.error(`Read PID file failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * 写入 PID 文件
 * 
 * 将进程信息写入 PID 文件
 * 
 * @param {Object} pidInfo - PID 信息对象
 * @param {number} pidInfo.pid - 进程 ID
 * @param {string} pidInfo.startedAt - 启动时间 ISO 字符串
 * @param {string} [pidInfo.env] - 环境名称
 * @param {string} [pidInfo.port] - 端口号
 * @param {string} [pidInfo.version] - 版本号
 * @param {string} [pidInfo.platform] - 操作系统平台
 */
function writePidFile(pidInfo) {
  try {
    const pidPath = getPidFilePath();
    
    // 确保目录存在
    fs.ensureDirSync(SERVICE_CONFIG.pidDir);
    
    // 写入文件
    fs.writeFileSync(pidPath, JSON.stringify(pidInfo, null, 2));
    
    console.debug(`PID file written: ${pidPath}`);
  } catch (err) {
    console.error(`Write PID file failed: ${err.message}`);
    throw err;
  }
}

/**
 * 删除 PID 文件
 * 
 * 清理 PID 文件（服务停止时调用）
 */
function deletePidFile() {
  try {
    const pidPath = getPidFilePath();
    
    if (fs.existsSync(pidPath)) {
      fs.removeSync(pidPath);
      console.debug(`PID file deleted: ${pidPath}`);
    }
  } catch (err) {
    console.error(`Delete PID file failed: ${err.message}`);
  }
}

/**
 * 检查进程是否正在运行
 * 
 * 使用 process.kill(pid, 0) 检测进程是否存在
 * 
 * @param {number} pid - 进程 ID
 * @returns {boolean} 进程是否正在运行
 */
function isProcessRunning(pid) {
  try {
    // 发送信号 0 来检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: 进程不存在
    // EPERM: 进程存在但无权限（仍视为存在）
    if (err.code === 'ESRCH') {
      return false;
    }
    // 其他错误保守返回 true
    return true;
  }
}

/**
 * 获取进程命令行（跨平台）
 *
 * @param {number} pid - 进程 ID
 * @returns {string} 进程命令行，读取失败时返回空字符串
 */
function getProcessCommand(pid) {
  try {
    if (isWindows()) {
      const command = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return command.trim();
    }

    const command = execFileSync(
      'ps',
      ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return command.trim();
  } catch (err) {
    return '';
  }
}

/**
 * 校验进程是否为当前服务进程
 *
 * @param {number} pid - 进程 ID
 * @returns {boolean} 是否为目标服务进程
 */
function isTargetServiceProcess(pid) {
  if (!isProcessRunning(pid)) {
    return false;
  }

  const command = getProcessCommand(pid);
  if (!command) {
    // 无法读取命令行时不判定为目标进程，避免误杀非目标进程
    return false;
  }

  const lower = command.toLowerCase();
  const serviceScriptName = path.basename(path.join(__dirname, '..', 'server.js')).toLowerCase();
  const serviceName = SERVICE_CONFIG.name.toLowerCase();
  return lower.includes(serviceScriptName) || lower.includes(serviceName);
}

/**
 * 获取启动锁，防止并发启动导致竞态
 *
 * @returns {number} 锁文件描述符
 */
function acquireStartLock() {
  fs.ensureDirSync(SERVICE_CONFIG.pidDir);
  const lockPath = getLockFilePath();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify(
    { pid: process.pid, token, createdAt: new Date().toISOString() },
    null,
    2
  );

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, payload);
    return { fd, token };
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }

    // 无人值守场景下自动清理陈旧锁，避免永远阻塞启动
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const lockInfo = JSON.parse(raw);
      const holderPid = Number(lockInfo?.pid);
      const createdAt = lockInfo?.createdAt ? new Date(lockInfo.createdAt).getTime() : 0;
      const lockAge = Date.now() - createdAt;
      const holderAlive = Number.isFinite(holderPid) && holderPid > 0 && isProcessRunning(holderPid);
      const expired = !createdAt || Number.isNaN(lockAge) || lockAge > SERVICE_CONFIG.staleLockTimeout;

      if (!holderAlive || expired) {
        fs.removeSync(lockPath);
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, payload);
        console.warn('Detected stale start lock, auto cleaned');
        return { fd, token };
      }
    } catch (parseErr) {
      // 锁文件损坏时直接重建
      fs.removeSync(lockPath);
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, payload);
      console.warn('Detected invalid start lock, auto cleaned');
      return { fd, token };
    }

    throw err;
  }
}

/**
 * 释放启动锁
 *
 * @param {Object|null} lockHandle - 锁信息对象
 */
function releaseStartLock(lockHandle) {
  const lockFd = lockHandle?.fd;
  const lockToken = lockHandle?.token;

  try {
    if (lockFd !== null && lockFd !== undefined) {
      fs.closeSync(lockFd);
    }
  } catch (err) {
    // 忽略关闭错误
  }

  try {
    const lockPath = getLockFilePath();
    if (fs.existsSync(lockPath)) {
      let shouldRemove = false;

      if (!lockToken) {
        shouldRemove = true;
      } else {
        try {
          const raw = fs.readFileSync(lockPath, 'utf8');
          const lockInfo = JSON.parse(raw);
          shouldRemove = lockInfo?.token === lockToken;
        } catch (err) {
          // 无法解析时保守清理，避免锁残留
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        fs.removeSync(lockPath);
      }
    }
  } catch (err) {
    // 忽略清理错误
  }
}

/**
 * 检测当前操作系统是否为 Windows
 * 
 * @returns {boolean} 是否为 Windows 系统
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * 启动前确保没有旧服务进程残留
 *
 * 处理策略：
 * 1. 若 PID 文件不存在或进程已退出：直接清理并返回
 * 2. 若进程存在：先尝试优雅停止，再尝试强制停止
 * 3. 最终统一清理 PID 文件，避免后续启动被旧状态阻塞
 *
 * @param {number} [timeout=SERVICE_CONFIG.defaultStopTimeout] - 停止等待超时（毫秒）
 * @returns {Promise<Object>} 处理结果
 * @property {boolean} success - 是否成功
 * @property {string} message - 处理结果消息
 */
async function ensureNoRunningServiceBeforeStart(timeout = SERVICE_CONFIG.defaultStopTimeout) {
  const pidInfo = readPidFile();

  // 无 PID 文件，无需处理
  if (!pidInfo) {
    return {
      success: true,
      message: 'No existing service process',
    };
  }

  // PID 对应进程不存在，清理残留 PID 文件
  if (!isTargetServiceProcess(pidInfo.pid)) {
    console.log(`Found stale PID file (PID: ${pidInfo.pid}), clean it...`);
    deletePidFile();
    return {
      success: true,
      message: 'Stale PID file cleaned',
    };
  }

  console.log(`Existing service process detected (PID: ${pidInfo.pid}), stopping before start...`);

  // 先尝试优雅停止
  const gracefulStopped = await stopProcess(pidInfo.pid, false);
  if (gracefulStopped) {
    const exited = await waitForProcessStop(pidInfo.pid, timeout);
    if (exited) {
      deletePidFile();
      return {
        success: true,
        message: `Existing process ${pidInfo.pid} stopped gracefully`,
      };
    }
  }

  // 优雅停止失败后，强制停止
  console.warn(`Graceful stop timeout or failed for PID ${pidInfo.pid}, force stop...`);
  const forceStopped = await stopProcess(pidInfo.pid, true);
  if (!forceStopped) {
    return {
      success: false,
      message: `Failed to stop existing process ${pidInfo.pid}`,
    };
  }

  const forceExited = await waitForProcessStop(pidInfo.pid, timeout);
  if (!forceExited) {
    return {
      success: false,
      message: `Existing process ${pidInfo.pid} did not exit after force stop`,
    };
  }

  deletePidFile();
  return {
    success: true,
    message: `Existing process ${pidInfo.pid} stopped forcibly`,
  };
}

/**
 * 停止进程（跨平台实现）
 * 
 * Windows 使用 taskkill 命令
 * Linux/macOS 使用 kill 信号
 * 
 * @param {number} pid - 进程 ID
 * @param {boolean} [force=false] - 是否强制停止（SIGKILL）
 * @returns {Promise<boolean>} 是否成功停止
 */
async function stopProcess(pid, force = false) {
  return new Promise((resolve) => {
    // 如果进程不存在，直接返回成功
    if (!isProcessRunning(pid)) {
      console.debug(`Process ${pid} does not exist, already stopped`);
      resolve(true);
      return;
    }
    
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    const killMethod = isWindows() ? 'taskkill' : 'tree-kill';
    
    console.debug(`Use ${killMethod} to stop process ${pid} (signal: ${signal})`);
    
    if (isWindows()) {
      // Windows: 使用 taskkill 命令
      const args = force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)];
      
      const child = spawn('taskkill', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      
      let output = '';
      
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      
      child.on('error', (err) => {
        console.error(`Stop process failed: ${err.message}`);
        resolve(false);
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          console.debug(`Process ${pid} stopped`);
          resolve(true);
        } else {
          console.warn(`taskkill exit code: ${code}, output: ${output}`);
          
          // 如果非强制模式，尝试强制停止
          if (!force) {
            stopProcess(pid, true).then(resolve);
          } else {
            resolve(false);
          }
        }
      });
    } else {
      // Linux/macOS: 使用 tree-kill（确保杀死整个进程树）
      treeKill(pid, signal, (err) => {
        if (err) {
          if (err.code === 'ESRCH') {
            // 进程不存在
            console.debug(`Process ${pid} does not exist`);
            resolve(true);
          } else {
            console.error(`Stop process failed: ${err.message}`);
            resolve(false);
          }
        } else {
          console.debug(`Process ${pid} stopped`);
          resolve(true);
        }
      });
    }
  });
}

/**
 * 等待进程停止
 * 
 * 轮询检查进程是否已停止
 * 
 * @param {number} pid - 进程 ID
 * @param {number} [timeout=SERVICE_CONFIG.defaultStopTimeout] - 超时时间（毫秒）
 * @returns {Promise<boolean>} 是否在超时前停止
 */
async function waitForProcessStop(pid, timeout = SERVICE_CONFIG.defaultStopTimeout) {
  const startTime = Date.now();
  
  while (isProcessRunning(pid)) {
    // 检查是否超时
    if (Date.now() - startTime > timeout) {
      console.warn(`Wait for process ${pid} to stop timeout (${timeout}ms)`);
      return false;
    }
    
    // 等待检查间隔
    await new Promise((resolve) => 
      setTimeout(resolve, SERVICE_CONFIG.checkInterval)
    );
  }
  
  const elapsed = Date.now() - startTime;
  console.debug(`Process ${pid} stopped after ${elapsed}ms`);
  return true;
}

/**
 * 等待服务健康检查通过
 *
 * 轮询访问 /health，直到返回 2xx 或超时
 *
 * @param {string|number} port - 服务端口
 * @param {number} [timeout=SERVICE_CONFIG.defaultStartTimeout] - 超时时间（毫秒）
 * @returns {Promise<boolean>} 是否在超时前通过健康检查
 */
async function waitForServiceHealth(port, timeout = SERVICE_CONFIG.defaultStartTimeout) {
  const targetPort = Number(port);
  if (!Number.isFinite(targetPort) || targetPort <= 0) {
    return false;
  }

  const startTime = Date.now();
  while (Date.now() - startTime <= timeout) {
    const healthy = await new Promise((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: targetPort,
          path: '/health',
          timeout: Math.min(2000, SERVICE_CONFIG.checkInterval * 4),
        },
        (res) => {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
          res.resume();
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });

    if (healthy) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, SERVICE_CONFIG.checkInterval));
  }

  return false;
}

/**
 * 启动服务
 * 
 * 启动 nuwax-file-server 服务进程
 * 
 * @param {Object} options - 启动选项
 * @param {string} [options.env] - 环境名称
 * @param {string} [options.port] - 端口号
 * @param {string} [options.config] - 配置文件路径
 * @returns {Promise<Object>} 启动结果
 * @property {boolean} success - 是否成功
 * @property {number} pid - 进程 ID
 * @property {string} message - 状态消息
 */
async function startService(options = {}) {
  const { env, port, config } = options;
  let lockHandle = null;
  
  console.log(`Start service ${SERVICE_CONFIG.name}...`);

  try {
    lockHandle = acquireStartLock();
  } catch (err) {
    if (err.code === 'EEXIST') {
      return {
        success: false,
        pid: null,
        message: 'Another start operation is in progress, please retry later',
      };
    }

    return {
      success: false,
      pid: null,
      message: `Acquire start lock failed: ${err.message}`,
    };
  }
  
  try {
    // 启动前先清理/停止历史进程，确保本次启动可继续进行
    const stopTimeout = Number(options.timeout) || SERVICE_CONFIG.defaultStopTimeout;
    const preStartResult = await ensureNoRunningServiceBeforeStart(stopTimeout);
    if (!preStartResult.success) {
      return {
        success: false,
        pid: null,
        message: `Service start blocked: ${preStartResult.message}`,
      };
    }
  
    // 构建环境变量
    const envVars = { ...process.env };
  
    if (env) {
      envVars.NODE_ENV = env;
      console.log(`Environment: ${env}`);
    }
  
    if (port) {
      envVars.PORT = port;
      console.log(`Port: ${port}`);
    }
  
    if (config) {
      envVars.CONFIG_FILE = config;
      console.log(`Configuration file: ${config}`);
    }
  
    // 构建启动参数
    const serverScript = resolveServerScriptPath();
    const args = [];
  
    // 使用 cross-spawn 确保跨平台兼容性
    const child = spawn('node', [serverScript, ...args], {
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      cwd: process.cwd(),
    });
  
    // 处理子进程输出
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
    });
  
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  
    child.on('error', (err) => {
      console.error(`Start service failed: ${err.message}`);
    });
  
    // 等待服务启动
    await new Promise((resolve) => setTimeout(resolve, 2000));
  
    // 检查服务是否成功启动
    if (!isProcessRunning(child.pid)) {
      return {
        success: false,
        pid: null,
        message: 'Service start failed',
      };
    }
  
    // 写入 PID 文件
    const pidInfo = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      env: env || process.env.NODE_ENV || 'production',
      port: port || process.env.PORT || '60000',
      version: resolvePackageVersion(),
      platform: process.platform,
    };
  
    writePidFile(pidInfo);

    // 健康检查通过后再认定启动成功
    const healthTimeout = Number(options.startTimeout) || SERVICE_CONFIG.defaultStartTimeout;
    const healthy = await waitForServiceHealth(pidInfo.port, healthTimeout);
    if (!healthy) {
      console.error(`Service health check timeout (${healthTimeout}ms), stop failed instance...`);
      await stopProcess(child.pid, true);
      deletePidFile();
      return {
        success: false,
        pid: null,
        message: `Service health check timeout (${healthTimeout}ms)`,
      };
    }
  
    // 解除子进程关联，使其独立运行
    child.unref();
  
    console.log(`Service started (PID: ${child.pid})`);
    console.log(`Service address: http://localhost:${pidInfo.port}`);
  
    return {
      success: true,
      pid: child.pid,
      message: 'Service started successfully',
    };
  } finally {
    releaseStartLock(lockHandle);
  }
}

/**
 * 停止服务
 * 
 * 停止 nuwax-file-server 服务进程
 * 
 * @param {Object} options - 停止选项
 * @param {boolean} [options.force=false] - 是否强制停止
 * @param {number} [options.timeout] - 超时时间（毫秒）
 * @returns {Promise<Object>} 停止结果
 * @property {boolean} success - 是否成功
 * @property {string} message - 状态消息
 */
async function stopService(options = {}) {
  const { force = false, timeout = SERVICE_CONFIG.defaultStopTimeout } = options;
  
  console.log(`Stop service ${SERVICE_CONFIG.name}...`);
  
  // 读取 PID 文件
  const pidInfo = readPidFile();
  
  if (!pidInfo) {
    return {
      success: false,
      message: 'Service not found',
    };
  }
  
  // 检查进程是否正在运行
  if (!isProcessRunning(pidInfo.pid)) {
    console.log('Service process has stopped, clean PID file...');
    deletePidFile();
    
    return {
      success: true,
      message: 'Service has stopped (process has exited)',
    };
  }
  
  // 停止进程
  const stopped = await stopProcess(pidInfo.pid, force);
  
  if (!stopped) {
    return {
      success: false,
      message: 'Stop service failed',
    };
  }
  
  // 等待进程完全退出
  const exited = await waitForProcessStop(pidInfo.pid, timeout);
  
  // 清理 PID 文件
  deletePidFile();
  
  if (exited) {
    return {
      success: true,
      message: 'Service has stopped',
    };
  } else {
    return {
      success: false,
      message: 'Service stop timeout',
    };
  }
}

/**
 * 重启服务
 * 
 * 先停止服务，再启动服务
 * 
 * @param {Object} options - 重启选项（传递给 startService 和 stopService）
 * @returns {Promise<Object>} 重启结果
 */
async function restartService(options = {}) {
  console.log(`Restart service ${SERVICE_CONFIG.name}...`);
  
  // 先停止服务
  const stopResult = await stopService(options);
  
  // 如果停止失败但服务可能未运行，继续尝试启动
  if (!stopResult.success && stopResult.message !== 'Service not found') {
    console.warn(`Stop service failed: ${stopResult.message}`);
  }
  
  // 等待一段时间
  await new Promise((resolve) => setTimeout(resolve, 2000));
  
  // 启动服务
  const startResult = await startService(options);
  
  if (startResult.success) {
    return {
      success: true,
      pid: startResult.pid,
      message: 'Service has restarted',
    };
  } else {
    return {
      success: false,
      pid: null,
      message: `Restart failed: ${startResult.message}`,
    };
  }
}

/**
 * 获取服务状态
 * 
 * @returns {Object} 服务状态
 * @property {boolean} running - 服务是否运行中
 * @property {Object|null} pidInfo - PID 信息对象
 * @property {string} message - 状态消息
 */
function getServiceStatus() {
  const pidInfo = readPidFile();
  
  if (!pidInfo) {
    return {
      running: false,
      pidInfo: null,
      message: 'Service not running',
    };
  }
  
  const running = isProcessRunning(pidInfo.pid);
  
  if (running) {
    return {
      running: true,
      pidInfo: pidInfo,
      message: 'Service running',
    };
  } else {
    return {
      running: false,
      pidInfo: pidInfo,
      message: 'Service process does not exist',
    };
  }
}

/**
 * 格式化运行时间
 * 
 * @param {string} startedAt - 启动时间 ISO 字符串
 * @returns {string} 格式化的运行时间字符串
 */
function formatUptime(startedAt) {
  try {
    const start = new Date(startedAt);
    const now = new Date();
    
    // 检查日期是否有效
    if (isNaN(start.getTime())) {
      return 'unknown';
    }
    
    const uptime = Math.floor((now - start) / 1000);
    
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    if (hours > 0) {
      return `${hours} hours ${minutes} minutes ${seconds} seconds`;
    } else if (minutes > 0) {
      return `${minutes} minutes ${seconds} seconds`;
    } else {
      return `${seconds} seconds`;
    }
  } catch (err) {
    return 'unknown';
  }
}

// ESM 导出
export {
  SERVICE_CONFIG,
  getPidFilePath,
  getLockFilePath,
  resolveServerScriptPath,
  resolvePackageVersion,
  readPidFile,
  writePidFile,
  deletePidFile,
  isProcessRunning,
  isTargetServiceProcess,
  acquireStartLock,
  releaseStartLock,
  ensureNoRunningServiceBeforeStart,
  stopProcess,
  waitForProcessStop,
  waitForServiceHealth,
  startService,
  stopService,
  restartService,
  getServiceStatus,
  isWindows,
  formatUptime,
};

