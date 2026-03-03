#!/usr/bin/env node

/**
 * CLI 环境启动脚本（ESM）
 * 由 nuwax-file-server CLI 命令调用
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
console.log("[CLI] 启动服务 - 环境: " + process.env.NODE_ENV);
await import("../src/server.js");
