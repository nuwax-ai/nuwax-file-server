#!/usr/bin/env node

/**
 * nuwax-file-server CLI 入口文件
 * 
 * 支持的命令:
 * - start: 启动服务
 * - stop: 停止服务
 * - restart: 重启服务
 * - status: 查看服务状态
 * 
 * 支持的选项:
 * --env: 指定环境 (development/production/test)
 * --port: 指定端口
 * --config: 指定配置文件路径
 * 
 * 跨平台支持: Windows, Linux, macOS
 */

import { Command } from "commander";
import path from "path";
import os from "os";
import fs from "fs-extra";
import { spawn } from "cross-spawn";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 使用 esmRequire 避免与保留关键字 require 冲突
const esmRequire = createRequire(import.meta.url);
// 发 npm 构建时由 scripts/build.js 注入 __BUILD_VERSION__；本地开发则从 package.json 读取
const version = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : esmRequire("../package.json").version;

// 创建命令行程序
const program = new Command();

// 服务配置
const SERVICE_CONFIG = {
  name: 'nuwax-file-server',
  pidDir: path.join(os.tmpdir(), 'nuwax-file-server'),
  logDir: path.join(os.tmpdir(), 'nuwax-file-server', 'logs'),
  pidFile: path.join(os.tmpdir(), 'nuwax-file-server', 'server.pid'),
};

// 打印彩色消息
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message) {
  console.error(`${colors.red}ERROR: ${message}${colors.reset}`);
}

function success(message) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

function info(message) {
  console.log(`${colors.blue}${message}${colors.reset}`);
}

/**
 * 获取 PID 文件路径
 * 跨平台兼容: Windows 使用 %TEMP%，Linux/macOS 使用 /tmp
 * @returns {string} PID 文件路径
 */
function getPidFilePath() {
  return SERVICE_CONFIG.pidFile;
}

/**
 * 读取 PID 文件
 * @returns {Object|null} PID 信息对象
 */
function readPidFile() {
  try {
    const pidPath = getPidFilePath();
    if (fs.existsSync(pidPath)) {
      const content = fs.readFileSync(pidPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    // 忽略读取错误
  }
  return null;
}

/**
 * 写入 PID 文件
 * @param {Object} pidInfo PID 信息对象
 */
function writePidFile(pidInfo) {
  const pidDir = path.dirname(getPidFilePath());
  fs.ensureDirSync(pidDir);
  fs.writeFileSync(getPidFilePath(), JSON.stringify(pidInfo, null, 2));
}

/**
 * 删除 PID 文件
 */
function deletePidFile() {
  const pidPath = getPidFilePath();
  if (fs.existsSync(pidPath)) {
    fs.removeSync(pidPath);
  }
}

/**
 * 检查进程是否正在运行
 * @param {number} pid 进程 ID
 * @returns {boolean} 是否正在运行
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH' || err.code === 'EPERM') {
      return false;
    }
    return false;
  }
}

/**
 * 停止进程（跨平台）
 * @param {number} pid 进程 ID
 * @param {boolean} force 是否强制停止
 * @returns {Promise<boolean>} 是否成功停止
 */
async function stopProcess(pid, force = false) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    
    if (isWindows) {
      // Windows 使用 taskkill 命令
      const killArgs = force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)];
      const child = spawn('taskkill', killArgs, { stdio: 'pipe' });
      
      child.on('error', (err) => {
        error(`Stop process failed: ${err.message}`);
        resolve(false);
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          success(`Process ${pid} stopped`);
          resolve(true);
        } else if (force) {
          // 强制模式下，尝试使用 /F 标志
          const forceChild = spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'pipe' });
          forceChild.on('close', (forceCode) => {
            resolve(forceCode === 0);
          });
        } else {
          resolve(false);
        }
      });
    } else {
      // Linux/macOS 使用 kill 信号
      try {
        // 优先尝试杀死进程组
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
        success(`Process group ${pid} stopped`);
        resolve(true);
      } catch (err) {
        if (err.code === 'ESRCH') {
          // 进程不存在
          success(`Process ${pid} does not exist, already stopped`);
          resolve(true);
        } else {
          // 回退到单个进程
          try {
            process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
            success(`Process ${pid} stopped`);
            resolve(true);
          } catch (killErr) {
            if (killErr.code === 'ESRCH') {
              success(`Process ${pid} does not exist, already stopped`);
              resolve(true);
            } else {
              error(`Stop process failed: ${killErr.message}`);
              resolve(false);
            }
          }
        }
      }
    }
  });
}

/**
 * 启动服务
 * 
 * 参考 scripts/start-prod.js, scripts/start-dev.js 的做法
 * 先设置环境变量，再加载 server.js
 * 
 * @param {Object} options 命令行选项
 */
async function startService(options) {
  const { env, port, config } = options;

  // 解析命令行中的 --KEY=VALUE 参数，写入 process.env
  // 供 spawn server.js 时通过 {...process.env} 继承
  const cliOptions = new Set(["env", "port", "config", "force", "help", "version"]);
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(2, eqIdx);
      if (!cliOptions.has(key)) {
        const value = arg.slice(eqIdx + 1);
        process.env[key] = value;
        info(`CLI parameter overrides environment variable: ${key}=${value}`);
      }
    }
  });
  
  info(`Start ${SERVICE_CONFIG.name} service...`);
  
  // 检查服务是否已在运行
  const existingPidInfo = readPidFile();
  if (existingPidInfo && isProcessRunning(existingPidInfo.pid)) {
    error(`Service is already running (PID: ${existingPidInfo.pid})`);
    info(`Please use 'nuwax-file-server stop' to stop the existing service before trying again`);
    process.exit(1);
  }
  
  // 设置环境变量
  // 参考 scripts/start-*.js 的做法：先设置 NODE_ENV
  const envType = env || 'production';
  process.env.NODE_ENV = envType;
  info(`Use environment: ${envType}`);
  
  if (port) {
    process.env.PORT = port;
    info(`Use port: ${port}`);
  }
  
  if (config) {
    process.env.CONFIG_FILE = config;
    info(`Use configuration file: ${config}`);
  }
  
  // 确保日志目录存在
  fs.ensureDirSync(SERVICE_CONFIG.logDir);
  
  // 直接运行与 cli 同目录的 server.js（发布包仅含 dist/，无 scripts/，故不依赖 scripts/start-cli.js）
  const serverPath = path.join(__dirname, 'server.js');
  
  // 使用 cross-spawn 确保跨平台兼容性
  // stdio: 'inherit' 让子进程复用当前终端，父进程不持有管道引用，unref() 后 CLI 可立即退出，避免 test-cli.sh 等脚本卡住
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: envType,
    },
    stdio: 'inherit',
    detached: true,
    cwd: process.cwd(),
    windowsHide: true,
  });

  child.on('error', (err) => {
    error(`Start service failed: ${err.message}`);
    process.exit(1);
  });

  // 等待服务启动
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (!isProcessRunning(child.pid)) {
    error('Start service failed');
    process.exit(1);
  }

  const pidInfo = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    env: env || 'production',
    port: port || process.env.PORT || '60000',
    version: version,
    platform: process.platform,
  };

  writePidFile(pidInfo);
  child.unref();

  success(`Service started (PID: ${child.pid})`);
  log(`Service running on: http://localhost:${pidInfo.port}`, 'cyan');
  log(`Environment: ${pidInfo.env}`, 'cyan');
  log(`Platform: ${pidInfo.platform}`, 'cyan');
  log(`PID file: ${getPidFilePath()}`, 'cyan');
}

/**
 * 停止服务
 * @param {Object} options 命令行选项
 */
async function stopService(options) {
  const { force } = options;
  
  info(`Stop ${SERVICE_CONFIG.name} service...`);
  
  // 读取 PID 文件
  const pidInfo = readPidFile();
  
  if (!pidInfo) {
    error('Service not found');
    info('Service may not be running or PID file has been lost');
    process.exit(0);
  }
  
  // 检查进程是否正在运行
  if (!isProcessRunning(pidInfo.pid)) {
    info('Service process has stopped, clean PID file...');
    deletePidFile();
    success('Service has stopped');
    process.exit(0);
  }
  
  // 停止进程
  const stopped = await stopProcess(pidInfo.pid, force);
  
  if (stopped) {
    // 等待进程完全退出
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    // 再次检查
    if (!isProcessRunning(pidInfo.pid)) {
      deletePidFile();
      success('Service has stopped');
      process.exit(0);
    }
  }
  
  if (force) {
    error('Force stop failed, please stop the process manually');
    process.exit(1);
  }
  
  // 尝试强制停止
  info('Try to force stop...');
  const forceStopped = await stopProcess(pidInfo.pid, true);
  
  if (forceStopped) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    if (!isProcessRunning(pidInfo.pid)) {
      deletePidFile();
      success('Service has been forced stopped');
      process.exit(0);
    }
  }
  
  error('Stop service failed');
  process.exit(1);
}

/**
 * 重启服务
 * @param {Object} options 命令行选项
 */
async function restartService(options) {
  log(`Restart ${SERVICE_CONFIG.name} service...`, 'yellow');
  
  // 先停止服务
  info('Stop existing service...');
  try {
    await stopService({ force: false });
  } catch (err) {
    // 忽略停止错误（服务可能未运行）
    info('Service not running or has stopped');
  }
  
  // 等待一段时间
  await new Promise((resolve) => setTimeout(resolve, 2000));
  
  // 启动服务
  info('Start service...');
  await startService(options);
  
  success('Service has been restarted');
}

/**
 * 查看服务状态
 */
function statusService() {
  info(`${SERVICE_CONFIG.name} service status:`);
  
  const pidInfo = readPidFile();
  
  if (!pidInfo) {
    log('Service not running', 'yellow');
    process.exit(0);
  }
  
  const running = isProcessRunning(pidInfo.pid);
  
  console.log('');
  console.log(`  Service name: ${SERVICE_CONFIG.name}`);
  console.log(`  Running status: ${running ? 'Running' : 'Stopped'}`);
  console.log(`  Process ID: ${pidInfo.pid}`);
  console.log(`  Environment: ${pidInfo.env || 'production'}`);
  console.log(`  Port: ${pidInfo.port || '60000'}`);
  console.log(`  Version: ${pidInfo.version || version}`);
  console.log(`  Platform: ${pidInfo.platform || process.platform}`);
  console.log(`  Started at: ${pidInfo.startedAt || 'Unknown'}`);
  
  if (pidInfo.startedAt) {
    const startedAt = new Date(pidInfo.startedAt);
    const now = new Date();
    const uptime = Math.floor((now - startedAt) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    console.log(`  Uptime: ${hours} hours ${minutes} minutes ${seconds} seconds`);
  }
  
  console.log(`  PID file: ${getPidFilePath()}`);
  console.log('');
  
  if (!running) {
    log('Warning: Service process does not exist, but PID file still exists', 'yellow');
    info('Suggest executing stop command to clean up');
  } else {
    log('Service running normally', 'green');
  }
}

// 主程序
function main() {
  // 包名与描述
  program
    .name('nuwax-file-server')
    .description('Cross-platform file service deployment tool, supporting start/stop/restart/status')
    .version(version, '-v, --version', 'Display version number')
    .helpOption('-h, --help', 'Display help information');

  // start 命令
  program
    .command('start').allowUnknownOption()
    .description('Start service')
    .option('--env <environment>', '环境: development|production|test', 'production')
    .option('--port <port>', 'Service port')
    .option('--config <path>', 'Custom configuration file path')
    .action(startService);

  // stop 命令
  program
    .command('stop')
    .description('Stop service')
    .option('--force', 'Force stop')
    .action(stopService);

  // restart 命令
  program
    .command('restart').allowUnknownOption()
    .description('Restart service')
    .option('--env <environment>', '环境: development|production|test', 'production')
    .option('--port <port>', 'Service port')
    .option('--config <path>', 'Custom configuration file path')
    .action(restartService);

  // status 命令
  program
    .command('status')
    .description('View service status')
    .action(statusService);

  // help 命令（与 --help 一致，便于显式调用）
  program
    .command('help')
    .description('Display help information')
    .action(() => {
      program.outputHelp();
    });

  // 解析参数（Commander 会处理 -V/--version、-h/--help 并退出）
  program.parse(process.argv);

  // 未提供任何命令时，显示帮助并正常退出
  if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exit(0);
  }
}

// ESM 下直接执行主程序（作为入口时）
main();
