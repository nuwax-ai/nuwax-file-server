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
  console.error("❌ 请提供包名");
  console.log("\n使用方法:");
  console.log("  node scripts/check-package-in-store.js <package-name> [version]");
  console.log("\n示例:");
  console.log("  node scripts/check-package-in-store.js @radix-ui/react-toggle");
  console.log("  node scripts/check-package-in-store.js @radix-ui/react-toggle 1.0.3");
  process.exit(1);
}

console.log("======================================");
console.log("pnpm Store 包诊断工具");
console.log("======================================");
console.log("");

// 1. 获取 store 路径
console.log("1️⃣  检查 pnpm Store 路径:");
console.log("----------------------------------------");
let storePath;
try {
  storePath = execSync("pnpm store path", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`✅ Store 路径: ${storePath}`);
  
  // 检查 store 结构
  const filesDir = path.join(storePath, "files");
  const indexDir = path.join(storePath, "index");
  if (filesDir && indexDir) {
    console.log(`   Store 结构: pnpm v10 (哈希分片存储)`);
    console.log(`   - files/ 目录: 存储哈希文件`);
    console.log(`   - index/ 目录: 存储索引信息`);
  }
} catch (error) {
  console.error(`❌ 无法获取 store 路径: ${error.message}`);
  process.exit(1);
}
console.log("");

// 2. 检查 store 中是否有该包
console.log("2️⃣  检查 Store 中是否存在该包:");
console.log("----------------------------------------");
let foundDirs = "";
let packageFound = false;

try {
  // pnpm v10 store 结构: store/v10/files/ 和 store/v10/index/
  // files/ 目录下是哈希分片目录（00-ff），每个分片目录下是哈希命名的文件
  // index/ 目录存储索引信息
  const encodedPackageName = packageName
    .replace(/@/g, "%40")
    .replace(/\//g, "%2f");
  
  const filesDir = path.join(storePath, "files");
  const indexDir = path.join(storePath, "index");
  
  console.log(`   搜索包: ${packageName}`);
  console.log(`   编码后的包名: ${encodedPackageName}`);
  console.log(`   Store files 目录: ${filesDir}`);
  console.log(`   Store index 目录: ${indexDir}`);
  console.log("   (注意: pnpm v10 使用哈希文件存储，包以哈希值命名)");
  console.log("");
  
  // 方法1: 使用 pnpm store status 检查（最可靠的方法）
  console.log("   方法1: 使用 pnpm store status 检查...");
  try {
    const statusOutput = execSync("pnpm store status", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    
    // 检查输出中是否包含该包的信息
    if (statusOutput.includes(packageName) || statusOutput.includes(encodedPackageName)) {
      console.log("   ✅ pnpm store status 显示该包相关信息:");
      const relevantLines = statusOutput
        .split("\n")
        .filter(line => line.includes(packageName) || line.includes(encodedPackageName))
        .slice(0, 5);
      relevantLines.forEach(line => console.log(`      ${line}`));
      packageFound = true;
    } else {
      console.log("   ⚠️  pnpm store status 中未找到该包的直接信息");
    }
  } catch (e) {
    console.log(`   ⚠️  无法执行 pnpm store status: ${e.message}`);
  }
  console.log("");
  
  // 方法2: 在 index 目录中查找（索引可能包含包名信息）
  console.log("   方法2: 在 index 目录中查找...");
  try {
    const findCommand = `find "${indexDir}" -type f -exec grep -l "${encodedPackageName}" {} \\; 2>/dev/null | head -10`;
    const indexFiles = execSync(findCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    
    if (indexFiles) {
      console.log("   ✅ 在 index 中找到相关文件:");
      indexFiles.split("\n").slice(0, 5).forEach(file => {
        console.log(`      ${file}`);
      });
      packageFound = true;
    } else {
      console.log("   ⚠️  index 目录中未找到相关文件");
    }
  } catch (e) {
    console.log(`   ⚠️  搜索 index 目录时出错: ${e.message}`);
  }
  console.log("");
  
  // 方法3: 尝试在整个 store 中查找包含包名的任何内容
  console.log("   方法3: 在整个 store 中搜索包名...");
  try {
    const findCommand = `grep -r "${encodedPackageName}" "${indexDir}" 2>/dev/null | head -5`;
    const grepResults = execSync(findCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    
    if (grepResults) {
      console.log("   ✅ 找到包含包名的内容:");
      grepResults.split("\n").forEach(line => {
        const parts = line.split(":");
        if (parts.length > 1) {
          console.log(`      文件: ${parts[0]}`);
          console.log(`      内容: ${parts.slice(1).join(":").substring(0, 100)}...`);
        }
      });
      packageFound = true;
    }
  } catch (e) {
    // grep 没找到结果时会返回非零退出码，这是正常的
    if (e.status !== 1) {
      console.log(`   ⚠️  搜索时出错: ${e.message}`);
    }
  }

  // 总结查找结果
  console.log("   📊 查找结果总结:");
  if (packageFound) {
    console.log("   ✅ 在 store 中找到该包的相关信息");
  } else {
    console.log(`   ❌ 未在 store 中找到包: ${packageName}`);
    console.log("   💡 这可能是下载的原因：包不在 store 中");
  }
} catch (error) {
  console.log(`⚠️  检查过程中出错: ${error.message}`);
}
console.log("");

// 3. 检查 store 状态
console.log("3️⃣  检查 Store 状态:");
console.log("----------------------------------------");
try {
  const statusOutput = execSync("pnpm store status", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  console.log(statusOutput);
} catch (error) {
  console.log(`⚠️  无法获取 store 状态: ${error.message}`);
  if (error.message.includes("ENOENT")) {
    console.log("   💡 Store 索引可能损坏，建议运行: pnpm store prune");
  }
}
console.log("");

// 4. 检查包的依赖信息（如果提供了项目路径）
console.log("4️⃣  诊断可能的原因:");
console.log("----------------------------------------");
const reasons = [];

if (!packageFound) {
  reasons.push({
    reason: "包不在 Store 中",
    description: "这是首次安装该包，或者该包从未被其他项目使用过",
    solution: "这是正常行为，安装后该包会被添加到 store，后续项目可以复用",
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
      reason: "版本不匹配",
      description: `Store 中有该包，但版本不是 ${packageVersion}`,
      solution: "不同项目使用了不同版本的包，这是正常的",
    });
  }
}

// 检查镜像源配置
try {
  const registry = execSync("pnpm config get registry", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`📦 当前镜像源: ${registry}`);
  
  if (registry.includes("npmmirror.com")) {
    reasons.push({
      reason: "镜像源问题",
      description: "使用国内镜像源时，某些包可能需要重新下载",
      solution: "这是正常的，镜像源同步可能有延迟",
    });
  }
} catch (e) {
  // 忽略
}

if (reasons.length === 0) {
  console.log("✅ 未发现明显问题");
  console.log("   💡 如果仍然下载，可能是:");
  console.log("   - 包的完整性验证失败");
  console.log("   - 依赖解析导致需要特定版本");
  console.log("   - 硬链接失败，回退到下载");
} else {
  console.log("可能的原因:");
  reasons.forEach((item, index) => {
    console.log(`\n${index + 1}. ${item.reason}`);
    console.log(`   描述: ${item.description}`);
    console.log(`   解决: ${item.solution}`);
  });
}
console.log("");

// 5. 建议的进一步检查
console.log("5️⃣  建议的进一步检查:");
console.log("----------------------------------------");
const encodedPackageNameForHelp = packageName
  .replace(/@/g, "%40")
  .replace(/\//g, "%2f");
console.log("1. 查看详细安装日志（添加 --loglevel=debug）:");
console.log(`   pnpm install --loglevel=debug 2>&1 | grep -i "${packageName}"`);
console.log("");
console.log("2. 检查项目的 lock 文件:");
console.log(`   cat pnpm-lock.yaml | grep -A 5 "${packageName}"`);
console.log("");
console.log("3. 手动检查 store 内容（遍历所有哈希分片）:");
console.log(`   # 方法1: 使用 find 递归查找`);
console.log(`   find "${storePath}/files" -type d -name "*${encodedPackageNameForHelp}*" 2>/dev/null`);
console.log(`   find "${storePath}/index" -type f -name "*${encodedPackageNameForHelp}*" 2>/dev/null`);
console.log("");
console.log(`   # 方法2: 遍历哈希分片目录（如果知道大概的哈希值）`);
console.log(`   for dir in "${storePath}/files"/{00..ff}; do`);
console.log(`     [ -d "$dir" ] && ls -la "$dir" 2>/dev/null | grep -q "${encodedPackageNameForHelp}" && echo "找到在: $dir";`);
console.log(`   done`);
console.log("");
console.log("4. 检查包的依赖关系:");
console.log(`   pnpm why ${packageName}`);
console.log("");
console.log("5. 使用 pnpm 命令检查（如果包已安装）:");
console.log(`   pnpm list ${packageName}`);
console.log(`   pnpm store status | grep -i "${packageName}"`);
console.log("");
