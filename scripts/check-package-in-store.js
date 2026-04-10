#!/usr/bin/env node
/**
 * 检查指定包是否在 pnpm store 中，以及下载原因诊断工具
 * 
 * 使用方法:
 *   node scripts/check-package-in-store.js @radix-ui/react-toggle
 *   node scripts/check-package-in-store.js @radix-ui/react-toggle 1.0.3
 */

import { execSync, spawn } from "child_process";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageName = process.argv[2];
const packageVersion = process.argv[3];

if (!packageName) {
  console.error("❌ Please provide package name");
  console.log("\nUsage:");
  console.log("  node scripts/check-package-in-store.js <package-name> [version]");
  console.log("\nExamples:");
  console.log("  node scripts/check-package-in-store.js @radix-ui/react-toggle");
  console.log("  node scripts/check-package-in-store.js @radix-ui/react-toggle 1.0.3");
  process.exit(1);
}

console.log("======================================");
console.log("pnpm Store package diagnosis tool");
console.log("======================================");
console.log("");

// 1. 获取 store 路径
console.log("1️⃣  Check pnpm Store path:");
console.log("----------------------------------------");
let storePath;
try {
  storePath = execSync("pnpm store path", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`✅ Store path: ${storePath}`);
  
  // 检查 store 结构
  const filesDir = path.join(storePath, "files");
  const indexDir = path.join(storePath, "index");
  if (filesDir && indexDir) {
    console.log(`   Store structure: pnpm v10 (hash sharding storage)`);
    console.log(`   - files/ directory: store hash files`);
    console.log(`   - index/ directory: store index information`);
  }
} catch (error) {
  console.error(`❌ Failed to get store path: ${error.message}`);
  process.exit(1);
}
console.log("");

// 2. 检查 store 中是否有该包
console.log("2️⃣  Check if the package exists in the Store:");
console.log("----------------------------------------");
let foundDirs = "";
let packageFound = false;

try {
  // pnpm v10 store structure: store/v10/files/ and store/v10/index/
  // files/ directory is the hash sharding directory (00-ff), each sharding directory is the hash named file
  // index/ directory stores index information
  const encodedPackageName = packageName
    .replace(/@/g, "%40")
    .replace(/\//g, "%2f");
  
  const filesDir = path.join(storePath, "files");
  const indexDir = path.join(storePath, "index");
  
  console.log(`    Search package: ${packageName}`);
  console.log(`    Encoded package name: ${encodedPackageName}`);
  console.log(`   Store files directory: ${filesDir}`);
  console.log(`   Store index directory: ${indexDir}`);
  console.log("   (Note: pnpm v10 uses hash file storage, packages are named by hash values)");
  console.log("");
  
  // 方法1: 使用 pnpm store status 检查（最可靠的方法）
  console.log("    Method 1: Use pnpm store status check...");
  try {
    const statusOutput = execSync("pnpm store status", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    
    // 检查输出中是否包含该包的信息
    if (statusOutput.includes(packageName) || statusOutput.includes(encodedPackageName)) {
      console.log("   ✅ pnpm store status shows the package related information:");
      const relevantLines = statusOutput
        .split("\n")
        .filter(line => line.includes(packageName) || line.includes(encodedPackageName))
        .slice(0, 5);
      relevantLines.forEach(line => console.log(`      ${line}`));
      packageFound = true;
    } else {
      console.log("   ⚠️  pnpm store status did not find the direct information of the package");
    }
  } catch (e) {
    console.log(`   ⚠️  Failed to execute pnpm store status: ${e.message}`);
  }
  console.log("");
  
  // 方法2: 在 index 目录中查找（索引可能包含包名信息）
  console.log("    Method 2: Find in the index directory...");
  try {
    const findCommand = `find "${indexDir}" -type f -exec grep -l "${encodedPackageName}" {} \\; 2>/dev/null | head -10`;
    const indexFiles = execSync(findCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    
    if (indexFiles) {
      console.log("   ✅ Found related files in the index:");
      indexFiles.split("\n").slice(0, 5).forEach(file => {
        console.log(`      ${file}`);
      });
      packageFound = true;
    } else {
      console.log("   ⚠️  index directory did not find related files");
    }
  } catch (e) {
    console.log(`   ⚠️  Failed to search index directory: ${e.message}`);
  }
  console.log("");
  
  // 方法3: 尝试在整个 store 中查找包含包名的任何内容
  console.log("    Method 3: Search for any content containing the package name in the store...");
  try {
    const findCommand = `grep -r "${encodedPackageName}" "${indexDir}" 2>/dev/null | head -5`;
    const grepResults = execSync(findCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    
    if (grepResults) {
      console.log("   ✅ Found content containing the package name:");
      grepResults.split("\n").forEach(line => {
        const parts = line.split(":");
        if (parts.length > 1) {
          console.log(`      File: ${parts[0]}`);
          console.log(`      Content: ${parts.slice(1).join(":").substring(0, 100)}...`);
        }
      });
      packageFound = true;
    }
  } catch (e) {
    // grep 没找到结果时会返回非零退出码，这是正常的
    if (e.status !== 1) {
      console.log(`   ⚠️  Failed to search: ${e.message}`);
    }
  }

  // 总结查找结果
  console.log("   📊 Summary of search results:");
  if (packageFound) {
    console.log("   ✅ Found the related information of the package in the store");
  } else {
    console.log(`   ❌ Did not find the package in the store: ${packageName}`);
    console.log("   💡 This may be the reason for the download: the package is not in the store");
  }
} catch (error) {
  console.log(`⚠️  Failed during check: ${error.message}`);
}
console.log("");

// 3. 检查 store 状态
console.log("3️⃣  Check Store status:");
console.log("----------------------------------------");
try {
  const statusOutput = execSync("pnpm store status", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  console.log(statusOutput);
} catch (error) {
  console.log(`⚠️  Failed to get store status: ${error.message}`);
  if (error.message.includes("ENOENT")) {
    console.log("   💡 Store index may be damaged,建议运行: pnpm store prune");
  }
}
console.log("");

// 4. 检查包的依赖信息（如果提供了项目路径）
console.log("4️⃣  Diagnose possible reasons:");
console.log("----------------------------------------");
const reasons = [];

if (!packageFound) {
  reasons.push({
    reason: "Package not in Store",
    description: "This is the first time to install the package, or the package has never been used by other projects",
    solution: "This is a normal behavior, after installation, the package will be added to the store, and subsequent projects can reuse it",
  });
} else if (packageVersion) {
  const dirs = foundDirs.split("\n").filter(Boolean);
  const hasExactVersion = dirs.some((dir) => {
    try {
      const pkgJsonPath = path.join(dir, "package.json");
      const pkgJsonContent = readFileSync(pkgJsonPath, "utf8");
      const pkgJson = JSON.parse(pkgJsonContent);
      return pkgJson.version === packageVersion;
    } catch (e) {
      return false;
    }
  });

  if (!hasExactVersion) {
    reasons.push({
      reason: "Version mismatch",
      description: `Store has the package, but the version is not ${packageVersion}`,
      solution: "Different projects use different versions of the package, this is normal",
    });
  }
}

// 检查镜像源配置
try {
  const registry = execSync("pnpm config get registry", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`📦 Current mirror source: ${registry}`);
  
  if (registry.includes("npmmirror.com")) {
    reasons.push({
      reason: "Mirror source problem",
      description: "When using the domestic mirror source, some packages may need to be re-downloaded",
      solution: "This is normal, the mirror source synchronization may have a delay",
    });
  }
} catch (e) {
  // 忽略
}

if (reasons.length === 0) {
  console.log("✅ No obvious problems found");
  console.log("   💡 If still downloading, it may be:");
  console.log("   - Package integrity verification failed");
  console.log("   - Dependency resolution requires a specific version");
  console.log("   - Hard link failed, fallback to download");
} else {
  console.log("Possible reasons:");
  reasons.forEach((item, index) => {
    console.log(`\n${index + 1}. ${item.reason}`);
    console.log(`    Description: ${item.description}`);
    console.log(`    Solution: ${item.solution}`);
  });
}
console.log("");

// 5. 建议的进一步检查
console.log("5️⃣  Further checks recommended:");
console.log("----------------------------------------");
const encodedPackageNameForHelp = packageName
  .replace(/@/g, "%40")
  .replace(/\//g, "%2f");
console.log("1. View detailed installation logs (add --loglevel=debug):");
console.log(`   pnpm install --loglevel=debug 2>&1 | grep -i "${packageName}"`);
console.log("");
console.log("2. Check the lock file of the project:");
console.log(`   cat pnpm-lock.yaml | grep -A 5 "${packageName}"`);
console.log("");
console.log("3. Manually check the store content (traverse all hash shards):");
console.log(`   # 方法1: 使用 find 递归查找`);
console.log(`   find "${storePath}/files" -type d -name "*${encodedPackageNameForHelp}*" 2>/dev/null`);
console.log(`   find "${storePath}/index" -type f -name "*${encodedPackageNameForHelp}*" 2>/dev/null`);
console.log("");
console.log(`   # Method 2: Traverse the hash sharding directory (if you know the approximate hash value):`);
console.log(`   for dir in "${storePath}/files"/{00..ff}; do`);
console.log(`     [ -d "$dir" ] && ls -la "$dir" 2>/dev/null | grep -q "${encodedPackageNameForHelp}" && echo "找到在: $dir";`);
console.log(`   done`);
console.log("");
console.log("4. Check the dependency of the package:");
console.log(`   pnpm why ${packageName}`);
console.log("");
console.log("5. Use pnpm command to check (if the package is installed):");
console.log(`   pnpm list ${packageName}`);
console.log(`   pnpm store status | grep -i "${packageName}"`);
console.log("");
