import { log } from "../log/logUtils.js";

/**
 * 端口池管理器（内存级别）
 * 适用于 Docker 容器环境：容器重启后所有进程和端口都会释放
 * 使用 Set 管理可用端口池，分配O(1)，释放O(1)
 */
class PortPool {
  constructor() {
    // 端口范围配置
    this.portRangeStart = 4000;
    this.portRangeEnd = 55000;
    // 保留端口
    //this.reservedPorts = new Set([60000]);
    this.reservedRangeStart = 8000;
    this.reservedRangeEnd = 9000;
    
    // 可用端口池（Set 结构，O(1) 取出和放入）
    this.availablePorts = new Set();
    
    // 已分配的端口 Map: projectId -> port
    this.allocatedPorts = new Map();
    
    // 初始化可用端口池
    this._initializePortPool();
  }

  /**
   * 初始化可用端口池
   * @private
   */
  _initializePortPool() {
    for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
      if (port >= this.reservedRangeStart && port <= this.reservedRangeEnd) {
        continue; // 跳过保留范围
      }
      // if (this.reservedPorts.has(port)) {
      //   continue;
      // }
      this.availablePorts.add(port);
    }
    const reservedRangeCount = this.reservedRangeEnd - this.reservedRangeStart + 1;
    log("SYSTEM", "INFO", "端口池初始化完成", { 
      portRange: `${this.portRangeStart}-${this.portRangeEnd}`,
      totalPorts: this.availablePorts.size,
      reservedCount: reservedRangeCount
    });
  }

  /**
   * 为项目分配端口
   * @param {string} projectId 项目ID
   * @returns {number} 分配的端口号
   */
  allocate(projectId) {
    // 如果该项目已经分配过端口，直接返回
    if (this.allocatedPorts.has(projectId)) {
      const existingPort = this.allocatedPorts.get(projectId);
      log(projectId, "INFO", "项目已有分配端口，复用", { port: existingPort });
      return existingPort;
    }

    // 从可用池中取出一个端口
    if (this.availablePorts.size === 0) {
      throw new Error(`端口池耗尽：范围 ${this.portRangeStart}-${this.portRangeEnd} 内无可用端口`);
    }

    // Set 的迭代器第一个值即为要分配的端口（Set 保持插入顺序）
    const port = this.availablePorts.values().next().value;
    
    // 从可用池移除
    this.availablePorts.delete(port);
    
    // 记录分配
    this.allocatedPorts.set(projectId, port);
    
    log(projectId, "INFO", "端口池分配端口", { 
      port, 
      totalAllocated: this.allocatedPorts.size,
      remainingAvailable: this.availablePorts.size
    });
    
    return port;
  }

  /**
   * 释放项目的端口（归还到可用池）
   * @param {string} projectId 项目ID
   */
  release(projectId) {
    const port = this.allocatedPorts.get(projectId);
    if (port) {
      // 从已分配中移除
      this.allocatedPorts.delete(projectId);
      
      // 归还到可用池
      this.availablePorts.add(port);
      
      log(projectId, "INFO", "端口池释放端口", { 
        port, 
        totalAllocated: this.allocatedPorts.size,
        remainingAvailable: this.availablePorts.size
      });
    }
  }

  /**
   * 获取项目当前分配的端口
   * @param {string} projectId 项目ID
   * @returns {number|null} 端口号，未分配则返回null
   */
  getPort(projectId) {
    return this.allocatedPorts.get(projectId) || null;
  }

  /**
   * 获取端口池状态
   * @returns {Object} 端口池状态信息
   */
  getStatus() {
    return {
      portRange: `${this.portRangeStart}-${this.portRangeEnd}`,
      totalAllocated: this.allocatedPorts.size,
      allocations: Array.from(this.allocatedPorts.entries()).map(([projectId, port]) => ({
        projectId,
        port
      }))
    };
  }

  /**
   * 清空端口池（仅用于测试或维护）
   * 将所有已分配端口归还到可用池
   */
  clear() {
    // 将已分配端口归还到可用池
    for (const port of this.allocatedPorts.values()) {
      this.availablePorts.add(port);
    }
    this.allocatedPorts.clear();
    
    log("SYSTEM", "INFO", "端口池已清空并重置", {
      availablePorts: this.availablePorts.size,
      allocatedPorts: this.allocatedPorts.size
    });
  }
}

// 单例模式：全局共享一个端口池实例
const portPool = new PortPool();

export default portPool;

