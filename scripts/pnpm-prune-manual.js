#!/usr/bin/env node
/**
 * 手动执行 pnpm store prune 的脚本
 *
 * 使用方法:
 *   node scripts/pnpm-prune-manual.js
 */

import { executePruneManually } from "../src/scheduler/pnpmPruneScheduler.js";

async function main() {
  console.log("====================================");
  console.log("手动执行 pnpm store prune");
  console.log("====================================");
  console.log("");

  try {
    await executePruneManually();
    console.log("");
    console.log("✅ 执行完成");
    process.exit(0);
  } catch (error) {
    console.error("");
    console.error("❌ 执行失败:", error.message);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^.*[\/\\]/, ""))) {
  main();
}

export { main };
