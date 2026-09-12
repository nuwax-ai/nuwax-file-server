import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";
import { resolveWorkspaceRoot } from "../computer/workspaceContext.js";

const DYNAMIC_ADD_LOCK = ".dynamic_add.lock";
const SYNC_LOCK_NAME = ".sync.lock";
/** 锁过期时间：避免异常退出后永久卡死 */
const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 智能体级实体存储目录（按项目类型）：
 * - taskAgent / normalProject：{COMPUTER_WORKSPACE_DIR}/{userId}/.agent-store/{agentId}
 *   （每会话独立工作区，单 agent 无共享冲突，无 manifest；normalProject 共享工作区由
 *   np-{projectId}/ 协调目录下的 manifest 管理视图）
 * - userapp：随工作区就近放置 {工作区}/.agent-store/{agentId}
 *   （工作区 = 默认 {USERAPP_WORKSPACE_DIR}/{appId} = 容器 /home/user/{appId}，或用户绑定的
 *   自定义路径挂载到同一容器路径；store 在工作区内部，宿主/容器两视角同构，自定义目录不破坏布局）
 * 共享工作区（normalProject/userapp）配套 manifest.json 引用表，由 syncSharedSkillView 维护。
 */
const MANIFEST_FILE = "manifest.json";

/**
 * 项目级协调目录（共享工作区专用）：仅存放 manifest.json 引用表与 .view.lock 视图锁，
 * 不存放技能实体——同一 agent 的技能实体全局一份（见 getAgentStorePath），跨项目复用。
 * - normalProject：{COMPUTER_WORKSPACE_DIR}/{userId}/.agent-store/np-{projectId}/
 * - userapp：{USERAPP_WORKSPACE_DIR}/.agent-store/{appId}/（挂载点内，两视角相对链可解析）
 * - taskAgent 每会话独立工作区，无共享冲突，返回 null
 */
function getProjectStoreRoot(userId, service = null) {
  // userapp：store 随工作区就近放置——工作区（默认 {UWS}/{appId} = 容器内 /home/user/{appId}；
  // 自定义工作目录时为用户绑定路径（部署侧挂载为容器 /home/user/{appId}）。store 落在工作区
  // 内部 .agent-store/，宿主/容器两视角同构，相对链必然可解析，自定义目录不再破坏布局。
  // workspacePath 缺失（异常/老调用方）回落全局挂载布局 {UWS}/.agent-store/{appId}。
  if (service?.isUserApp && service?.appId) {
    if (service.workspacePath) {
      return path.join(service.workspacePath, ".agent-store");
    }
    return path.join(resolveWorkspaceRoot(service), ".agent-store", String(service.appId));
  }
  // normalProject：工作区与实体 store 均按 {CWS}/{userId} 分用户，协调目录同层，
  // 避免不同用户的同名项目 manifest 互相干扰
  if (service?.isNormalProject && service?.appId) {
    const root = resolveWorkspaceRoot(service);
    return path.join(root, String(userId), ".agent-store", `np-${service.appId}`);
  }
  return null;
}

/**
 * 技能实体子树（按 agentId 定位）：
 * - userapp：随工作区就近放置 {工作区}/.agent-store/{agentId}/（工作区 = 默认 {UWS}/{appId} =
 *   容器 /home/user/{appId}，或用户绑定的自定义路径；store 在工作区内部，两视角同构）。
 *   每个 app 一份实体——userapp 独立容器，app 间隔离；workspacePath 缺失时回落全局布局
 * - taskAgent 与 normalProject：{COMPUTER_WORKSPACE_DIR}/{userId}/.agent-store/{agentId}/——
 *   常规项目复用通用智能体的同一子树（同一智能体实体一份，不同项目/会话的 prune keep 清单
 *   均为该智能体的固定配置技能集，幂等无冲突）；工作区深度不同（{userId}/{cId} vs
 *   {userId}/NormalProject/{pid}），技能链相对路径由 path.relative 按实际深度计算
 */
function getAgentStorePath(userId, agentId, service = null) {
  const projectRoot = getProjectStoreRoot(userId, service);
  if (service?.isUserApp && projectRoot) {
    return path.join(projectRoot, String(agentId));
  }
  const workspaceRoot = resolveWorkspaceRoot(service);
  if (!workspaceRoot) {
    throw new ValidationError("COMPUTER_WORKSPACE_DIR configuration does not exist", {
      field: "COMPUTER_WORKSPACE_DIR",
    });
  }
  return path.join(workspaceRoot, String(userId), ".agent-store", String(agentId));
}

/**
 * 读项目层 manifest（agents→{skills,subagents} 引用表）；无文件返回空表。
 * manifest 是工作区技能视图的唯一事实来源：引用归零的技能/subagent 才可删除。
 */
async function readManifest(projectStoreRoot) {
  try {
    const raw = await fs.promises.readFile(path.join(projectStoreRoot, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.agents === "object"
      ? parsed
      : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

/** 原子写 manifest（tmp + rename），锁内调用 */
async function writeManifest(projectStoreRoot, manifest) {
  await fs.promises.mkdir(projectStoreRoot, { recursive: true });
  const tmp = path.join(projectStoreRoot, `${MANIFEST_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await fs.promises.rename(tmp, path.join(projectStoreRoot, MANIFEST_FILE));
}

/**
 * 从 manifest 计算反向引用：name → 引用它的 agentId 列表（按 manifest 键序）。
 * 来源选择（当前 agent 优先、实体存在者优先）由视图同步侧决定。
 */
function reverseRefs(manifest, kind) {
  const refs = {};
  for (const [agentId, entry] of Object.entries(manifest.agents || {})) {
    for (const name of entry?.[kind] || []) {
      (refs[name] = refs[name] || []).push(agentId);
    }
  }
  return refs;
}

async function ensureAgentStoreDirs(userId, agentId, logId, service = null) {
  const agentStorePath = getAgentStorePath(userId, agentId, service);
  if (service?.isUserApp) {
    // userapp 的 {UWS}/.agent-store 由部署侧挂载（挂载根），缺失时抛错，避免 mkdir 落到容器
    // 本地临时目录；共享工作区模式 store 为 {挂载根}/{appId}/{agentId}，存在性检查指向挂载根
    const mountRoot = path.dirname(path.dirname(agentStorePath));
    if (!fs.existsSync(mountRoot)) {
      throw new ValidationError(
        `userapp agent-store mount does not exist: ${mountRoot}`,
        { field: "USERAPP_WORKSPACE_DIR" }
      );
    }
  }
  const skillsDir = path.join(agentStorePath, "skills");
  const agentsDir = path.join(agentStorePath, "agents");
  await fs.promises.mkdir(skillsDir, { recursive: true });
  await fs.promises.mkdir(agentsDir, { recursive: true });
  log(logId || "agent-store", "DEBUG", "Agent store dirs ready", {
    agentStorePath,
    skillsDir,
    agentsDir,
  });
  return { agentStorePath, skillsDir, agentsDir };
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
  getAgentStorePath,
  getProjectStoreRoot,
  readManifest,
  writeManifest,
  reverseRefs,
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
