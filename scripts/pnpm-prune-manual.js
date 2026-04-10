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
  console.log("Manually execute pnpm store prune");
  console.log("====================================");
  console.log("");

  try {
    await executePruneManually();
    console.log("");
    console.log("✅ Execution completed");
    process.exit(0);
  } catch (error) {
    console.error("");
    console.error("❌ Execution failed:", error.message);
    process.exit(1);
  }
}

// If running this script directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^.*[\/\\]/, ""))) {
  main();
}

export { main };
