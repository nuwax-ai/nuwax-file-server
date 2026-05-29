import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { log } from "../log/logUtils.js";

/**
 * 模板预构建缓存工具
 *
 * 核心功能：
 * 1. 检测项目路径所在的文件系统类型（JuiceFS FUSE vs 本地 ext4）
 * 2. 预热模板缓存（解压 zip + pnpm install），服务启动时调用一次
 * 3. 新项目创建时从缓存复制 node_modules，避免全量 pnpm install
 *
 * 缓存目录优先级：
 *   1. TEMPLATE_CACHE_DIR 环境变量（K8s emptyDir 挂载点）
 *   2. /local-cache/templates（K8s 默认挂载点）
 *   3. project_workspace 同级的 .template-cache（Docker Compose 宿主机目录）
 */

/**
 * 获取缓存基础目录
 * @returns {string} 缓存目录路径
 */
function getCacheBaseDir() {
  // 优先级 1：环境变量（K8s emptyDir）
  if (process.env.TEMPLATE_CACHE_DIR) {
    return process.env.TEMPLATE_CACHE_DIR;
  }

  // 优先级 2：K8s 默认挂载点
  if (fs.existsSync("/local-cache")) {
    return "/local-cache/templates";
  }

  // 优先级 3：Docker Compose 宿主机目录
  // project_workspace 通常在 /app/project_workspace，缓存放同级目录
  const workspaceDir =
    process.env.PROJECT_WORKSPACE_DIR || "/app/project_workspace";
  return path.join(path.dirname(workspaceDir), ".template-cache");
}

/**
 * 检测项目路径所在的文件系统类型
 *
 * 通过读取 /proc/mounts 判断挂载类型：
 * - fuse（JuiceFS / NFS-over-FUSE）→ 返回 'fuse'
 * - ext4 / xfs / overlay → 返回 'local'
 *
 * @param {string} projectPath - 项目路径
 * @returns {string} 'fuse' 或 'local'
 */
function detectFilesystemType(projectPath) {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8");
    const lines = mounts.split("\n");

    // 找到匹配项目路径的挂载点（取最长匹配）
    let bestMatch = "";
    let bestType = "local";

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      const mountPoint = parts[1];
      const fsType = parts[2];

      if (
        projectPath.startsWith(mountPoint) &&
        mountPoint.length > bestMatch.length
      ) {
        bestMatch = mountPoint;
        bestType = fsType;
      }
    }

    // fuse 类型包括：fuse.juicefs, fuse.sshfs, fuse.rclone 等
    if (bestType.startsWith("fuse")) {
      return "fuse";
    }

    return "local";
  } catch (_) {
    // 无法读取 /proc/mounts 时，默认本地
    return "local";
  }
}

/**
 * 从项目的 package.json 检测模板类型
 * @param {string} projectPath - 项目路径
 * @returns {string|null} 'vue3' | 'react' | null
 */
function detectTemplateType(projectPath) {
  try {
    const pkgPath = path.join(projectPath, "package.json");
    if (!fs.existsSync(pkgPath)) return null;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const name = (pkg.name || "").toLowerCase();
    const deps = pkg.dependencies || {};

    // 从包名推断
    if (name.includes("vue3") || name.includes("vue-vite")) return "vue3";
    if (name.includes("react-vite") || name.includes("react")) return "react";

    // 从依赖推断
    if (deps.vue) return "vue3";
    if (deps.react) return "react";
  } catch (_) {}

  return null;
}

/**
 * 预热模板缓存
 *
 * 解压模板 zip 到缓存目录，执行 pnpm install，写入 .cache-ready 标记。
 * 如果 .cache-ready 已存在则跳过（幂等）。
 *
 * @param {string} templateDir - 模板 zip 所在目录（如 /app/project_init）
 */
async function warmupTemplateCache(templateDir) {
  const cacheBase = getCacheBaseDir();
  log("CACHE", "INFO", `Template cache base dir: ${cacheBase}`);
  log("CACHE", "INFO", `pnpm store dir: ${process.env.PNPM_STORE_DIR || "(default: ~/.local/share/pnpm/store)"}`);

  const templates = [
    { name: "vue3", zip: "vue3-vite-template.zip" },
    { name: "react", zip: "react-vite-template.zip" },
  ];

  fs.mkdirSync(cacheBase, { recursive: true });

  for (const tpl of templates) {
    const cachePath = path.join(cacheBase, tpl.name);
    const markerPath = path.join(cachePath, ".cache-ready");

    // 已预热过，跳过
    if (fs.existsSync(markerPath)) {
      log("CACHE", "INFO", `Template cache already ready: ${tpl.name}`, {
        cachePath,
      });
      continue;
    }

    const zipPath = path.join(templateDir, tpl.zip);
    if (!fs.existsSync(zipPath)) {
      log("CACHE", "WARN", `Template zip not found, skip: ${zipPath}`);
      continue;
    }

    log("CACHE", "INFO", `Warming up template cache: ${tpl.name}`, {
      zipPath,
      cachePath,
    });
    const startTime = Date.now();

    try {
      fs.mkdirSync(cachePath, { recursive: true });

      // 1. 解压 zip
      execSync(`unzip -o "${zipPath}" -d "${cachePath}"`, { stdio: "pipe" });

      // 2. 去除顶层目录（模板 zip 通常有一个顶层目录包裹）
      removeTopLevelDir(cachePath);

      // 3. 写 .npmrc（缓存用 copy 模式，因为可能被复制到 JuiceFS）
      const npmrcContent = `# Template cache npmrc - auto-generated
package-import-method=copy
auto-install-peers=true
registry=https://registry.npmmirror.com
`;
      fs.writeFileSync(path.join(cachePath, ".npmrc"), npmrcContent, "utf8");

      // 4. 执行 pnpm install
      log("CACHE", "INFO", `Running pnpm install for ${tpl.name} cache...`);
      execSync(`cd "${cachePath}" && pnpm install --prefer-offline`, {
        stdio: "pipe",
        timeout: 180000, // 3 分钟超时
        env: process.env,
      });

      // 5. 写 .cache-ready 标记
      fs.writeFileSync(markerPath, new Date().toISOString(), "utf8");

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log("CACHE", "INFO", `Template cache ready: ${tpl.name}`, {
        elapsed: `${elapsed}s`,
        cachePath,
      });
    } catch (error) {
      log("CACHE", "ERROR", `Template cache failed: ${tpl.name}`, {
        error: error.message,
      });
      // 清理失败的缓存
      try {
        fs.rmSync(cachePath, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

/**
 * 获取项目的本地 node_modules 路径（在本地磁盘上，非 JuiceFS）
 *
 * @param {string} projectId - 项目 ID
 * @returns {string} 本地 node_modules 路径
 */
function getLocalNodeModulesPath(projectId) {
  // 优先使用环境变量指定的目录
  const baseDir = process.env.NODE_MODULES_LOCAL_DIR || "/local-cache/node-modules";
  return path.join(baseDir, projectId, "node_modules");
}

/**
 * 从缓存复制 node_modules 到项目
 *
 * JuiceFS 环境：复制到本地磁盘 + 创建 symlink（避免 FUSE 慢）
 * 本地磁盘环境：直接 cp -a（已经很快）
 *
 * @param {string} projectPath - 项目路径
 * @param {string} projectId - 项目 ID（用于日志）
 * @returns {Promise<Object>} { cached: boolean, templateType?: string, elapsed?: string, reason?: string }
 */
async function copyNodeModulesFromCache(projectPath, projectId) {
  const logId = projectId || path.basename(projectPath);

  // 检测模板类型
  const templateType = detectTemplateType(projectPath);
  if (!templateType) {
    log(logId, "WARN", "Cannot detect template type, skip cache copy", {
      projectPath,
    });
    return { cached: false, reason: "unknown-template" };
  }

  // 检查缓存是否存在
  const cacheBase = getCacheBaseDir();
  const cacheNodeModules = path.join(cacheBase, templateType, "node_modules");
  const markerPath = path.join(cacheBase, templateType, ".cache-ready");

  if (!fs.existsSync(markerPath) || !fs.existsSync(cacheNodeModules)) {
    log(logId, "INFO", `Template cache not ready: ${templateType}`, {
      cacheNodeModules,
    });
    return { cached: false, reason: "cache-not-ready" };
  }

  const targetNodeModules = path.join(projectPath, "node_modules");

  // 检查 node_modules 状态（区分正常存在、断链、不存在）
  let targetExists = false;
  let isBrokenSymlink = false;

  try {
    const lstat = fs.lstatSync(targetNodeModules);
    if (lstat.isSymbolicLink()) {
      // 是 symlink，检查目标是否存在
      if (fs.existsSync(targetNodeModules)) {
        // symlink 有效，跳过
        log(logId, "INFO", "node_modules is a valid symlink, skip cache copy");
        return { cached: false, reason: "already-exists" };
      } else {
        // symlink 断链（可能 Pod 迁移到了新节点，旧 symlink 指向的本地路径不存在）
        isBrokenSymlink = true;
        log(logId, "WARN", "node_modules is a broken symlink (pod may have migrated to new node), will recreate", {
          symlink: targetNodeModules,
        });
      }
    } else {
      // 普通目录，已存在
      log(logId, "INFO", "node_modules already exists, skip cache copy");
      return { cached: false, reason: "already-exists" };
    }
  } catch (_) {
    // 不存在，继续
  }

  const startTime = Date.now();

  // 检测文件系统类型，决定是否使用 symlink 策略
  const fsType = detectFilesystemType(projectPath);
  const useSymlink = fsType === "fuse";

  if (useSymlink) {
    // JuiceFS 环境：复制到本地磁盘 + 创建 symlink
    const localNodeModules = getLocalNodeModulesPath(projectId);
    const localProjectDir = path.dirname(localNodeModules);

    log(logId, "INFO", `JuiceFS detected, using symlink strategy: ${templateType}`, {
      source: cacheNodeModules,
      localTarget: localNodeModules,
      symlink: targetNodeModules,
    });

    try {
      // 创建本地目录
      fs.mkdirSync(localProjectDir, { recursive: true });

      // 复制到本地磁盘（快！）
      execSync(`cp -a "${cacheNodeModules}" "${localNodeModules}"`, {
        timeout: 60000,
        stdio: "pipe",
      });

      // 如果是断链（Pod 迁移到新节点），先删除旧 symlink
      if (isBrokenSymlink) {
        try {
          fs.unlinkSync(targetNodeModules);
          log(logId, "INFO", "Removed broken symlink before creating new one");
        } catch (unlinkErr) {
          log(logId, "WARN", `Failed to remove broken symlink: ${unlinkErr.message}`);
        }
      }

      // 创建 symlink: {projectPath}/node_modules → /local-cache/node-modules/{projectId}/node_modules
      fs.symlinkSync(localNodeModules, targetNodeModules, "dir");

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(logId, "INFO", `node_modules ready via symlink`, {
        templateType,
        elapsed: `${elapsed}s`,
        symlink: `${targetNodeModules} → ${localNodeModules}`,
      });

      return { cached: true, templateType, elapsed, strategy: "symlink" };
    } catch (error) {
      log(logId, "WARN", `Failed to setup node_modules symlink: ${error.message}`, {
        templateType,
      });
      // 清理
      try { fs.rmSync(localNodeModules, { recursive: true, force: true }); } catch (_) {}
      try { fs.unlinkSync(targetNodeModules); } catch (_) {}
      return { cached: false, reason: "symlink-failed", error: error.message };
    }
  } else {
    // 本地磁盘环境：直接 cp -a
    log(logId, "INFO", `Local filesystem, using direct copy: ${templateType}`, {
      source: cacheNodeModules,
      target: targetNodeModules,
    });

    try {
      execSync(`cp -a "${cacheNodeModules}" "${targetNodeModules}"`, {
        timeout: 60000,
        stdio: "pipe",
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(logId, "INFO", `node_modules copied from cache successfully`, {
        templateType,
        elapsed: `${elapsed}s`,
      });

      return { cached: true, templateType, elapsed, strategy: "copy" };
    } catch (error) {
      log(logId, "WARN", `Failed to copy node_modules from cache: ${error.message}`, {
        templateType,
      });
      try { fs.rmSync(targetNodeModules, { recursive: true, force: true }); } catch (_) {}
      return { cached: false, reason: "copy-failed", error: error.message };
    }
  }
}

/**
 * 去除目录中的顶层包裹目录
 *
 * 如果目录中只有一个非隐藏的子目录，将该子目录的内容提升到父目录。
 * 例如：dir/react-vite-template/... → dir/...
 *
 * @param {string} dirPath - 目录路径
 */
function removeTopLevelDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const filtered = entries.filter(
      (e) => !e.name.startsWith(".") && e.name !== "node_modules"
    );

    // 只有一个非隐藏目录时，认为是顶层包裹
    if (filtered.length === 1 && filtered[0].isDirectory()) {
      const topDir = path.join(dirPath, filtered[0].name);
      const tmpDir = path.join(dirPath, `..tmp_${Date.now()}`);

      // 先移到临时目录，再移回来
      fs.renameSync(topDir, tmpDir);

      const tmpEntries = fs.readdirSync(tmpDir);
      for (const entry of tmpEntries) {
        fs.renameSync(
          path.join(tmpDir, entry),
          path.join(dirPath, entry)
        );
      }

      fs.rmdirSync(tmpDir);
    }
  } catch (error) {
    // 失败不影响主流程
  }
}

export {
  getCacheBaseDir,
  getLocalNodeModulesPath,
  detectFilesystemType,
  detectTemplateType,
  warmupTemplateCache,
  copyNodeModulesFromCache,
};
