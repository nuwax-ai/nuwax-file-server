#!/usr/bin/env node

/**
 * nuwax-file-server CLI 入口
 *
 * 设计原则：
 * - CLI 只负责参数解析与输出
 * - 服务生命周期逻辑统一收敛到 serviceManager
 */

import { Command } from "commander";
import { createRequire } from "module";
import {
  SERVICE_CONFIG,
  startService,
  stopService,
  restartService,
  getServiceStatus,
  getPidFilePath,
  formatUptime,
} from "./utils/serviceManager.js";

const esmRequire = createRequire(import.meta.url);
const version = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : esmRequire("../package.json").version;

const program = new Command();

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
 * 统一执行命令动作并设置退出码
 * @param {Function} action 命令动作
 * @returns {Function} commander action
 */
function runCommandAction(action) {
  return async (...args) => {
    try {
      const result = await action(...args);
      if (result && result.success === false) {
        error(result.message || 'Command failed');
        process.exitCode = 1;
      } else {
        process.exitCode = 0;
      }
    } catch (err) {
      error(err?.message || 'Command failed with unexpected error');
      process.exitCode = 1;
    }
  };
}

/**
 * start 命令
 *
 * @param {Object} options - commander 参数
 * @returns {Promise<Object>} 执行结果
 */
async function runStartCommand(options) {
  const result = await startService({
    env: options.env,
    port: options.port,
    config: options.config,
    timeout: Number(options.timeout),
    startTimeout: Number(options.startTimeout),
  });

  if (result.success) {
    success(`Service started (PID: ${result.pid})`);
  }
  return result;
}

/**
 * stop 命令
 *
 * @param {Object} options - commander 参数
 * @returns {Promise<Object>} 执行结果
 */
async function runStopCommand(options) {
  const result = await stopService({
    force: options.force,
    timeout: Number(options.timeout),
  });
  if (result.success) {
    success(result.message || 'Service stopped');
  }
  return result;
}

/**
 * restart 命令
 *
 * @param {Object} options - commander 参数
 * @returns {Promise<Object>} 执行结果
 */
async function runRestartCommand(options) {
  const result = await restartService({
    env: options.env,
    port: options.port,
    config: options.config,
    timeout: Number(options.timeout),
    startTimeout: Number(options.startTimeout),
  });
  if (result.success) {
    success(result.message || 'Service restarted');
  }
  return result;
}

/**
 * status 命令
 *
 * @returns {Object} 执行结果
 */
function runStatusCommand() {
  const status = getServiceStatus();

  info(`${SERVICE_CONFIG.name} service status:`);
  console.log('');
  console.log(`  Service name: ${SERVICE_CONFIG.name}`);
  console.log(`  Running status: ${status.running ? 'Running' : 'Stopped'}`);
  console.log(`  Message: ${status.message}`);
  console.log(`  PID file: ${getPidFilePath()}`);

  if (status.pidInfo) {
    console.log(`  Process ID: ${status.pidInfo.pid}`);
    console.log(`  Environment: ${status.pidInfo.env || 'Unknown'}`);
    console.log(`  Port: ${status.pidInfo.port || 'Unknown'}`);
    console.log(`  Version: ${status.pidInfo.version || version}`);
    console.log(`  Platform: ${status.pidInfo.platform || process.platform}`);
    console.log(`  Started at: ${status.pidInfo.startedAt || 'Unknown'}`);
    console.log(`  Uptime: ${formatUptime(status.pidInfo.startedAt)}`);
  }
  console.log('');

  return {
    success: status.running,
    message: status.message,
  };
}

// 主程序
function main() {
  program
    .name('nuwax-file-server')
    .description('Cross-platform file service deployment tool, supporting start/stop/restart/status')
    .version(version, '-v, --version', 'Display version number')
    .helpOption('-h, --help', 'Display help information');

  program
    .command('start').allowUnknownOption()
    .description('Start service')
    .option('--env <environment>', '环境: development|production|test', 'production')
    .option('--port <port>', 'Service port')
    .option('--config <path>', 'Custom configuration file path')
    .option('--timeout <ms>', '停止旧进程等待超时（毫秒）', `${SERVICE_CONFIG.defaultStopTimeout}`)
    .option('--start-timeout <ms>', '启动健康检查超时（毫秒）', `${SERVICE_CONFIG.defaultStartTimeout}`)
    .action(runCommandAction(runStartCommand));

  program
    .command('stop')
    .description('Stop service')
    .option('--force', 'Force stop')
    .option('--timeout <ms>', '停止服务等待超时（毫秒）', `${SERVICE_CONFIG.defaultStopTimeout}`)
    .action(runCommandAction(runStopCommand));

  program
    .command('restart').allowUnknownOption()
    .description('Restart service')
    .option('--env <environment>', '环境: development|production|test', 'production')
    .option('--port <port>', 'Service port')
    .option('--config <path>', 'Custom configuration file path')
    .option('--timeout <ms>', '停止旧进程等待超时（毫秒）', `${SERVICE_CONFIG.defaultStopTimeout}`)
    .option('--start-timeout <ms>', '启动健康检查超时（毫秒）', `${SERVICE_CONFIG.defaultStartTimeout}`)
    .action(runCommandAction(runRestartCommand));

  program
    .command('status')
    .description('View service status')
    .action(runCommandAction(runStatusCommand));

  program
    .command('help')
    .description('Display help information')
    .action(() => {
      program.outputHelp();
    });

  program.parse(process.argv);

  if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exitCode = 0;
  }
}

main();
