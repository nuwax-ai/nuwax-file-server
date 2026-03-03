#!/usr/bin/env node
/**
 * 检查 pnpm store 使用情况
 * 验证环境变量是否正确传递给子进程
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

console.log("========================================");
console.log("pnpm Store 使用情况检查");
console.log("========================================\n");

async function checkPnpmConfig() {
  console.log("1. 检查 pnpm 配置:");
  console.log("----------------------------------------");

  try {
    console.log("📦 当前 Node.js 进程的 pnpm 相关环境变量:");
    const pnpmEnvVars = Object.keys(process.env)
      .filter(
        (key) =>
          key.toLowerCase().includes("pnpm") ||
          key === "PATH" ||
          key === "HOME"
      )
      .sort();

    if (pnpmEnvVars.length === 0) {
      console.log("   (没有发现 pnpm 相关环境变量)");
    } else {
      pnpmEnvVars.forEach((key) => {
        const value = process.env[key];
        const displayValue =
          value.length > 100 ? value.substring(0, 100) + "..." : value;
        console.log(`   ${key} = ${displayValue}`);
      });
    }
    console.log("");

    console.log(
      "📦 通过 spawn 方式获取 pnpm 配置 (继承 process.env):"
    );
    await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", "pnpm config list"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      child.stdout.on("data", (data) => {
        output += data.toString();
      });

      child.on("exit", (code) => {
        if (code === 0) {
          console.log(output);
          resolve();
        } else {
          reject(new Error(`Exit code: ${code}`));
        }
      });
    });

    console.log("📦 通过 spawn 方式获取 pnpm 配置 (不传 env):");
    await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", "pnpm config list"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      child.stdout.on("data", (data) => {
        output += data.toString();
      });

      child.on("exit", (code) => {
        if (code === 0) {
          console.log(output);
          resolve();
        } else {
          reject(new Error(`Exit code: ${code}`));
        }
      });
    });
  } catch (error) {
    console.log(`   ❌ 错误: ${error.message}`);
  }
}

async function checkStoreLocation() {
  console.log("\n2. 检查 Store 位置:");
  console.log("----------------------------------------");

  try {
    const { stdout } = await execPromise("pnpm store path", {
      env: process.env,
    });
    const storePath = stdout.trim();
    console.log(`📁 Store 路径: ${storePath}`);

    try {
      const { stdout: sizeOutput } = await execPromise(
        `du -sh "${storePath}" 2>/dev/null || echo "无法计算"`
      );
      const size = sizeOutput.split("\t")[0];
      console.log(`💾 Store 大小: ${size}`);
    } catch (e) {
      console.log("💾 Store 大小: 无法计算");
    }
  } catch (error) {
    console.log(`   ❌ 错误: ${error.message}`);
  }
}

async function testSpawnWithEnv() {
  console.log("\n3. 测试 spawn 环境变量传递:");
  console.log("----------------------------------------");

  console.log("✅ 测试1: spawn 传递 env: process.env");
  await new Promise((resolve) => {
    const child = spawn(
      "sh",
      ["-c", 'echo "Registry: $(pnpm config get registry)"'],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    child.stdout.on("data", (data) => {
      console.log(`   ${data.toString().trim()}`);
    });

    child.on("exit", () => resolve());
  });

  console.log("\n❌ 测试2: spawn 不传递 env");
  await new Promise((resolve) => {
    const child = spawn(
      "sh",
      ["-c", 'echo "Registry: $(pnpm config get registry)"'],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    child.stdout.on("data", (data) => {
      console.log(`   ${data.toString().trim()}`);
    });

    child.on("exit", () => resolve());
  });
}

async function analyzeInstallProgress() {
  console.log("\n4. pnpm install 进度指标说明:");
  console.log("----------------------------------------");

  console.log(`
📊 进度指标含义:
   - resolved: 解析的依赖总数（确定了版本号和依赖关系）
   - reused:   从 store 通过硬链接复用的包数量
   - downloaded: 从中央仓库下载的包数量
   - added:    已添加到 node_modules 的包数量

✅ 理想状态: downloaded = 0，说明完全使用本地 store

❓ 为什么 resolved != reused?
   差异包可能是:
   1. 虚拟包 (peer dependencies 的虚拟引用)
   2. 符号链接 (指向其他包的链接)
   3. 本地包 (workspace 中的包)
   4. 可选依赖 (根据平台条件跳过的包)

💡 关键指标:
   - downloaded = 0  → ✅ 环境变量生效，使用 store
   - downloaded > 0  → ❌ 部分包从网络下载
`);
}

async function main() {
  try {
    await checkPnpmConfig();
    await checkStoreLocation();
    await testSpawnWithEnv();
    await analyzeInstallProgress();

    console.log("\n========================================");
    console.log("检查完成!");
    console.log("========================================\n");
  } catch (error) {
    console.error("执行出错:", error);
    process.exit(1);
  }
}

main();
