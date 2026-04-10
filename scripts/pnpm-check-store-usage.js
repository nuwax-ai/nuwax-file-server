#!/usr/bin/env node
/**
 * 检查 pnpm store 使用情况
 * 验证环境变量是否正确传递给子进程
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

console.log("========================================");
console.log("pnpm Store usage check");
console.log("========================================\n");

async function checkPnpmConfig() {
  console.log("1. Check pnpm configuration:");
  console.log("----------------------------------------");

  try {
    console.log("📦 Current Node.js process pnpm related environment variables:");
    const pnpmEnvVars = Object.keys(process.env)
      .filter(
        (key) =>
          key.toLowerCase().includes("pnpm") ||
          key === "PATH" ||
          key === "HOME"
      )
      .sort();

    if (pnpmEnvVars.length === 0) {
      console.log("   (No pnpm related environment variables found)");
    } else {
      pnpmEnvVars.forEach((key) => {
        const value = process.env[key];
        const displayValue =
          value.length > 100 ? value.substring(0, 100) + "..." : value;
        console.log(` ${key} = ${displayValue}`);
      });
    }
    console.log("");

    console.log(
      "📦 Get pnpm configuration through spawn (inherit process.env):"
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

    console.log("📦 Get pnpm configuration through spawn (no env):");
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
    console.log(`❌ Error: ${error.message}`);
  }
}

async function testSpawnWithEnv() {
  console.log("\n3. Test spawn environment variable passing:");
  console.log("----------------------------------------");

  console.log("✅ Test 1: spawn pass env: process.env");
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

  console.log("\n❌ Test 2: spawn no env");
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
  console.log("\n4. pnpm install progress indicator description:");
  console.log("----------------------------------------");

  console.log(`
📊 Progress indicator meaning:
   - resolved: Total number of resolved dependencies (determined version number and dependency relationship)
   - reused:   Number of packages reused through hard links from the store
   - downloaded: Number of packages downloaded from the central repository
   - added:    Number of packages added to node_modules

✅ Ideal state: downloaded = 0, means completely using local store

❓ Why resolved != reused?
   Different packages may be:
   1. Virtual packages (virtual references of peer dependencies)
   2. Symbolic links (links to other packages)
   3. Local packages (packages in workspace)
   4. Optional dependencies (packages skipped based on platform conditions)

💡 Key indicators:
   - downloaded = 0  → ✅ Environment variables take effect, using store
   - downloaded > 0  → ❌ Some packages downloaded from the network
`);
}

async function main() {
  try {
    await checkPnpmConfig();
    await checkStoreLocation();
    await testSpawnWithEnv();
    await analyzeInstallProgress();

    console.log("\n========================================");
    console.log("Check completed!");
    console.log("========================================\n");
  } catch (error) {
    console.error("Execution error:", error);
    process.exit(1);
  }
}

main();
