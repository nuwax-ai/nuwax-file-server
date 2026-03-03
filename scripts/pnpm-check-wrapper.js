#!/usr/bin/env node
/**
 * pnpm-check 脚本的 Node.js 包装器
 * 自动加载项目配置并传递给 bash 脚本
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = (await import("../src/appConfig/index.js")).default;

const projectSourceDir = config.PROJECT_SOURCE_DIR;
const scriptPath = path.join(__dirname, "pnpm-check.sh");

console.log(`🔧 当前环境: ${config.NODE_ENV}`);
console.log(`📂 项目目录: ${projectSourceDir}`);
console.log("");

const child = spawn("bash", [scriptPath, projectSourceDir], {
  stdio: "inherit",
  env: {
    ...process.env,
    PROJECT_SOURCE_DIR: projectSourceDir,
    NODE_ENV: config.NODE_ENV,
  },
});

child.on("error", (error) => {
  console.error("❌ 执行失败:", error.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
