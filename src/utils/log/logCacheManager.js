// 日志缓存管理器（ESM）
import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";

/**
 * 日志缓存管理器
 * 功能：
 * 1. 缓存整个日志文件内容
 * 2. 每个子项目只缓存一个文件（dev日志）
 * 3. 支持缓存过期时间
 * 4. 提供缓存的增删改查接口
 */
class LogCacheManager {
  constructor() {
    // 缓存存储结构：{ projectId: { lines: Array, totalLines: number, timestamp: number, filePath: string } }
    // 只保存 lines 数组，不保存 content 字符串，节省内存
    this.cache = new Map();
    
    // 从 config 对象读取配置
    this.enabled = config.LOG_CACHE_ENABLED;
    this.cacheDuration = config.LOG_CACHE_DURATION;
    this.maxCacheEntries = config.LOG_CACHE_MAX_ENTRIES;
    this.maxFileSize = config.LOG_CACHE_MAX_FILE_SIZE;
    
    // 定期清理过期缓存（每分钟检查一次）
    if (this.enabled) {
      this.cleanupInterval = setInterval(() => {
        this._cleanupExpiredCache();
      }, 60000);
    }
  }

  /**
   * 判断缓存是否启用
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * 获取缓存
   * @param {string} projectId 项目ID
   * @param {string} filePath 文件路径
   * @returns {Object|null} 缓存数据或null
   */
  get(projectId, filePath) {
    if (!this.enabled) {
      return null;
    }

    const cacheKey = String(projectId);
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      return null;
    }

    // 检查文件路径是否匹配
    // 如果不匹配（比如跨天了，从 dev-2025-11-20.log 变成 dev-2025-11-21.log）
    // 删除旧缓存，释放内存
    if (cached.filePath !== filePath) {
      this.cache.delete(cacheKey);
      return null;
    }

    // 缓存命中时续期（更新时间戳）
    // 即使过期了，只要被访问就续期，不删除
    // 只有定期清理任务才会删除长期未访问的缓存
    const now = Date.now();
    cached.timestamp = now;

    return {
      lines: cached.lines,
      totalLines: cached.totalLines,
      timestamp: cached.timestamp,
    };
  }

  /**
   * 设置缓存
   * @param {string} projectId 项目ID
   * @param {string} filePath 文件路径
   * @param {string} content 文件内容
   * @returns {boolean} 是否成功缓存
   */
  set(projectId, filePath, content) {
    if (!this.enabled) {
      return false;
    }

    // 检查文件大小限制（字节）
    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > this.maxFileSize) {
      console.log(`日志文件过大，不缓存: ${projectId}, 大小: ${(contentSize / 1024 / 1024).toFixed(2)}MB, 限制: ${(this.maxFileSize / 1024 / 1024).toFixed(2)}MB`);
      return false;
    }

    const cacheKey = String(projectId);

    // 检查缓存数量限制
    if (!this.cache.has(cacheKey) && this.cache.size >= this.maxCacheEntries) {
      // 删除最旧的缓存
      const oldestKey = this._findOldestCacheKey();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    // 分割行并缓存（只保存 lines，不保存 content，节省内存）
    const lines = content.split("\n");
    
    this.cache.set(cacheKey, {
      lines,
      totalLines: lines.length,
      timestamp: Date.now(),
      filePath,
    });
    
    return true;
  }


  /**
   * 删除缓存
   * @param {string} projectId 项目ID
   */
  delete(projectId) {
    const cacheKey = String(projectId);
    this.cache.delete(cacheKey);
  }

  /**
   * 清理所有缓存
   */
  clear() {
    this.cache.clear();
  }

  /**
   * 清理过期缓存
   */
  _cleanupExpiredCache() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheDuration) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach((key) => {
      this.cache.delete(key);
    });

    if (expiredKeys.length > 0) {
      console.log(`清理了 ${expiredKeys.length} 个过期的日志缓存`);
    }
  }

  /**
   * 找到最旧的缓存key
   */
  _findOldestCacheKey() {
    let oldestKey = null;
    let oldestTimestamp = Infinity;

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTimestamp) {
        oldestTimestamp = value.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    // 计算总缓存大小和最大文件大小
    let totalCacheSize = 0;
    let maxFileSizeInCache = 0;

    for (const [key, value] of this.cache.entries()) {
      if (value.lines && Array.isArray(value.lines)) {
        let currentFileSize = 0;
        // 计算每个缓存项的大小（所有行的字节数总和）
        for (const line of value.lines) {
          const lineSize = Buffer.byteLength(line, 'utf8');
          currentFileSize += lineSize;
          totalCacheSize += lineSize;
        }
        // 更新最大文件大小
        if (currentFileSize > maxFileSizeInCache) {
          maxFileSizeInCache = currentFileSize;
        }
      }
    }

    return {
      enabled: this.enabled,
      cacheSize: this.cache.size,
      maxCacheEntries: this.maxCacheEntries,
      cacheDuration: this.cacheDuration,
      maxFileSizeMB: (maxFileSizeInCache / 1024 / 1024).toFixed(2),
      totalCacheSizeMB: (totalCacheSize / 1024 / 1024).toFixed(2),
      NODE_ENV: config.NODE_ENV,
      LOG_CACHE_ENABLED: config.LOG_CACHE_ENABLED,
    };
  }

  /**
   * 销毁管理器（清理定时器和缓存）
   * 用于服务优雅关闭时
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// 使用延迟初始化的单例模式
// 在第一次访问时才创建实例，此时环境变量已经完全加载
let instance = null;

function getLogCacheManager() {
  if (!instance) {
    instance = new LogCacheManager();
    if (instance.enabled) {
      console.log("日志缓存已启用");
    }
  }
  return instance;
}

// 创建代理对象，自动转发所有方法调用到实际实例
const logCacheManager = new Proxy({}, {
  get(target, prop) {
    const manager = getLogCacheManager();
    const value = manager[prop];
    // 如果是方法，绑定 this 到实际实例
    if (typeof value === 'function') {
      return value.bind(manager);
    }
    return value;
  }
});

export default logCacheManager;

