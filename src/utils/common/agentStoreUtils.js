import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";

const DYNAMIC_ADD_LOCK = ".dynamic_add.lock";
const SYNC_LOCK_NAME = ".sync.lock";
/** 锁过期时间：避免异常退出后永久卡死 */
const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 智能体级实体存储根目录：固定为 {COMPUTER_WORKSPACE_DIR}/.agent-store
 * 与会话工作区同属 COMPUTER_WORKSPACE_DIR，相对软链可跨节点挂载点解析。
 */
function getAgentStoreRoot() {
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;
  if (!workspaceRoot) {
    throw new ValidationError("COMPUTER_WORKSPACE_DIR configuration does not exist", {
      field: "COMPUTER_WORKSPACE_DIR",
    });
  }
  return path.join(workspaceRoot, ".agent-store");
}

/**
 * @param {string|number} userId
 * @param {string|number} agentId
 */
function getAgentStorePath(userId, agentId) {
  return path.join(getAgentStoreRoot(), String(userId), String(agentId));
}

async function ensureAgentStoreDirs(userId, agentId, logId) {
  const storeRoot = getAgentStoreRoot();
  const agentStorePath = getAgentStorePath(userId, agentId);
  const skillsDir = path.join(agentStorePath, "skills");
  const agentsDir = path.join(agentStorePath, "agents");
  await fs.promises.mkdir(skillsDir, { recursive: true });
  await fs.promises.mkdir(agentsDir, { recursive: true });
  log(logId || "agent-store", "DEBUG", "Agent store dirs ready", {
    storeRoot,
    agentStorePath,
    skillsDir,
    agentsDir,
  });
  return { storeRoot, agentStorePath, skillsDir, agentsDir };
}

/**
 * 尝试获取同 userId/agentId 的写锁。拿不到则返回 false（调用方跳过实体更新）。
 */
async function tryAcquireAgentStoreLock(agentStorePath, logId) {
  await fs.promises.mkdir(agentStorePath, { recursive: true });
  const lockPath = path.join(agentStorePath, SYNC_LOCK_NAME);
  try {
    const fd = await fs.promises.open(lockPath, "wx");
    await fd.writeFile(`${process.pid}:${Date.now()}`);
    await fd.close();
    return { acquired: true, lockPath };
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const stat = await fs.promises.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > SYNC_LOCK_STALE_MS) {
          await fs.promises.rm(lockPath, { force: true });
          const fd = await fs.promises.open(lockPath, "wx");
          await fd.writeFile(`${process.pid}:${Date.now()}`);
          await fd.close();
          log(logId || "agent-store", "WARN", "Stole stale agent store lock", {
            lockPath,
            ageMs: age,
          });
          return { acquired: true, lockPath };
        }
      } catch (e) {
        log(logId || "agent-store", "WARN", "Check agent store lock failed", {
          lockPath,
          error: e.message,
        });
      }
      log(logId || "agent-store", "INFO", "Skip agent store update, lock held by another request", {
        lockPath,
      });
      return { acquired: false, lockPath };
    }
    throw err;
  }
}

async function releaseAgentStoreLock(lockPath, logId) {
  if (!lockPath) return;
  try {
    await fs.promises.rm(lockPath, { force: true });
  } catch (e) {
    log(logId || "agent-store", "WARN", "Release agent store lock failed", {
      lockPath,
      error: e.message,
    });
  }
}

function hasDynamicAddLock(skillDirPath) {
  const lockPath = path.join(skillDirPath, DYNAMIC_ADD_LOCK);
  return fs.existsSync(lockPath) && fs.statSync(lockPath).isFile();
}

async function ensureDynamicAddLock(skillDirPath) {
  await fs.promises.mkdir(skillDirPath, { recursive: true });
  const lockPath = path.join(skillDirPath, DYNAMIC_ADD_LOCK);
  await fs.promises.writeFile(lockPath, `${Date.now()}\n`, "utf8");
}

/**
 * 按 keepSkillNames 清理实体 skills：
 * - 不在列表中且无动态锁 → 删除
 * - 不在列表中但有动态锁 → 保留
 * - 同名覆盖由写入侧处理（写入前先删目录）
 */
async function pruneAgentSkills(skillsDir, keepSkillNames, logId) {
  const keep = new Set(
    (Array.isArray(keepSkillNames) ? keepSkillNames : [])
      .map((n) => String(n || "").trim())
      .filter(Boolean)
  );
  if (!fs.existsSync(skillsDir)) return { removed: [], keptDynamic: [] };

  const removed = [];
  const keptDynamic = [];
  const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;
    const skillPath = path.join(skillsDir, entry.name);
    if (hasDynamicAddLock(skillPath)) {
      keptDynamic.push(entry.name);
      continue;
    }
    await fs.promises.rm(skillPath, { recursive: true, force: true });
    removed.push(entry.name);
  }
  log(logId || "agent-store", "INFO", "Prune agent skills completed", {
    skillsDir,
    keepCount: keep.size,
    removed,
    keptDynamic,
  });
  return { removed, keptDynamic };
}

/**
 * 将源 skill 目录覆盖写入目标（同名覆盖，含动态技能）。
 * @param {boolean} [asDynamic] 为 true 时写入后打动态锁；配置技能覆盖时去掉锁
 */
async function installSkillDir(srcSkillPath, destSkillsDir, skillName, options = {}) {
  const { asDynamic = false } = options;
  const destPath = path.join(destSkillsDir, skillName);
  try {
    await fs.promises.lstat(destPath);
    await fs.promises.rm(destPath, { recursive: true, force: true });
  } catch {
    // not exists
  }
  await fs.promises.mkdir(destSkillsDir, { recursive: true });
  await moveOrCopyDirectory(srcSkillPath, destPath);
  if (asDynamic) {
    await ensureDynamicAddLock(destPath);
  } else {
    const lockPath = path.join(destPath, DYNAMIC_ADD_LOCK);
    if (fs.existsSync(lockPath)) {
      await fs.promises.rm(lockPath, { force: true });
    }
  }
  return destPath;
}

async function moveOrCopyDirectory(srcDir, destDir) {
  try {
    await fs.promises.rename(srcDir, destDir);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await fs.promises.cp(srcDir, destDir, { recursive: true });
      await fs.promises.rm(srcDir, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * 用源 agents 目录整体替换实体 agents（每次 createWorkspace 刷新）
 */
async function replaceAgentsDir(srcAgentsDir, destAgentsDir) {
  await fs.promises.rm(destAgentsDir, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(destAgentsDir), { recursive: true });
  if (srcAgentsDir && fs.existsSync(srcAgentsDir)) {
    await moveOrCopyDirectory(srcAgentsDir, destAgentsDir);
  } else {
    await fs.promises.mkdir(destAgentsDir, { recursive: true });
  }
}

/**
 * 判断实体 skills 下是否已有指定技能目录
 */
function agentSkillExists(skillsDir, skillName) {
  if (!skillsDir || !skillName) return false;
  try {
    return fs.statSync(path.join(skillsDir, skillName)).isDirectory();
  } catch {
    return false;
  }
}

export {
  DYNAMIC_ADD_LOCK,
  getAgentStoreRoot,
  getAgentStorePath,
  ensureAgentStoreDirs,
  tryAcquireAgentStoreLock,
  releaseAgentStoreLock,
  hasDynamicAddLock,
  ensureDynamicAddLock,
  pruneAgentSkills,
  installSkillDir,
  replaceAgentsDir,
  moveOrCopyDirectory,
  agentSkillExists,
};
