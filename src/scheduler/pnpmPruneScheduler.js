/**
 * pnpm store prune 定时任务调度器（ESM）
 */
import cron from "node-cron";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { log } from "../utils/log/logUtils.js";

class PnpmPruneScheduler {
  constructor(config = {}) {
    // 默认配置：每周日凌晨 2 点执行
    this.config = {
      enabled: process.env.PNPM_PRUNE_ENABLED !== 'false', // 默认启用（只有明确设置为 'false' 才禁用）
      schedule: process.env.PNPM_PRUNE_SCHEDULE || '0 2 * * 0', // Cron 表达式
      timezone: process.env.PNPM_PRUNE_TIMEZONE || 'Asia/Shanghai',
      runOnStart: process.env.PNPM_PRUNE_RUN_ON_START === 'true', // 启动时是否立即执行一次（明确设置为 'true' 才启用）
      ...config,
    };
    
    this.task = null;
    this.isRunning = false;
  }

  /**
   * 启动定时任务
   */
  start() {
    if (!this.config.enabled) {
      log('scheduler', 'INFO', 'pnpm prune 定时任务已禁用（PNPM_PRUNE_ENABLED=false）');
      return;
    }

    // 验证 cron 表达式
    if (!cron.validate(this.config.schedule)) {
      log('scheduler', 'ERROR', `无效的 cron 表达式: ${this.config.schedule}`);
      return;
    }

    log('scheduler', 'INFO', 'pnpm prune 定时任务已启动', {
      schedule: this.config.schedule,
      timezone: this.config.timezone,
    });

    // 创建定时任务
    this.task = cron.schedule(
      this.config.schedule,
      () => {
        this.executePrune();
      },
      {
        scheduled: true,
        timezone: this.config.timezone,
      }
    );

    // 如果配置了启动时执行，则立即执行一次
    if (this.config.runOnStart) {
      log('scheduler', 'INFO', '启动时立即执行一次 pnpm prune');
      setTimeout(() => {
        this.executePrune();
      }, 5000); // 延迟 5 秒，让应用完全启动
    }
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.task) {
      this.task.stop();
      log('scheduler', 'INFO', 'pnpm prune 定时任务已停止');
    }
  }

  /**
   * 执行 pnpm store prune
   */
  async executePrune() {
    if (this.isRunning) {
      log('scheduler', 'WARN', 'pnpm prune 正在执行中，跳过本次调度');
      return;
    }

    this.isRunning = true;
    
    log('scheduler', 'INFO', '====================================');
    log('scheduler', 'INFO', '开始执行 pnpm store prune');
    log('scheduler', 'INFO', '====================================');

    try {
      // 获取清理前的状态
      const beforeStatus = await this.getStoreStatus();
      if (beforeStatus) {
        log('scheduler', 'INFO', '清理前状态', beforeStatus);
      }

      // 执行清理
      const result = await this.runCommand('pnpm store prune');
      
      if (result.success) {
        log('scheduler', 'INFO', '✅ pnpm store prune 执行成功');
        if (result.stdout) {
          log('scheduler', 'INFO', result.stdout);
        }

        // 获取清理后的状态
        const afterStatus = await this.getStoreStatus();
        if (afterStatus) {
          log('scheduler', 'INFO', '清理后状态', afterStatus);
        }
      } else {
        log('scheduler', 'ERROR', '❌ pnpm store prune 执行失败', {
          error: result.error,
        });
      }
    } catch (error) {
      log('scheduler', 'ERROR', 'pnpm prune 执行异常', {
        error: error.message,
      });
    } finally {
      this.isRunning = false;
      log('scheduler', 'INFO', '====================================');
      log('scheduler', 'INFO', 'pnpm store prune 执行完成');
      log('scheduler', 'INFO', '====================================\n');
    }
  }

  /**
   * 获取 store 状态
   */
  async getStoreStatus() {
    try {
      const pathResult = await this.runCommand('pnpm store path');
      if (!pathResult.success) {
        return null;
      }

      const storePath = pathResult.stdout.trim();
      
      // 获取 store 大小
      const sizeResult = await this.runCommand(`du -sh "${storePath}"`);
      const storeSize = sizeResult.success 
        ? sizeResult.stdout.trim().split('\t')[0]
        : 'unknown';

      return {
        path: storePath,
        size: storeSize,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 执行命令
   */
  runCommand(command) {
    return new Promise((resolve) => {
      exec(
        command,
        {
          maxBuffer: 10 * 1024 * 1024,
          env: process.env, // 继承父进程的环境变量，包括 pnpm 配置
        },
        (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message,
            stderr: stderr,
          });
        } else {
          resolve({
            success: true,
            stdout: stdout,
          });
        }
      });
    });
  }

  /**
   * 获取下次执行时间
   */
  getNextRun() {
    // node-cron 没有直接提供下次执行时间的方法
    // 这里只是返回配置
    return {
      schedule: this.config.schedule,
      timezone: this.config.timezone,
    };
  }
}

// 单例实例
let schedulerInstance = null;

/**
 * 获取调度器实例
 */
function getScheduler(config) {
  if (!schedulerInstance) {
    schedulerInstance = new PnpmPruneScheduler(config);
  }
  return schedulerInstance;
}

/**
 * 启动调度器
 */
function startScheduler(config) {
  const scheduler = getScheduler(config);
  scheduler.start();
  return scheduler;
}

/**
 * 停止调度器
 */
function stopScheduler() {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
}

/**
 * 手动执行一次 pnpm store prune
 * @param {Object} config - 可选配置
 * @returns {Promise<void>}
 */
async function executePruneManually(config = {}) {
  const scheduler = getScheduler(config);
  await scheduler.executePrune();
}

export {
  PnpmPruneScheduler,
  getScheduler,
  startScheduler,
  stopScheduler,
  executePruneManually,
};

