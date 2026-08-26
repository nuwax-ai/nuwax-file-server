import fs from "fs";
import path from "path";
import { exec } from "child_process";
import spawn from "cross-spawn";
import archiver from "archiver";
import config from "../../appConfig/index.js";
import { extractZip } from "../common/zipUtils.js";
import {
  ValidationError,
  SystemError,
  FileError,
} from "../error/errorHandler.js";
import { log } from "../log/logUtils.js";
import { createPnpmNpmrc } from "../common/npmrcUtils.js";
import {
  ensurePrimaryAgentDirs,
  syncAgents,
  linkWorkspaceToAgentStore,
  isWorkspaceSkillsSymlinked,
} from "../common/AgentWorkspaceUtils.js";
import {
  ensureAgentStoreDirs,
  tryAcquireAgentStoreLock,
  releaseAgentStoreLock,
  pruneAgentSkills,
  installSkillDir,
  replaceAgentsDir,
  agentSkillExists,
} from "../common/agentStoreUtils.js";
import {
  writeAgentHookConfigs,
} from "./hookConfigUtils.js";
import { ensureWorkspaceDir, resolveWorkspaceDir, resolveWorkspaceRoot } from "./workspaceContext.js";

/**
 * 规范化 skillUrls 参数，兼容数组/JSON 字符串/单字符串
 * @param {unknown} skillUrls
 * @returns {string[]}
 */
function normalizeSkillUrls(skillUrls) {
  if (!skillUrls) return [];
  if (Array.isArray(skillUrls)) {
    return skillUrls
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && typeof item.url === "string") {
          return item.url.trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof skillUrls === "object") {
    // { name: url } → 仅取 url 列表（兼容旧逻辑全量下载）
    return Object.values(skillUrls)
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  if (typeof skillUrls === "string") {
    const trimmed = skillUrls.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeSkillUrls(parsed);
    } catch {
      // 非 JSON 字符串，按单个 URL 处理
    }
    return [trimmed];
  }
  return [];
}

/**
 * 规范化带技能名的 skillUrls：
 * - { name: url }
 * - [{ name, url }]
 * - ["url"]（name 为 null，无法在下载前跳过）
 * @returns {{ name: string|null, url: string }[]}
 */
function normalizeNamedSkillUrls(skillUrls) {
  if (!skillUrls) return [];
  if (Array.isArray(skillUrls)) {
    const result = [];
    for (const item of skillUrls) {
      if (typeof item === "string" && item.trim()) {
        result.push({ name: null, url: item.trim() });
      } else if (item && typeof item === "object") {
        const url = typeof item.url === "string" ? item.url.trim() : "";
        const name = item.name != null ? String(item.name).trim() : "";
        if (url) result.push({ name: name || null, url });
      }
    }
    return result;
  }
  if (typeof skillUrls === "object") {
    return Object.entries(skillUrls)
      .map(([name, url]) => ({
        name: String(name || "").trim() || null,
        url: typeof url === "string" ? url.trim() : "",
      }))
      .filter((e) => e.url);
  }
  if (typeof skillUrls === "string") {
    const trimmed = skillUrls.trim();
    if (!trimmed) return [];
    try {
      return normalizeNamedSkillUrls(JSON.parse(trimmed));
    } catch {
      return [{ name: null, url: trimmed }];
    }
  }
  return [];
}

/**
 * 规范化 skillUrlMap：{ skillName: url }
 * @returns {Record<string, string>}
 */
function normalizeSkillUrlMap(skillUrlMap) {
  if (!skillUrlMap) return {};
  let raw = skillUrlMap;
  if (typeof skillUrlMap === "string") {
    try {
      raw = JSON.parse(skillUrlMap);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result = {};
  for (const [name, url] of Object.entries(raw)) {
    const n = String(name || "").trim();
    const u = typeof url === "string" ? url.trim() : "";
    if (n && u) {
      result[n] = u;
    }
  }
  return result;
}

function normalizeNameList(names) {
  if (!names) return [];
  if (Array.isArray(names)) {
    return names.map((n) => String(n || "").trim()).filter(Boolean);
  }
  if (typeof names === "string") {
    const trimmed = names.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((n) => String(n || "").trim()).filter(Boolean);
      }
    } catch {
      // ignore
    }
    return trimmed.split(",").map((n) => n.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 下载 URL 到本地文件
 * @param {string} url
 * @param {string} destinationPath
 * @param {string} logId
 */
async function downloadUrlToFile(url, destinationPath, logId) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new FileError(`Failed to download skill zip from url: ${url}`, {
      url,
      reason: error.message,
    });
  }

  if (!response.ok) {
    throw new FileError(`Failed to download skill zip from url: ${url}`, {
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const contentType = response.headers.get("content-type") || "";
  if (
    contentType &&
    !contentType.includes("zip") &&
    !contentType.includes("octet-stream")
  ) {
    log(logId, "WARN", "Downloaded skill url content-type is not typical zip", {
      url,
      contentType,
    });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(destinationPath, buffer);
}

/**
 * 递归查找指定目录（如果不是直接在根目录）
 * @param {string} rootDir - 根目录
 * @param {string} dirName - 要查找的目录名（如 "skills" 或 "agents"）
 * @returns {Promise<string|null>} 找到的目录路径，如果不存在则返回 null
 */
async function findDir(rootDir, dirName) {
  const directDir = path.join(rootDir, dirName);
  if (fs.existsSync(directDir) && (await fs.promises.lstat(directDir)).isDirectory()) {
    return directDir;
  }

  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(rootDir, entry.name);
    const candidate = path.join(subDir, dirName);
    if (fs.existsSync(candidate) && (await fs.promises.lstat(candidate)).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

/**
 * 递归查找 skills 目录（如果不是直接在根目录）
 * @deprecated 使用 findDir(rootDir, "skills") 代替
 */
async function findSkillsDir(rootDir) {
  return findDir(rootDir, "skills");
}

const DYNAMIC_ADD_LOCK = ".dynamic_add.lock";

/**
 * 检查 skill 目录是否含有 .dynamic_add.lock（有则不应删除）
 */
function hasDynamicAddLock(skillDirPath) {
  const lockPath = path.join(skillDirPath, DYNAMIC_ADD_LOCK);
  return fs.existsSync(lockPath) && fs.statSync(lockPath).isFile();
}

/**
 * 删除目录（如果存在）
 */
async function removeDirIfExists(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  await fs.promises.rm(targetDir, { recursive: true, force: true });
}

/**
 * 安全移动目录（跨设备时回退为 copy）
 */
async function moveDirectory(srcDir, destDir) {
  try {
    await fs.promises.rename(srcDir, destDir);
  } catch (err) {
    if (err.code === "EXDEV") {
      // 跨设备，使用 copy + rm
      async function copyRecursive(src, dest) {
        const stat = await fs.promises.lstat(src);
        if (stat.isDirectory()) {
          await fs.promises.mkdir(dest, { recursive: true });
          const items = await fs.promises.readdir(src);
          for (const item of items) {
            await copyRecursive(
              path.join(src, item),
              path.join(dest, item)
            );
          }
        } else {
          await fs.promises.copyFile(src, dest);
        }
      }

      await copyRecursive(srcDir, destDir);
      await fs.promises.rm(srcDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * 从解压根目录收集 skill 子目录（支持 skills/<name> 或直接 <name>）
 */
async function collectSkillDirsFromExtractRoot(extractRoot) {
  const extractedEntries = await fs.promises.readdir(extractRoot, {
    withFileTypes: true,
  });
  const rootDirs = extractedEntries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".")
  );
  const skillsRootDir = rootDirs.find((entry) => entry.name === "skills");
  if (skillsRootDir) {
    const skillEntries = await fs.promises.readdir(
      path.join(extractRoot, "skills"),
      { withFileTypes: true }
    );
    return skillEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        sourcePath: path.join(extractRoot, "skills", entry.name),
      }));
  }
  return rootDirs.map((entry) => ({
    name: entry.name,
    sourcePath: path.join(extractRoot, entry.name),
  }));
}

/** 技能下载/解压/安装并发上限 */
const SKILL_INSTALL_CONCURRENCY = 8;

/**
 * 有限并发执行（异步 I/O 并发）
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} fn
 */
async function mapPool(items, concurrency, fn) {
  if (!items || items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    })
  );
}

/**
 * 智能体级实体存储 + 会话工作区软链（createWorkspace 主路径）
 *
 * - skillUrls：纯 url 数组（兼容旧 FS）
 * - skillUrlMap：{skill.md name: url}，新 FS 下载前按名跳过；安装目录名用 map 的 key
 * - updateSkillNames / skillNames：按需安装与 prune
 */
async function createWorkspaceWithAgentStore(options) {
  const {
    userId,
    cId,
    agentId,
    file,
    skillUrls,
    skillUrlMap,
    skillNames,
    updateSkillNames,
    mcpServersConfig,
    permissionsConfig,
    hooksConfig,
    hookScripts,
    service,
  } = options;

  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const urlMap = normalizeSkillUrlMap(skillUrlMap);
  const namedSkillUrls = normalizeNamedSkillUrls(skillUrls);
  const keepSkillNames = normalizeNameList(skillNames);
  // updateSkillNames 显式传入（含空数组）时启用按需安装；未传则全量安装（兼容旧客户端）
  const selectiveInstall = updateSkillNames !== undefined && updateSkillNames !== null;
  const updateSkillNameSet = new Set(normalizeNameList(updateSkillNames));
  const downloadedZipPaths = [];
  const extractRoots = [];
  const updatedSkillSet = new Set();
  const skippedSkillSet = new Set();
  let lockPath = null;
  let skippedStoreUpdate = false;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!agentId) {
    throw new ValidationError("agentId cannot be empty", { field: "agentId" });
  }

  const workspaceRoot = resolveWorkspaceRoot(service);
  const userWorkspaceRoot = await ensureWorkspaceDir(service, userId, cId, logId);
  const tmpRoot = path.join(userWorkspaceRoot, ".tmp");
  await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
  await fs.promises.mkdir(tmpRoot, { recursive: true });

  const { agentStorePath, skillsDir: agentSkillsDir, agentsDir: agentAgentsDir } =
    await ensureAgentStoreDirs(userId, agentId, logId, service);

  const shouldInstallSkill = (skillName) => {
    if (!skillName) return true;
    if (!selectiveInstall) return true;
    if (updateSkillNameSet.has(skillName)) return true;
    return !agentSkillExists(agentSkillsDir, skillName);
  };

  /**
   * 下载并安装单个 skill zip；destName 为 skill.md name（协议约定的目录名）
   */
  const downloadAndInstallSkillUrl = async (skillUrl, destName, index) => {
    const downloadedZipPath = path.join(
      tmpRoot,
      `skill_url_${Date.now()}_${index}_${Math.round(Math.random() * 1e6)}.zip`
    );
    downloadedZipPaths.push(downloadedZipPath);
    const urlExtractRoot = path.join(
      tmpRoot,
      `skill_url_extract_${Date.now()}_${index}_${Math.round(Math.random() * 1e6)}`
    );
    extractRoots.push(urlExtractRoot);
    await fs.promises.mkdir(urlExtractRoot, { recursive: true });

    log(logId, "INFO", "Start download skill zip from url", {
      userId,
      cId,
      agentId,
      skillName: destName,
      skillUrl,
    });
    await downloadUrlToFile(skillUrl, downloadedZipPath, logId);
    await extractZip(downloadedZipPath, urlExtractRoot);

    const candidateSkillDirs = await collectSkillDirsFromExtractRoot(urlExtractRoot);
    if (candidateSkillDirs.length === 0) {
      log(logId, "WARN", "No skill dir found in downloaded zip", { skillUrl, destName });
      return;
    }

    let sourceDir = destName
      ? candidateSkillDirs.find((d) => d.name === destName)
      : null;
    if (!sourceDir && candidateSkillDirs.length === 1) {
      sourceDir = candidateSkillDirs[0];
    }
    if (destName && sourceDir) {
      if (!shouldInstallSkill(destName)) {
        skippedSkillSet.add(destName);
        return;
      }
      await installSkillDir(sourceDir.sourcePath, agentSkillsDir, destName, { asDynamic: false });
      updatedSkillSet.add(destName);
      log(logId, "INFO", "Skill from url updated to agent store", {
        userId,
        cId,
        agentId,
        skillUrl,
        skillName: destName,
        zipDirName: sourceDir.name,
      });
      return;
    }

    for (const skillDir of candidateSkillDirs) {
      if (!shouldInstallSkill(skillDir.name)) {
        skippedSkillSet.add(skillDir.name);
        continue;
      }
      await installSkillDir(skillDir.sourcePath, agentSkillsDir, skillDir.name, {
        asDynamic: false,
      });
      updatedSkillSet.add(skillDir.name);
      log(logId, "INFO", "Skill from url updated to agent store", {
        userId,
        cId,
        agentId,
        skillUrl,
        skillName: skillDir.name,
      });
    }
  };

  await writeAgentHookConfigs(
    userWorkspaceRoot,
    { mcpServersConfig, hooksConfig, permissionsConfig, hookScripts },
    logId
  );

  try {
    const lock = await tryAcquireAgentStoreLock(agentStorePath, logId);
    if (!lock.acquired) {
      skippedStoreUpdate = true;
    } else {
      lockPath = lock.lockPath;
      const prepareStartedAt = Date.now();
      let agentsSrcDir = null;

      if (file) {
        if (!file.path) {
          throw new ValidationError("Uploaded file has no valid path", { field: "file.path" });
        }
        const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
        if (ext !== ".zip") {
          throw new ValidationError("Only zip files are supported", {
            field: "file",
            originalName: file.originalname,
          });
        }
        const uploadExtractRoot = path.join(
          tmpRoot,
          `skill_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
        );
        extractRoots.push(uploadExtractRoot);
        await fs.promises.mkdir(uploadExtractRoot, { recursive: true });
        await extractZip(file.path, uploadExtractRoot);

        const skillsDir = await findDir(uploadExtractRoot, "skills");
        if (skillsDir) {
          const skillEntries = (await fs.promises.readdir(skillsDir, { withFileTypes: true }))
            .filter((e) => e.isDirectory());
          await mapPool(skillEntries, SKILL_INSTALL_CONCURRENCY, async (e) => {
            if (!shouldInstallSkill(e.name)) {
              skippedSkillSet.add(e.name);
              return;
            }
            await installSkillDir(path.join(skillsDir, e.name), agentSkillsDir, e.name, {
              asDynamic: false,
            });
            updatedSkillSet.add(e.name);
          });
        }
        agentsSrcDir = await findDir(uploadExtractRoot, "agents");
      }

      const urlMapEntries = Object.entries(urlMap);
      if (urlMapEntries.length > 0) {
        // 优先 skillUrlMap：可按 skill.md name 在下载前跳过；需安装的并行下载解压
        const toInstall = [];
        for (const [skillName, skillUrl] of urlMapEntries) {
          if (!shouldInstallSkill(skillName)) {
            skippedSkillSet.add(skillName);
            log(logId, "INFO", "Skip download skill zip (already in agent store)", {
              userId,
              cId,
              agentId,
              skillName,
              skillUrl,
            });
            continue;
          }
          toInstall.push({ skillName, skillUrl });
        }
        await mapPool(toInstall, SKILL_INSTALL_CONCURRENCY, async (item, index) => {
          await downloadAndInstallSkillUrl(item.skillUrl, item.skillName, index);
        });
      } else {
        // 无 map 时回退 skillUrls 数组（无法下载前跳过）
        const toInstall = [];
        for (let i = 0; i < namedSkillUrls.length; i++) {
          const { name: hintedName, url: skillUrl } = namedSkillUrls[i];
          if (hintedName && !shouldInstallSkill(hintedName)) {
            skippedSkillSet.add(hintedName);
            continue;
          }
          toInstall.push({ skillUrl, hintedName, index: i });
        }
        await mapPool(toInstall, SKILL_INSTALL_CONCURRENCY, async (item) => {
          await downloadAndInstallSkillUrl(item.skillUrl, item.hintedName, item.index);
        });
      }

      // 每次 createWorkspace 刷新子 agent
      await replaceAgentsDir(agentsSrcDir, agentAgentsDir);

      await pruneAgentSkills(agentSkillsDir, keepSkillNames, logId);

      log(logId, "INFO", "Agent store resources prepared", {
        userId,
        cId,
        agentId,
        selectiveInstall,
        updatedSkills: Array.from(updatedSkillSet),
        skippedSkills: Array.from(skippedSkillSet),
        updateSkillNames: Array.from(updateSkillNameSet),
        keepSkillNames,
        skillUrlMapCount: urlMapEntries.length,
        prepareElapsedMs: Date.now() - prepareStartedAt,
      });
    }

    const linkResult = await linkWorkspaceToAgentStore(
      userWorkspaceRoot,
      agentSkillsDir,
      agentAgentsDir,
      logId
    );

    log(logId, "INFO", "Workspace created successfully (agent store)", {
      userId,
      cId,
      agentId,
      agentStorePath,
      updatedSkills: Array.from(updatedSkillSet),
      skippedSkills: Array.from(skippedSkillSet),
      skippedStoreUpdate,
      linkElapsedMs: linkResult?.elapsedMs,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message: skippedStoreUpdate
        ? "Workspace linked to agent store (store update skipped, lock held)"
        : "Workspace created successfully, linked to agent store",
      workspaceRoot,
      agentStorePath,
      updatedSkills: Array.from(updatedSkillSet),
      skippedSkills: Array.from(skippedSkillSet),
      skippedStoreUpdate,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to create workspace with agent store", {
      userId,
      cId,
      agentId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });
    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }
    throw new SystemError(`Failed to create workspace: ${error.message}`, {
      userId,
      cId,
      agentId,
    });
  } finally {
    await releaseAgentStoreLock(lockPath, logId);
    const cleanupStartedAt = Date.now();
    for (const extractRoot of extractRoots) {
      try {
        if (fs.existsSync(extractRoot)) {
          await fs.promises.rm(extractRoot, { recursive: true, force: true });
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up temporary extracted zip", { error: e.message });
      }
    }
    for (const downloadedZipPath of downloadedZipPaths) {
      try {
        if (fs.existsSync(downloadedZipPath)) {
          await fs.promises.unlink(downloadedZipPath);
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up downloaded skill zip file", {
          downloadedZipPath,
          error: e.message,
        });
      }
    }
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up uploaded zip file", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
    log(logId, "INFO", "Workspace temp cleanup completed", {
      userId,
      cId,
      agentId,
      elapsedMs: Date.now() - cleanupStartedAt,
      totalElapsedMs: Date.now() - startTime,
    });
  }
}

/**
 * 创建工作空间并（可选）处理上传的 zip，提取 skills 目录
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object|null} file multer 文件对象（zip），可以为空
 * @param {string[]|string|undefined} skillUrls 技能 zip 下载地址数组
 * @param {string|undefined} mcpServersConfig MCP servers配置 JSON字符串
 * @param {string|undefined} permissionsConfig 工具权限配置 JSON字符串
 * @param {string|undefined} hooksConfig Hooks配置 JSON字符串
 * @param {Array|undefined} hookScripts Hook外挂脚本数组 [{path, content}]
 * @param {string|number|undefined} agentId 智能体 ID（有则走实体存储+软链）
 * @param {string[]|string|undefined} skillNames 配置技能名全集（用于差集删除）
 * @param {string[]|string|undefined} updateSkillNames 强制更新的技能名（agentStore 按需安装）
 * @param {Record<string,string>|string|undefined} skillUrlMap 技能名→url（下载前跳过）
 */
async function createWorkspace(userId, cId, file, skillUrls, mcpServersConfig, permissionsConfig, hooksConfig, hookScripts, agentId, skillNames, updateSkillNames, skillUrlMap, service = null) {
  if (agentId != null && String(agentId).trim() !== "") {
    return createWorkspaceWithAgentStore({
      userId,
      cId,
      agentId,
      file,
      skillUrls,
      skillUrlMap,
      skillNames,
      updateSkillNames,
      mcpServersConfig,
      permissionsConfig,
      hooksConfig,
      hookScripts,
      service,
    });
  }

  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const normalizedSkillUrls = normalizeSkillUrls(skillUrls);
  const downloadedZipPaths = [];
  const extractRoots = [];
  const updatedSkillSet = new Set();

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }

  const workspaceRoot = resolveWorkspaceRoot(service);
  const userWorkspaceRoot = await ensureWorkspaceDir(service, userId, cId, logId);
  const tmpRoot = path.join(userWorkspaceRoot, ".tmp");
  const {
    skillsDir: targetSkillsDir,
    agentsDir: targetAgentsDir,
    agentTypes: normalizedAgentTypes,
  } =
    await ensurePrimaryAgentDirs(userWorkspaceRoot);

  // 始终：保证工作空间目录存在，并清空（删除）现有 skills 和 agents 目录
  if (!fs.existsSync(userWorkspaceRoot)) {
    await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
  }
  
  // 清除工作目录中的 skills 和 agents 目录
  // skills：若 skill 子目录含 .dynamic_add.lock 则保留
  const preservedSkillsTemp = path.join(
    tmpRoot,
    `preserved_skills_${Date.now()}_${Math.round(Math.random() * 1e6)}`
  );
  if (fs.existsSync(targetSkillsDir)) {
    const skillEntries = await fs.promises.readdir(targetSkillsDir, {
      withFileTypes: true,
    });
    const toPreserve = skillEntries.filter(
      (e) =>
        e.isDirectory() &&
        hasDynamicAddLock(path.join(targetSkillsDir, e.name))
    );
    if (toPreserve.length > 0) {
      await fs.promises.mkdir(preservedSkillsTemp, { recursive: true });
      for (const e of toPreserve) {
        const src = path.join(targetSkillsDir, e.name);
        const dest = path.join(preservedSkillsTemp, e.name);
        await moveDirectory(src, dest);
      }
      log(logId, "INFO", "保留含 .dynamic_add.lock 的 skill", {
        preserved: toPreserve.map((e) => e.name),
      });
    }
  }
  await removeDirIfExists(targetSkillsDir);
  await removeDirIfExists(targetAgentsDir);
  // 清空后立即重建空目录
  await fs.promises.mkdir(targetSkillsDir, { recursive: true });
  await fs.promises.mkdir(targetAgentsDir, { recursive: true });

  // 恢复保留的 skills
  if (fs.existsSync(preservedSkillsTemp)) {
    const preserved = await fs.promises.readdir(preservedSkillsTemp, {
      withFileTypes: true,
    });
    for (const e of preserved) {
      if (e.isDirectory()) {
        const src = path.join(preservedSkillsTemp, e.name);
        const dest = path.join(targetSkillsDir, e.name);
        await moveDirectory(src, dest);
      }
    }
    await removeDirIfExists(preservedSkillsTemp);
  }

  const skillsExistsAfter = fs.existsSync(targetSkillsDir);
  const agentsExistsAfter = fs.existsSync(targetAgentsDir);
  log(logId, "INFO", "Deleted old skills and agents directories completed", {
    userId,
    cId,
    targetSkillsDir,
    targetAgentsDir,
    agentTypes: normalizedAgentTypes,
    skillsExists: skillsExistsAfter,
    agentsExists: agentsExistsAfter,
  });

  // 写入 Claude Code / Codex / OpenCode 配置（解析失败时不误删旧配置）
  await writeAgentHookConfigs(
    userWorkspaceRoot,
    { mcpServersConfig, hooksConfig, permissionsConfig, hookScripts },
    logId
  );

  // 如果没有上传文件也没有 URL：不写入 skills 和 agents
  if (!file && normalizedSkillUrls.length === 0) {
    const syncResult = await syncAgents(userWorkspaceRoot, logId);
    log(logId, "INFO", "Created workspace (no uploaded file, no skills and agents)", {
      userId,
      cId,
      workspaceRoot,
      skillsDir: null,
      agentsDir: null,
      agentTypes: normalizedAgentTypes,
      syncAgentsElapsedMs: syncResult?.elapsedMs,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message: "Workspace created (no uploaded file, no skills and agents)",
      workspaceRoot,
    };
  }

  // 有上传文件时，要求是 zip
  if (file) {
    if (!file.path) {
      throw new ValidationError("Uploaded file has no valid path", { field: "file.path" });
    }

    const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
    if (ext !== ".zip") {
      throw new ValidationError("Only zip files are supported", {
        field: "file",
        originalName: file.originalname,
      });
    }
  }

  log(logId, "DEBUG", "Start processing workspace resources", {
    userId,
    cId,
    workspaceRoot,
    hasUploadedZip: !!file,
    skillUrlsCount: normalizedSkillUrls.length,
  });

  try {
    if (!fs.existsSync(tmpRoot)) {
      await fs.promises.mkdir(tmpRoot, { recursive: true });
    }
    const updatedDirs = [];

    // 处理上传 zip（支持 skills/agents）
    if (file) {
      const uploadExtractRoot = path.join(
        tmpRoot,
        `skill_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(uploadExtractRoot);
      await fs.promises.mkdir(uploadExtractRoot, { recursive: true });
      log(logId, "DEBUG", "Start extracting uploaded zip file", {
        extractRoot: uploadExtractRoot,
      });
      await extractZip(file.path, uploadExtractRoot);
      log(logId, "DEBUG", "Uploaded zip file extracted successfully", {
        extractRoot: uploadExtractRoot,
      });

      // 查找压缩包中的 skills 和 agents 目录
      const skillsDir = await findDir(uploadExtractRoot, "skills");
      const agentsDir = await findDir(uploadExtractRoot, "agents");

      // 如果压缩包中有 skills 目录，就写入（逐个 skill 移动）
      if (skillsDir) {
        await fs.promises.mkdir(targetSkillsDir, { recursive: true });
        const skillEntries = await fs.promises.readdir(skillsDir, {
          withFileTypes: true,
        });
        for (const e of skillEntries) {
          if (!e.isDirectory()) continue;
          const srcPath = path.join(skillsDir, e.name);
          const destPath = path.join(targetSkillsDir, e.name);
          if (fs.existsSync(destPath)) {
            await removeDirIfExists(destPath);
          }
          await moveDirectory(srcPath, destPath);
          updatedSkillSet.add(e.name);
        }
        updatedDirs.push("skills");
        log(logId, "INFO", "skills updated to workspace", {
          userId,
          cId,
          workspaceRoot,
          targetSkillsDir,
          agentTypes: normalizedAgentTypes,
        });
      } else {
        log(logId, "INFO", "skills directory not found in uploaded zip, skipping", {
          userId,
          cId,
          extractRoot: uploadExtractRoot,
        });
      }

      // 如果压缩包中有 agents 目录，就写入
      // Windows：目标路径若已存在目录（此前 mkdir 建过空目录），rename 会 EPERM，须先删除
      if (agentsDir) {
        await removeDirIfExists(targetAgentsDir);
        await moveDirectory(agentsDir, targetAgentsDir);
        updatedDirs.push("agents");
        log(logId, "INFO", "agents updated to workspace", {
          userId,
          cId,
          workspaceRoot,
          targetAgentsDir,
          agentTypes: normalizedAgentTypes,
        });
      } else {
        log(logId, "INFO", "agents directory not found in uploaded zip, skipping", {
          userId,
          cId,
          extractRoot: uploadExtractRoot,
        });
      }
    }

    // 处理 skillUrls（每个 zip 解压后直接是 skillName 目录）
    for (let i = 0; i < normalizedSkillUrls.length; i += 1) {
      const skillUrl = normalizedSkillUrls[i];
      const downloadedZipPath = path.join(
        tmpRoot,
        `skill_url_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}.zip`
      );
      downloadedZipPaths.push(downloadedZipPath);
      const urlExtractRoot = path.join(
        tmpRoot,
        `skill_url_extract_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(urlExtractRoot);
      await fs.promises.mkdir(urlExtractRoot, { recursive: true });

      log(logId, "INFO", "Start download skill zip from url", {
        userId,
        cId,
        skillUrl,
      });
      await downloadUrlToFile(skillUrl, downloadedZipPath, logId);
      log(logId, "INFO", "Skill zip downloaded, start extracting", {
        userId,
        cId,
        skillUrl,
        downloadedZipPath,
      });
      await extractZip(downloadedZipPath, urlExtractRoot);

      const extractedEntries = await fs.promises.readdir(urlExtractRoot, {
        withFileTypes: true,
      });
      const rootDirs = extractedEntries.filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith(".")
      );

      const skillsRootDir = rootDirs.find((entry) => entry.name === "skills");
      const candidateSkillDirs = skillsRootDir
        ? (await fs.promises.readdir(path.join(urlExtractRoot, "skills"), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => ({
              name: entry.name,
              sourcePath: path.join(urlExtractRoot, "skills", entry.name),
            }))
        : rootDirs.map((entry) => ({
            name: entry.name,
            sourcePath: path.join(urlExtractRoot, entry.name),
          }));

      if (candidateSkillDirs.length === 0) {
        log(logId, "WARN", "No skill directory found after extracting skill url zip", {
          userId,
          cId,
          skillUrl,
          extractRoot: urlExtractRoot,
        });
        continue;
      }

      await fs.promises.mkdir(targetSkillsDir, { recursive: true });
      for (const skillDir of candidateSkillDirs) {
        const destSkillPath = path.join(targetSkillsDir, skillDir.name);
        if (fs.existsSync(destSkillPath)) {
          await removeDirIfExists(destSkillPath);
        }
        await moveDirectory(skillDir.sourcePath, destSkillPath);
        updatedSkillSet.add(skillDir.name);

        log(logId, "INFO", "Skill from url updated to workspace", {
          userId,
          cId,
          skillUrl,
          skillName: skillDir.name,
          destSkillPath,
        });
      }

      if (!updatedDirs.includes("skills")) {
        updatedDirs.push("skills");
      }
    }

    // 如果上传 zip 和 URL 技能都没找到有效目录，记录警告但不中断流程
    if (updatedDirs.length === 0) {
      log(logId, "WARN", "No valid skills or agents directories found", {
        userId,
        cId,
        hasUploadedZip: !!file,
        skillUrlsCount: normalizedSkillUrls.length,
      });
    }

    const updatedSkills = Array.from(updatedSkillSet);
    const message =
      updatedDirs.length > 0
        ? `Workspace created successfully, ${updatedDirs.join(" and ")} updated`
        : "Workspace created successfully (skills and agents directories not found)";

    const prepareElapsedMs = Date.now() - startTime;
    log(logId, "INFO", "Workspace resources prepared", {
      userId,
      cId,
      updatedDirs,
      updatedSkills,
      agentTypes: normalizedAgentTypes,
      prepareElapsedMs,
    });

    const syncResult = await syncAgents(userWorkspaceRoot, logId);

    log(logId, "INFO", message, {
      userId,
      cId,
      updatedDirs,
      updatedSkills,
      agentTypes: normalizedAgentTypes,
      prepareElapsedMs,
      syncAgentsElapsedMs: syncResult?.elapsedMs,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message,
      workspaceRoot,
      updatedSkills,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to process workspace resources", {
      userId,
      cId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`Failed to create workspace: ${error.message}`, {
      userId,
      cId,
    });
  } finally {
    const cleanupStartedAt = Date.now();
    // 清理临时目录和临时 zip 文件
    try {
      for (const extractRoot of extractRoots) {
        if (fs.existsSync(extractRoot)) {
          await fs.promises.rm(extractRoot, { recursive: true, force: true });
        }
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up temporary extracted zip", {
        error: e.message,
      });
    }
    // 清理下载的 zip 文件
    for (const downloadedZipPath of downloadedZipPaths) {
      try {
        if (fs.existsSync(downloadedZipPath)) {
          await fs.promises.unlink(downloadedZipPath);
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up downloaded skill zip file", {
          downloadedZipPath,
          error: e.message,
        });
      }
    }
    // 清理上传的 zip 文件
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up uploaded zip file", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
    log(logId, "INFO", "Workspace temp cleanup completed", {
      userId,
      cId,
      elapsedMs: Date.now() - cleanupStartedAt,
      totalElapsedMs: Date.now() - startTime,
    });
  }
}

/**
 * 动态技能写入智能体实体目录（打 .dynamic_add.lock），并确保会话工作区软链
 */
async function pushSkillsToAgentStore(userId, cId, agentId, file, skillUrls, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const normalizedSkillUrls = normalizeSkillUrls(skillUrls);
  const downloadedZipPaths = [];
  const extractRoots = [];
  const updatedSkillSet = new Set();
  let lockPath = null;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!agentId) {
    throw new ValidationError("agentId cannot be empty", { field: "agentId" });
  }
  if (!file && normalizedSkillUrls.length === 0) {
    throw new ValidationError("file or skillUrls cannot both be empty", {
      field: "file|skillUrls",
    });
  }

  const workspaceRoot = resolveWorkspaceRoot(service);
  const userWorkspaceRoot = await ensureWorkspaceDir(service, userId, cId, logId);
  const tmpRoot = path.join(userWorkspaceRoot, ".tmp");
  await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
  await fs.promises.mkdir(tmpRoot, { recursive: true });

  const { agentStorePath, skillsDir: agentSkillsDir, agentsDir: agentAgentsDir } =
    await ensureAgentStoreDirs(userId, agentId, logId, service);

  try {
    let lock = await tryAcquireAgentStoreLock(agentStorePath, logId);
    if (!lock.acquired) {
      // 动态添加技能不能静默跳过，短暂重试后仍失败则抛错让上游重试
      for (let attempt = 1; attempt <= 5 && !lock.acquired; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        lock = await tryAcquireAgentStoreLock(agentStorePath, logId);
      }
    }
    if (!lock.acquired) {
      throw new SystemError("Agent store is busy, please retry", {
        userId,
        cId,
        agentId,
      });
    }
    lockPath = lock.lockPath;

    if (file) {
        if (!file.path) {
          throw new ValidationError("Uploaded file has no valid path", { field: "file.path" });
        }
        const uploadExtractRoot = path.join(
          tmpRoot,
          `push_skill_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
        );
        extractRoots.push(uploadExtractRoot);
        await fs.promises.mkdir(uploadExtractRoot, { recursive: true });
        await extractZip(file.path, uploadExtractRoot);
        const candidateSkillDirs = await collectSkillDirsFromExtractRoot(uploadExtractRoot);
        // 若 zip 结构是标准 skills/ 目录，优先走 findDir
        const skillsDir = await findDir(uploadExtractRoot, "skills");
        const dirs = skillsDir
          ? (await fs.promises.readdir(skillsDir, { withFileTypes: true }))
              .filter((e) => e.isDirectory())
              .map((e) => ({ name: e.name, sourcePath: path.join(skillsDir, e.name) }))
          : candidateSkillDirs;
        await mapPool(dirs, SKILL_INSTALL_CONCURRENCY, async (skillDir) => {
          await installSkillDir(skillDir.sourcePath, agentSkillsDir, skillDir.name, {
            asDynamic: true,
          });
          updatedSkillSet.add(skillDir.name);
        });
    }

    await mapPool(normalizedSkillUrls, SKILL_INSTALL_CONCURRENCY, async (skillUrl, i) => {
      const downloadedZipPath = path.join(
        tmpRoot,
        `push_skill_url_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}.zip`
      );
      downloadedZipPaths.push(downloadedZipPath);
      const urlExtractRoot = path.join(
        tmpRoot,
        `push_skill_url_extract_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(urlExtractRoot);
      await fs.promises.mkdir(urlExtractRoot, { recursive: true });
      await downloadUrlToFile(skillUrl, downloadedZipPath, logId);
      await extractZip(downloadedZipPath, urlExtractRoot);
      const candidateSkillDirs = await collectSkillDirsFromExtractRoot(urlExtractRoot);
      for (const skillDir of candidateSkillDirs) {
        await installSkillDir(skillDir.sourcePath, agentSkillsDir, skillDir.name, {
          asDynamic: true,
        });
        updatedSkillSet.add(skillDir.name);
      }
    });

    const linkResult = await linkWorkspaceToAgentStore(
      userWorkspaceRoot,
      agentSkillsDir,
      agentAgentsDir,
      logId
    );

    const updatedSkills = Array.from(updatedSkillSet);
    const message =
      updatedSkills.length > 0
        ? `Pushed ${updatedSkills.length} skills to agent store: ${updatedSkills.join(", ")}`
        : "No valid skill directories found in file or skillUrls";

    log(logId, "INFO", message, {
      userId,
      cId,
      agentId,
      updatedSkills,
      linkElapsedMs: linkResult?.elapsedMs,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message,
      workspaceRoot,
      agentStorePath,
      updatedSkills,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to push skills to agent store", {
      userId,
      cId,
      agentId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });
    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }
    throw new SystemError(`Failed to push skill to workspace: ${error.message}`, {
      userId,
      cId,
      agentId,
    });
  } finally {
    await releaseAgentStoreLock(lockPath, logId);
    for (const extractRoot of extractRoots) {
      try {
        if (fs.existsSync(extractRoot)) {
          await fs.promises.rm(extractRoot, { recursive: true, force: true });
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up temporary extracted zip", { error: e.message });
      }
    }
    for (const downloadedZipPath of downloadedZipPaths) {
      try {
        if (fs.existsSync(downloadedZipPath)) {
          await fs.promises.unlink(downloadedZipPath);
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up downloaded skill zip file", {
          downloadedZipPath,
          error: e.message,
        });
      }
    }
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up uploaded zip file", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
  }
}

/**
 * 推送技能到工作空间
 * file 为 zip 压缩包，其中应包含 skills 目录，skills 目录下为具体 skill 子目录
 * skillUrls 为技能 zip 下载地址数组，解压后可为 skills/<skillName> 或直接 <skillName>
 * 如有同名 skill 则覆盖，否则新增；不处理 agents 目录
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object|null} file multer 文件对象（zip）
 * @param {string[]|string|undefined} skillUrls 技能 zip 下载地址数组
 * @param {string|number|undefined} agentId 有则可能走实体存储；须同时满足会话已是软链
 */
async function pushSkillsToWorkspace(userId, cId, file, skillUrls, agentId, service = null) {
  const hasAgentId = agentId != null && String(agentId).trim() !== "";
  if (hasAgentId) {
    // 仅做软链探测，不创建目录；general 且根目录未配置时保持原行为返回 null
    let userWorkspaceRoot = null;
    if (service?.isUserApp) {
      userWorkspaceRoot = resolveWorkspaceDir(service, userId, cId);
    } else if (config.COMPUTER_WORKSPACE_DIR) {
      userWorkspaceRoot = path.join(
        config.COMPUTER_WORKSPACE_DIR,
        String(userId),
        String(cId)
      );
    }
    if (isWorkspaceSkillsSymlinked(userWorkspaceRoot)) {
      return pushSkillsToAgentStore(userId, cId, agentId, file, skillUrls, service);
    }
    log(`computer:${userId}:${cId}`, "INFO", "Push skills: agentId present but workspace not symlinked, use legacy path", {
      userId,
      cId,
      agentId,
      userWorkspaceRoot,
    });
  }

  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;
  const normalizedSkillUrls = normalizeSkillUrls(skillUrls);
  const downloadedZipPaths = [];
  const extractRoots = [];

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!file && normalizedSkillUrls.length === 0) {
    throw new ValidationError("file or skillUrls cannot both be empty", {
      field: "file|skillUrls",
    });
  }

  if (file) {
    if (!file.path) {
      throw new ValidationError("Uploaded file has no valid path", { field: "file.path" });
    }
    const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
    if (ext !== ".zip") {
      throw new ValidationError("Only zip files are supported", {
        field: "file",
        originalName: file?.originalname,
      });
    }
  }

  const workspaceRoot = resolveWorkspaceRoot(service);
  const userWorkspaceRoot = await ensureWorkspaceDir(service, userId, cId, logId);
  const tmpRoot = path.join(userWorkspaceRoot, ".tmp");
  const { skillsDir: targetSkillsDir, agentTypes: normalizedAgentTypes } =
    await ensurePrimaryAgentDirs(userWorkspaceRoot);

  try {
    if (!fs.existsSync(userWorkspaceRoot)) {
      await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
    }
    if (!fs.existsSync(targetSkillsDir)) {
      await fs.promises.mkdir(targetSkillsDir, { recursive: true });
    }
    if (!fs.existsSync(tmpRoot)) {
      await fs.promises.mkdir(tmpRoot, { recursive: true });
    }

    const updatedSkills = [];
    const updatedSkillSet = new Set();

    // 处理上传 zip：要求 zip 中包含 skills 目录
    if (file) {
      const extractRoot = path.join(
        tmpRoot,
        `skill_push_${Date.now()}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(extractRoot);
      await fs.promises.mkdir(extractRoot, { recursive: true });
      log(logId, "DEBUG", "Start extracting skill zip file", { extractRoot });
      await extractZip(file.path, extractRoot);
      log(logId, "DEBUG", "Skill zip file extracted successfully", { extractRoot });

      const skillsDir = await findDir(extractRoot, "skills");
      if (!skillsDir) {
        log(logId, "WARN", "skills directory not found in uploaded zip", {
          userId,
          cId,
          extractRoot,
        });
      } else {
        const skillEntries = await fs.promises.readdir(skillsDir, {
          withFileTypes: true,
        });
        const skillDirs = skillEntries.filter(
          (e) => e.isDirectory() && !e.name.startsWith(".")
        );

        if (skillDirs.length === 0) {
          log(logId, "WARN", "skills directory in uploaded zip has no skill subdirectories", {
            userId,
            cId,
            skillsDir,
          });
        } else {
          for (const skillDir of skillDirs) {
            const srcSkillPath = path.join(skillsDir, skillDir.name);
            const destSkillPath = path.join(targetSkillsDir, skillDir.name);
            if (fs.existsSync(destSkillPath)) {
              await removeDirIfExists(destSkillPath);
            }
            await moveDirectory(srcSkillPath, destSkillPath);
            updatedSkillSet.add(skillDir.name);

            log(logId, "INFO", "skill pushed to workspace from uploaded zip", {
              userId,
              cId,
              skillName: skillDir.name,
              destSkillPath,
            });
          }
        }
      }
    }

    // 处理 skillUrls：解压后可为 skills/<skillName> 或直接 <skillName>
    for (let i = 0; i < normalizedSkillUrls.length; i += 1) {
      const skillUrl = normalizedSkillUrls[i];
      const downloadedZipPath = path.join(
        tmpRoot,
        `skill_push_url_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}.zip`
      );
      downloadedZipPaths.push(downloadedZipPath);
      const urlExtractRoot = path.join(
        tmpRoot,
        `skill_push_url_extract_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(urlExtractRoot);
      await fs.promises.mkdir(urlExtractRoot, { recursive: true });

      log(logId, "INFO", "Start download skill zip for push from url", {
        userId,
        cId,
        skillUrl,
      });
      await downloadUrlToFile(skillUrl, downloadedZipPath, logId);
      await extractZip(downloadedZipPath, urlExtractRoot);

      const extractedEntries = await fs.promises.readdir(urlExtractRoot, {
        withFileTypes: true,
      });
      const rootDirs = extractedEntries.filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith(".")
      );
      const skillsRootDir = rootDirs.find((entry) => entry.name === "skills");
      const candidateSkillDirs = skillsRootDir
        ? (await fs.promises.readdir(path.join(urlExtractRoot, "skills"), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => ({
              name: entry.name,
              sourcePath: path.join(urlExtractRoot, "skills", entry.name),
            }))
        : rootDirs.map((entry) => ({
            name: entry.name,
            sourcePath: path.join(urlExtractRoot, entry.name),
          }));

      if (candidateSkillDirs.length === 0) {
        log(logId, "WARN", "No skill directory found after extracting push skill url zip", {
          userId,
          cId,
          skillUrl,
          extractRoot: urlExtractRoot,
        });
        continue;
      }

      for (const skillDir of candidateSkillDirs) {
        const destSkillPath = path.join(targetSkillsDir, skillDir.name);
        if (fs.existsSync(destSkillPath)) {
          await removeDirIfExists(destSkillPath);
        }
        await moveDirectory(skillDir.sourcePath, destSkillPath);
        updatedSkillSet.add(skillDir.name);

        log(logId, "INFO", "skill pushed to workspace from url zip", {
          userId,
          cId,
          skillUrl,
          skillName: skillDir.name,
          destSkillPath,
        });
      }
    }

    for (const skillName of updatedSkillSet) {
      updatedSkills.push(skillName);
    }

    const message =
      updatedSkills.length > 0
        ? `Pushed ${updatedSkills.length} skills: ${updatedSkills.join(", ")}`
        : "No valid skill directories found in file or skillUrls";

    const prepareElapsedMs = Date.now() - startTime;
    log(logId, "INFO", "Push skills resources prepared", {
      userId,
      cId,
      updatedSkills,
      agentTypes: normalizedAgentTypes,
      prepareElapsedMs,
    });

    const syncResult = await syncAgents(userWorkspaceRoot, logId);

    log(logId, "INFO", message, {
      userId,
      cId,
      updatedSkills,
      agentTypes: normalizedAgentTypes,
      prepareElapsedMs,
      syncAgentsElapsedMs: syncResult?.elapsedMs,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message,
      workspaceRoot,
      updatedSkills,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to push skill to workspace", {
      userId,
      cId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`Failed to push skill to workspace: ${error.message}`, {
      userId,
      cId,
    });
  } finally {
    const cleanupStartedAt = Date.now();
    try {
      for (const extractRoot of extractRoots) {
        if (fs.existsSync(extractRoot)) {
          await fs.promises.rm(extractRoot, { recursive: true, force: true });
        }
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up temporary extracted zip", {
        error: e.message,
      });
    }
    for (const downloadedZipPath of downloadedZipPaths) {
      try {
        if (fs.existsSync(downloadedZipPath)) {
          await fs.promises.unlink(downloadedZipPath);
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean up downloaded skill zip file", {
          downloadedZipPath,
          error: e.message,
        });
      }
    }
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up uploaded zip file", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
    log(logId, "INFO", "Push skills temp cleanup completed", {
      userId,
      cId,
      elapsedMs: Date.now() - cleanupStartedAt,
      totalElapsedMs: Date.now() - startTime,
    });
  }
}

/**
 * 初始化项目模板
 * 将模板 zip 解压到工作空间目录，并执行 git init + commit
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object|null} file multer 文件对象（zip）
 * @param {string|boolean|undefined} enableGit 是否开启 git 版本管理
 */
async function initProjectTemplate(userId, cId, file, enableGit, service = null) {
  const startTime = Date.now();
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!file || !file.path) {
    throw new ValidationError("file is required", { field: "file" });
  }

  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  if (ext !== ".zip") {
    throw new ValidationError("Only zip files are supported", {
      field: "file",
      originalName: file.originalname,
    });
  }

  const targetDir = await ensureWorkspaceDir(service, userId, cId, logId);
  const tmpRoot = path.join(targetDir, ".tmp");
  const extractRoot = path.join(
    tmpRoot,
    `template_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
  );

  try {
    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }
    if (!fs.existsSync(tmpRoot)) {
      await fs.promises.mkdir(tmpRoot, { recursive: true });
    }
    await fs.promises.mkdir(extractRoot, { recursive: true });

    // 解压 zip 到临时目录
    log(logId, "DEBUG", "Start extracting template zip file", { extractRoot });
    await extractZip(file.path, extractRoot);
    log(logId, "DEBUG", "Template zip file extracted successfully", { extractRoot });

    // 将解压后的内容直接移动到目标目录（保留 zip 的顶层目录结构）
    const items = await fs.promises.readdir(extractRoot, { withFileTypes: true });
    for (const item of items) {
      const srcPath = path.join(extractRoot, item.name);
      const destPath = path.join(targetDir, item.name);
      if (item.isDirectory()) {
        await moveDirectory(srcPath, destPath);
      } else {
        // 确保目标目录存在
        const destParent = path.dirname(destPath);
        if (!fs.existsSync(destParent)) {
          await fs.promises.mkdir(destParent, { recursive: true });
        }
        await fs.promises.copyFile(srcPath, destPath);
      }
    }

    log(logId, "INFO", "Template files extracted to workspace", {
      userId,
      cId,
      targetDir,
      fileCount: items.length,
    });

    // git init + commit（仅当 enableGit 为 true 时执行）
    if (config.GIT_ENABLED && (enableGit === "true" || enableGit === true)) {
      const gitService = await import("../../service/gitService.js");
      await gitService.default.init({ workspaceType: "taskAgent", userId, cId });
      await gitService.default.commit({ workspaceType: "taskAgent", userId, cId, message: "Initial commit" });
      log(logId, "INFO", "Git init and initial commit done", { userId, cId });
    }

    log(logId, "INFO", "Init project template completed", {
      userId,
      cId,
      targetDir,
      elapsedMs: Date.now() - startTime,
    });

    return {
      message: "Project template initialized successfully",
      workspaceRoot: targetDir,
    };
  } catch (error) {
    log(logId, "ERROR", "Failed to init project template", {
      userId,
      cId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`Failed to init project template: ${error.message}`, {
      userId,
      cId,
    });
  } finally {
    // 清理临时解压目录
    try {
      if (fs.existsSync(extractRoot)) {
        await fs.promises.rm(extractRoot, { recursive: true, force: true });
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up temporary extracted zip", {
        error: e.message,
      });
    }
    // 清理上传的 zip 文件
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean up uploaded zip file", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
  }
}

/**
 * 在沙箱工作空间中执行命令
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {string} command 要执行的命令
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function executeCommand(userId, cId, command, service = null) {
  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!command || typeof command !== "string" || !command.trim()) {
    throw new ValidationError("command cannot be empty", { field: "command" });
  }

  const workDir = await ensureWorkspaceDir(service, userId, cId, "computer");

  if (!fs.existsSync(workDir)) {
    throw new ValidationError("workspace directory does not exist", {
      field: "workDir",
      workDir,
    });
  }

  const logId = `computer:${userId}:${cId}`;
  log(logId, "INFO", "Execute command in workspace", {
    userId,
    cId,
    workDir,
    command,
  });

  const timeoutMs = 10 * 60 * 1000; // 10 minutes

  const execOptions = { cwd: workDir, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 };
  if (config.BASH_PATH) {
    execOptions.shell = config.BASH_PATH;
  }

  return new Promise((resolve, reject) => {
    exec(
      command,
      execOptions,
      (error, stdout, stderr) => {
        const exitCode = error ? (error.killed ? -1 : (error.code || 1)) : 0;
        const resolvedStderr = error && error.killed
          ? (stderr || "") + `\nCommand timed out after ${timeoutMs / 1000}s`
          : stderr || "";
        log(logId, "INFO", "Execute command completed", {
          userId,
          cId,
          exitCode,
          killed: error ? error.killed : false,
          stdoutLength: stdout ? stdout.length : 0,
          stderrLength: resolvedStderr.length,
        });
        resolve({ stdout: stdout || "", stderr: resolvedStderr, exitCode });
      }
    );
  });
}

/**
 * 打包工作空间文件为 zip
 * 参照 downloadAllFiles 的 archiver 模式，用 archive.directory 过滤排除目录
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {string[]|null} excludeDirs 排除目录列表，为 null 时使用默认列表
 * @returns {Promise<{ archive: import("archiver").Archiver, zipFileName: string }>}
 */
async function zipWorkspace(userId, cId, excludeDirs, service = null) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }

  const targetDir = await ensureWorkspaceDir(service, userId, cId, logId);

  if (!fs.existsSync(targetDir)) {
    throw new ValidationError("workspace directory does not exist", {
      field: "workDir",
      workDir: targetDir,
    });
  }

  // env 中配置的是必须排除的路径片段，调用方传入的 excludeDirs 作为补充
  const mandatoryExclude = config.ZIP_WORKSPACE_EXCLUDE || [];
  const extraExcludeDirs = Array.isArray(excludeDirs) ? excludeDirs : [];
  const excludeSet = new Set([...mandatoryExclude, ...extraExcludeDirs]);

  const zipFileName = `${userId}_${cId}.zip`;
  const startTime = Date.now();

  log(logId, "INFO", "Zip workspace request", {
    userId, cId, targetDir, excludeDirs: [...excludeSet],
  });

  const archive = archiver("zip", { zlib: { level: 9 } });

  // false 表示不添加顶层目录前缀，条目直接相对于 targetDir
  archive.directory(targetDir, false, (entry) => {
    const name = entry.name || "";
    const segments = name.split(/[\/\\]/).filter(Boolean);

    // 任一路径片段在排除列表中则跳过
    if (segments.some((seg) => excludeSet.has(seg))) {
      return false;
    }

    // 跳过符号链接
    try {
      const fullPath = path.join(targetDir, name);
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }

    return entry;
  });

  archive.on("warning", (err) => {
    if (err.code === "ENOENT") {
      log(logId, "WARN", "Encountered file problem when creating zip", {
        message: err.message, code: err.code,
      });
    } else {
      log(logId, "ERROR", "Encountered warning when creating zip", {
        message: err.message, code: err.code,
      });
    }
  });

  archive.on("error", (err) => {
    log(logId, "ERROR", "Failed to create zip", {
      message: err.message, elapsedMs: Date.now() - startTime,
    });
  });

  archive.on("end", () => {
    log(logId, "INFO", "Workspace zip created successfully", {
      targetDir, zipFileName, elapsedMs: Date.now() - startTime,
    });
  });

  return { archive, zipFileName };
}

/** 查找 package-platforms.mjs 时跳过的目录：复用 env 配置 + 构建产物目录 */
const PACKAGE_SEARCH_SKIP_DIRS = new Set([
  ...(config.ZIP_WORKSPACE_EXCLUDE || []),
  "dist-packages",
]);

/**
 * 递归查找 scripts/package-platforms.mjs，返回所在的项目目录
 * @param {string} rootDir 搜索根目录
 * @returns {string|null} projectDir 或 null
 */
function findPackageScript(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  // 检查当前目录是否包含 scripts/package-platforms.mjs
  const scriptPath = path.join(rootDir, "scripts", "package-platforms.mjs");
  if (fs.existsSync(scriptPath)) {
    return rootDir;
  }

  // 递归搜索子目录
  for (const entry of entries) {
    if (entry.isDirectory() && !PACKAGE_SEARCH_SKIP_DIRS.has(entry.name)) {
      const result = findPackageScript(path.join(rootDir, entry.name));
      if (result) return result;
    }
  }
  return null;
}

/**
 * 用 cross-spawn 执行命令，返回 stdout/stderr/exitCode
 * @param {string} command
 * @param {string[]} args
 * @param {object} options spawn options
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runSpawn(command, args, options, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: stderr + `\nFailed to spawn ${command}: ${err.message}`,
        exitCode: 1,
      });
    });

    child.on("close", (code, signal) => {
      if (code === null && signal) {
        resolve({
          stdout,
          stderr: stderr + `\nProcess killed by signal ${signal} (timeout after ${timeoutMs / 1000}s)`,
          exitCode: -1,
        });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
  });
}

/**
 * 从产物文件名中提取平台标识
 * 文件名格式: agent-{id}-{platform}-{version}.{ext}
 * @param {string} fileName
 * @returns {string|null}
 */
function extractPlatformFromFileName(fileName) {
  if (!fileName) return null;
  let name = fileName;
  if (name.endsWith(".tar.gz")) name = name.slice(0, -".tar.gz".length);
  else if (name.endsWith(".tar.bz2")) name = name.slice(0, -".tar.bz2".length);
  else if (name.endsWith(".tgz")) name = name.slice(0, -".tgz".length);
  else if (name.endsWith(".zip")) name = name.slice(0, -".zip".length);

  const parts = name.split("-");
  if (parts.length < 4) return null;

  // 从末尾查找版本号（匹配 x.y.z 格式）
  let versionIdx = -1;
  for (let i = parts.length - 1; i >= 2; i--) {
    if (/^\d+\.\d+\.\d+$/.test(parts[i])) {
      versionIdx = i;
      break;
    }
  }
  if (versionIdx < 3) return null;

  // platform 是 parts[2] 到 parts[versionIdx-1] 的拼接
  return parts.slice(2, versionIdx).join("-");
}

/**
 * 在沙箱工作空间中构建 agent 打包产物
 * 用纯 Node.js 替代 find + pnpm install + node build 的 shell 命令链
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {string|number} agentId
 * @param {string} version
 * @returns {Promise<{ artifacts: Array<{path: string, fileName: string, platform: string}> }>}
 */
async function buildAgentPackage(userId, cId, agentId, version, service = null) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!agentId) {
    throw new ValidationError("agentId cannot be empty", { field: "agentId" });
  }
  if (!version) {
    throw new ValidationError("version cannot be empty", { field: "version" });
  }

  const workspaceDir = await ensureWorkspaceDir(service, userId, cId, logId);

  if (!fs.existsSync(workspaceDir)) {
    throw new ValidationError("workspace directory does not exist", {
      field: "workDir",
      workDir: workspaceDir,
    });
  }

  log(logId, "INFO", "Build agent package request", { userId, cId, agentId, version });

  // 1. 查找 scripts/package-platforms.mjs
  const projectDir = findPackageScript(workspaceDir);
  if (!projectDir) {
    throw new ValidationError("package-platforms.mjs not found in workspace", {
      field: "script",
    });
  }
  log(logId, "INFO", "Found package script", { projectDir });

  // 2. pnpm install（需包含 devDependencies，esbuild/typescript 等在 devDependencies 中）
  const installResult = await runPnpmInstall(projectDir, logId);
  log(logId, "INFO", "pnpm install completed", {
    exitCode: installResult.exitCode,
    stderrLength: installResult.stderr.length,
  });

  if (installResult.exitCode !== 0) {
    log(logId, "ERROR", "pnpm install failed", { stderr: installResult.stderr });
    throw new SystemError(`pnpm install failed: ${installResult.stderr}`);
  }

  // 3. 构建
  const distPackagesDir = path.join(projectDir, "dist-packages");
  const buildArgs = [
    "scripts/package-platforms.mjs",
    `agent-${agentId}`,
    version,
    distPackagesDir,
    "--print-artifacts",
  ];

  const buildResult = await runSpawn("node", buildArgs, {
    cwd: projectDir, env: buildInstallEnv(),
  });
  log(logId, "INFO", "Build completed", {
    exitCode: buildResult.exitCode,
    stdoutLength: buildResult.stdout.length,
  });

  if (buildResult.exitCode !== 0) {
    log(logId, "ERROR", "Build failed", { stderr: buildResult.stderr });
    throw new SystemError(`Build failed: ${buildResult.stderr}`);
  }

  // 4. 解析产物
  const artifactExtensions = [".tar.gz", ".tar.bz2", ".zip", ".tgz"];
  const artifacts = [];
  const lines = buildResult.stdout.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const lowerLine = trimmedLine.toLowerCase();
    if (!artifactExtensions.some((ext) => lowerLine.endsWith(ext))) {
      continue;
    }

    // 转为 workspace 相对路径（统一用正斜杠，便于跨平台下载）
    const absArtifactPath = path.resolve(projectDir, trimmedLine);
    let relativePath = path.relative(workspaceDir, absArtifactPath);
    relativePath = relativePath.split(path.sep).join("/");

    const fileName = path.basename(trimmedLine);
    const platform = extractPlatformFromFileName(fileName);

    artifacts.push({ path: relativePath, fileName, platform: platform || "" });
  }

  log(logId, "INFO", "Build agent package completed", {
    artifactsCount: artifacts.length, artifacts,
  });

  return { artifacts };
}

/**
 * 清理沙箱工作空间中的构建产物
 * 用 Node.js fs 替代 find + rm -rf dist-packages
 * @param {string|number} userId
 * @param {string|number} cId
 * @returns {Promise<{ cleaned: boolean }>}
 */
async function cleanupBuildArtifacts(userId, cId, service = null) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }

  const workspaceDir = await ensureWorkspaceDir(service, userId, cId, logId);

  if (!fs.existsSync(workspaceDir)) {
    log(logId, "WARN", "Workspace not found, skip cleanup", { userId, cId });
    return { cleaned: false };
  }

  const projectDir = findPackageScript(workspaceDir);
  if (!projectDir) {
    log(logId, "WARN", "package-platforms.mjs not found, skip cleanup", { userId, cId });
    return { cleaned: false };
  }

  const distPackagesDir = path.join(projectDir, "dist-packages");
  if (fs.existsSync(distPackagesDir)) {
    fs.rmSync(distPackagesDir, { recursive: true, force: true });
    log(logId, "INFO", "Cleaned dist-packages", { distPackagesDir });
    return { cleaned: true };
  }

  log(logId, "INFO", "dist-packages not found, nothing to clean", { distPackagesDir });
  return { cleaned: false };
}

/**
 * 删除工作空间目录
 * 删除 $COMPUTER_WORKSPACE_DIR/userId/cId/ 整个目录
 */
async function deleteWorkspace(userId, cId, service = null) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }

  const targetDir = await ensureWorkspaceDir(service, userId, cId, logId);

  if (fs.existsSync(targetDir)) {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    log(logId, "INFO", "Workspace deleted", { userId, cId, targetDir });
  } else {
    log(logId, "WARN", "Workspace not found, skip delete", { userId, cId, targetDir });
  }

  return { deleted: true };
}

/**
 * 递归查找包含 package.json 的项目目录
 * @param {string} rootDir
 * @returns {string|null}
 */
function findNodeProjectDir(rootDir) {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    return rootDir;
  }

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (
      entry.isDirectory()
      && !PACKAGE_SEARCH_SKIP_DIRS.has(entry.name)
      && entry.name !== "node_modules"
    ) {
      const result = findNodeProjectDir(path.join(rootDir, entry.name));
      if (result) return result;
    }
  }
  return null;
}

/** pnpm 构建脚本互斥配置项（不能同时存在 never/only 两类） */
const PNPM_BUILT_DEPS_PACKAGE_JSON_KEYS = [
  "neverBuiltDependencies",
  "onlyBuiltDependencies",
  "ignoredBuiltDependencies",
];

/** 继承环境变量中可能引入冲突的 pnpm 构建脚本配置 */
const PNPM_BUILT_DEPS_ENV_KEYS = [
  "NPM_CONFIG_NEVER_BUILT_DEPENDENCIES",
  "npm_config_never_built_dependencies",
  "NPM_CONFIG_ONLY_BUILT_DEPENDENCIES",
  "npm_config_only_built_dependencies",
  "NPM_CONFIG_IGNORED_BUILT_DEPENDENCIES",
  "npm_config_ignored_built_dependencies",
];

/**
 * 从 package.json 的 pnpm 字段移除互斥的构建脚本配置
 * @param {string} projectDir
 * @param {string} logId
 */
async function sanitizePackageJsonBuiltDepsConfig(projectDir, logId) {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const raw = await fs.promises.readFile(packageJsonPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    log(logId, "WARN", "Skip sanitizing package.json: invalid JSON", { projectDir });
    return;
  }

  if (!pkg.pnpm || typeof pkg.pnpm !== "object") {
    return;
  }

  const removedKeys = PNPM_BUILT_DEPS_PACKAGE_JSON_KEYS.filter((key) => key in pkg.pnpm);
  if (removedKeys.length === 0) {
    return;
  }

  for (const key of removedKeys) {
    delete pkg.pnpm[key];
  }
  if (Object.keys(pkg.pnpm).length === 0) {
    delete pkg.pnpm;
  }

  await fs.promises.writeFile(
    packageJsonPath,
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8"
  );
  log(logId, "INFO", "Removed conflicting pnpm built dependency settings from package.json", {
    projectDir,
    removedKeys,
  });
}

/**
 * 从 pnpm-workspace.yaml 移除互斥的构建脚本配置
 * @param {string} projectDir
 * @param {string} logId
 */
async function sanitizePnpmWorkspaceBuiltDepsConfig(projectDir, logId) {
  const workspaceYamlPath = path.join(projectDir, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceYamlPath)) {
    return;
  }

  const content = await fs.promises.readFile(workspaceYamlPath, "utf8");
  const lines = content.split("\n");
  const result = [];
  let skipUntilIndent = -1;
  let removedKeys = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const matchedKey = PNPM_BUILT_DEPS_PACKAGE_JSON_KEYS.find((key) =>
      new RegExp(`^${key}:\\s*(.*)$`).test(trimmed)
    );

    if (matchedKey) {
      removedKeys.push(matchedKey);
      const inlineValue = trimmed.slice(matchedKey.length + 1).trim();
      if (!inlineValue || inlineValue === "|" || inlineValue === ">") {
        skipUntilIndent = indent;
      }
      continue;
    }

    if (skipUntilIndent >= 0) {
      if (trimmed === "" || indent > skipUntilIndent) {
        continue;
      }
      skipUntilIndent = -1;
    }

    result.push(line);
  }

  if (removedKeys.length === 0) {
    return;
  }

  await fs.promises.writeFile(workspaceYamlPath, result.join("\n"), "utf8");
  log(logId, "INFO", "Removed conflicting pnpm built dependency settings from pnpm-workspace.yaml", {
    projectDir,
    removedKeys,
  });
}

/**
 * 从 .npmrc 移除互斥的构建脚本配置（保留 dangerously-allow-all-builds）
 * @param {string} npmrcPath
 * @returns {Promise<string>} 清理后的内容
 */
async function sanitizeNpmrcBuiltDepsConfig(npmrcPath) {
  if (!fs.existsSync(npmrcPath)) {
    return "";
  }

  const content = await fs.promises.readFile(npmrcPath, "utf8");
  const filtered = content
    .split("\n")
    .filter((line) => !/^\s*(never-built-dependencies|only-built-dependencies|ignored-built-dependencies)\b/.test(line))
    .join("\n");

  if (filtered !== content) {
    await fs.promises.writeFile(npmrcPath, filtered, "utf8");
  }
  return filtered;
}

/**
 * 清理项目内与 dangerously-allow-all-builds 冲突的 pnpm 构建脚本配置
 * @param {string} projectDir
 * @param {string} logId
 */
async function sanitizePnpmBuiltDependenciesConfig(projectDir, logId) {
  await sanitizePackageJsonBuiltDepsConfig(projectDir, logId);
  await sanitizePnpmWorkspaceBuiltDepsConfig(projectDir, logId);
  await sanitizeNpmrcBuiltDepsConfig(path.join(projectDir, ".npmrc"));
}

/**
 * 为项目安装准备 pnpm 配置，与 build 流程保持一致
 * @param {string} projectDir
 * @param {string} logId
 */
async function ensurePnpmInstallConfig(projectDir, logId) {
  await createPnpmNpmrc(projectDir, logId);
  await sanitizePnpmBuiltDependenciesConfig(projectDir, logId);

  const npmrcPath = path.join(projectDir, ".npmrc");
  let content = await sanitizeNpmrcBuiltDepsConfig(npmrcPath);

  const additions = [];
  if (!/dangerously-allow-all-builds\s*=/.test(content)) {
    additions.push("dangerously-allow-all-builds=true");
  }
  if (!/production\s*=/.test(content)) {
    additions.push("production=false");
  }
  // 非 TTY 环境（Docker/CI）下允许自动重建 node_modules，避免 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
  if (!/confirm-modules-purge\s*=/.test(content)) {
    additions.push("confirm-modules-purge=false");
  }

  if (additions.length > 0) {
    const suffix = content && !content.endsWith("\n") ? "\n" : "";
    await fs.promises.writeFile(
      npmrcPath,
      `${content}${suffix}${additions.join("\n")}\n`,
      "utf8"
    );
    log(logId, "INFO", "Updated .npmrc for pnpm install", {
      projectDir,
      additions,
    });
  }
}

/**
 * 构建适合依赖安装的环境变量，避免继承服务端 production/CI 配置导致安装不完整
 * @returns {NodeJS.ProcessEnv}
 */
function buildInstallEnv() {
  const env = { ...process.env };
  delete env.CI;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_production;
  for (const key of PNPM_BUILT_DEPS_ENV_KEYS) {
    delete env[key];
  }
  env.NODE_ENV = "development";
  env.NPM_CONFIG_PRODUCTION = "false";
  return env;
}

/**
 * 在工作空间执行 pnpm install，行为与 dependencyManager 对齐
 * @param {string} projectDir
 * @param {string} logId
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runPnpmInstall(projectDir, logId) {
  await ensurePnpmInstallConfig(projectDir, logId);
  const spawnEnv = buildInstallEnv();

  const pnpmInstallArgs = [
    "install",
    "--prefer-offline",
    "--config.production=false",
    "--config.confirmModulesPurge=false",
    "--config.dangerouslyAllowAllBuilds=true",
  ];

  return runSpawn(
    "pnpm",
    pnpmInstallArgs,
    { cwd: projectDir, env: spawnEnv }
  );
}

/**
 * 递归查找 Python 项目目录（pyproject.toml 或 requirements.txt）
 * @param {string} rootDir
 * @returns {string|null}
 */
function findPythonProjectDir(rootDir) {
  const pyprojectPath = path.join(rootDir, "pyproject.toml");
  const requirementsPath = path.join(rootDir, "requirements.txt");
  if (fs.existsSync(pyprojectPath) || fs.existsSync(requirementsPath)) {
    return rootDir;
  }

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (
      entry.isDirectory()
      && !PACKAGE_SEARCH_SKIP_DIRS.has(entry.name)
      && entry.name !== ".venv"
      && entry.name !== "venv"
      && entry.name !== "__pycache__"
    ) {
      const result = findPythonProjectDir(path.join(rootDir, entry.name));
      if (result) return result;
    }
  }
  return null;
}

/**
 * 安装沙箱工作空间中的项目依赖
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {string} programmingLanguage typescript | python
 * @returns {Promise<{ message: string, projectDir: string, programmingLanguage: string }>}
 */
async function installProjectDependencies(userId, cId, programmingLanguage, service = null) {
  const logId = `computer:${userId}:${cId}`;
  const normalizedLang = String(programmingLanguage || "").trim().toLowerCase();

  if (!userId) {
    throw new ValidationError("userId cannot be empty", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId cannot be empty", { field: "cId" });
  }
  if (!normalizedLang) {
    throw new ValidationError("programmingLanguage cannot be empty", {
      field: "programmingLanguage",
    });
  }

  const workspaceDir = await ensureWorkspaceDir(service, userId, cId, logId);

  if (!fs.existsSync(workspaceDir)) {
    throw new ValidationError("workspace directory does not exist", {
      field: "workDir",
      workDir: workspaceDir,
    });
  }

  log(logId, "INFO", "Install project dependencies request", {
    userId,
    cId,
    programmingLanguage: normalizedLang,
  });

  const spawnEnv = buildInstallEnv();
  let projectDir = null;
  let installResult = null;

  if (normalizedLang === "typescript" || normalizedLang === "ts") {
    projectDir = findPackageScript(workspaceDir) || findNodeProjectDir(workspaceDir);
    if (!projectDir) {
      throw new ValidationError("TypeScript project not found in workspace", {
        field: "projectDir",
      });
    }

    installResult = await runPnpmInstall(projectDir, logId);
  } else if (normalizedLang === "python" || normalizedLang === "py") {
    projectDir = findPythonProjectDir(workspaceDir);
    if (!projectDir) {
      throw new ValidationError("Python project not found in workspace", {
        field: "projectDir",
      });
    }

    const pyprojectPath = path.join(projectDir, "pyproject.toml");
    const requirementsPath = path.join(projectDir, "requirements.txt");
    if (fs.existsSync(pyprojectPath)) {
      installResult = await runSpawn("pip", ["install", "-e", "."], {
        cwd: projectDir,
        env: spawnEnv,
      });
    } else if (fs.existsSync(requirementsPath)) {
      installResult = await runSpawn("pip", ["install", "-r", "requirements.txt"], {
        cwd: projectDir,
        env: spawnEnv,
      });
    } else {
      throw new ValidationError("No pyproject.toml or requirements.txt found in workspace", {
        field: "projectDir",
      });
    }
  } else {
    throw new ValidationError("Unsupported programmingLanguage", {
      field: "programmingLanguage",
      programmingLanguage: normalizedLang,
    });
  }

  log(logId, "INFO", "Project dependencies install completed", {
    projectDir,
    programmingLanguage: normalizedLang,
    exitCode: installResult.exitCode,
    stderrLength: installResult.stderr.length,
  });

  if (installResult.exitCode !== 0) {
    log(logId, "ERROR", "Project dependencies install failed", {
      projectDir,
      programmingLanguage: normalizedLang,
      stderr: installResult.stderr,
    });
    throw new SystemError(
      `Project dependencies install failed: ${installResult.stderr || installResult.stdout}`
    );
  }

  return {
    message: "Project dependencies installed successfully",
    projectDir,
    programmingLanguage: normalizedLang,
  };
}

export { createWorkspace, pushSkillsToWorkspace, initProjectTemplate, executeCommand, deleteWorkspace,
  zipWorkspace, buildAgentPackage, cleanupBuildArtifacts, installProjectDependencies, };


