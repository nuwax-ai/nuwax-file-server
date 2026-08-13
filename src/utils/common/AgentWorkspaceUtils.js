import fs from "fs";
import path from "path";
import { log } from "../log/logUtils.js";

const AGENT_ROOT_MAP = {
  agents: ".agents",
  claudecode: ".claude",
  opencode: ".opencode",
  codex: ".codex",
};

const ALL_AGENT_TYPES = Object.keys(AGENT_ROOT_MAP);
const PRIMARY_AGENT_TYPE = "agents";

/** syncAgents 全局拷贝并发上限（跨目录层级共享，避免嵌套放大） */
const SYNC_COPY_CONCURRENCY = 8;

/**
 * 简单异步信号量（唤醒等待者时移交槽位，不额外增减 active）
 * @param {number} max
 */
function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise((resolve) => {
        waiters.push(resolve);
      });
      // 被 release 移交槽位，active 已计入
    },
    release() {
      const next = waiters.shift();
      if (next) {
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },
  };
}

/** 模块级单一信号量：所有 syncAgents 拷贝共享 */
const syncCopySemaphore = createSemaphore(SYNC_COPY_CONCURRENCY);

async function removePathIfExists(targetPath) {
  try {
    await fs.promises.lstat(targetPath);
  } catch {
    return;
  }
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) return;
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * 递归拷贝；目录展开后释放槽位给子项，文件拷贝占槽，全局最多 SYNC_COPY_CONCURRENCY 个并发 I/O。
 */
async function copyDirectory(srcDir, destDir) {
  await syncCopySemaphore.acquire();
  let releasedEarly = false;
  try {
    const stat = await fs.promises.lstat(srcDir);
    if (stat.isDirectory()) {
      await ensureDir(destDir);
      const entries = await fs.promises.readdir(srcDir);
      // 列出子项后释放槽位，让子拷贝可以占用并发额度
      syncCopySemaphore.release();
      releasedEarly = true;
      await Promise.all(
        entries.map((entry) =>
          copyDirectory(path.join(srcDir, entry), path.join(destDir, entry))
        )
      );
      return;
    }
    await ensureDir(path.dirname(destDir));
    await fs.promises.copyFile(srcDir, destDir);
  } finally {
    if (!releasedEarly) {
      syncCopySemaphore.release();
    }
  }
}

/**
 * 将 srcDir 下各顶层条目拷到 destDir（并发由全局信号量控制）
 */
async function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  await ensureDir(destDir);
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      copyDirectory(
        path.join(srcDir, entry.name),
        path.join(destDir, entry.name)
      )
    )
  );
}

/**
 * 仅确保主 agent（.agents）目录存在，业务逻辑只写这一份
 */
async function ensurePrimaryAgentDirs(workspaceRoot) {
  const rootDir = path.join(workspaceRoot, AGENT_ROOT_MAP[PRIMARY_AGENT_TYPE]);
  const skillsDir = path.join(rootDir, "skills");
  const agentsDir = path.join(rootDir, "agents");
  await ensureDir(rootDir);
  await ensureDir(skillsDir);
  await ensureDir(agentsDir);
  return { rootDir, skillsDir, agentsDir, agentTypes: ALL_AGENT_TYPES };
}

/**
 * 将 linkPath 建为指向 targetPath 的目录链接。
 * - Unix：相对软链（CephFS 跨节点绝对挂载点不同时仍可解析）
 * - Windows：优先 junction（绝对路径），失败再试 dir symlink
 */
async function forceDirSymlink(linkPath, targetPath, logId) {
  await ensureDir(path.dirname(linkPath));
  await ensureDir(targetPath);
  await removePathIfExists(linkPath);

  const absTarget = path.resolve(targetPath);
  const isWin = process.platform === "win32";

  if (isWin) {
    try {
      await fs.promises.symlink(absTarget, linkPath, "junction");
      log(logId || "symlink", "DEBUG", "Created dir junction (windows)", {
        linkPath,
        targetPath: absTarget,
        type: "junction",
      });
      return;
    } catch (junctionErr) {
      log(logId || "symlink", "WARN", "Windows junction failed, try dir symlink", {
        linkPath,
        targetPath: absTarget,
        error: junctionErr.message,
      });
      await removePathIfExists(linkPath);
      await fs.promises.symlink(absTarget, linkPath, "dir");
      log(logId || "symlink", "DEBUG", "Created dir symlink (windows)", {
        linkPath,
        targetPath: absTarget,
        type: "dir",
      });
      return;
    }
  }

  let relativeTarget = path.relative(path.dirname(linkPath), absTarget);
  relativeTarget = relativeTarget.split(path.sep).join("/");
  if (!relativeTarget || path.isAbsolute(relativeTarget)) {
    throw new Error(
      `Cannot create relative symlink from ${linkPath} to ${targetPath} (got: ${relativeTarget || "<empty>"})`
    );
  }
  await fs.promises.symlink(relativeTarget, linkPath);
  log(logId || "symlink", "DEBUG", "Created dir symlink", {
    linkPath,
    targetPath: absTarget,
    relativeTarget,
    type: "symlink",
  });
}

/**
 * 链接失败时的老模式：从 agent-store 拷到 .agents，再 syncAgents 成四份实体副本
 */
async function materializeAgentStoreByCopy(workspaceRoot, agentSkillsDir, agentAgentsDir, logId) {
  const id = logId || "materialize-copy";
  // 清掉可能半成功的链接/目录
  for (const agentType of ALL_AGENT_TYPES) {
    const rootDir = path.join(workspaceRoot, AGENT_ROOT_MAP[agentType]);
    await removePathIfExists(path.join(rootDir, "skills"));
    await removePathIfExists(path.join(rootDir, "agents"));
  }

  const primary = await ensurePrimaryAgentDirs(workspaceRoot);
  await removePathIfExists(primary.skillsDir);
  await removePathIfExists(primary.agentsDir);
  await ensureDir(primary.skillsDir);
  await ensureDir(primary.agentsDir);
  await copyDirContents(agentSkillsDir, primary.skillsDir);
  await copyDirContents(agentAgentsDir, primary.agentsDir);

  const syncResult = await syncAgents(workspaceRoot, id);
  log(id, "INFO", "Materialized agent store by copy (legacy mode)", {
    workspaceRoot,
    agentSkillsDir,
    agentAgentsDir,
    syncElapsedMs: syncResult?.elapsedMs,
  });
  return syncResult;
}

/**
 * 会话工作区下 .agents/.claude/.opencode/.codex 的 skills、agents
 * 链到智能体实体目录；链接失败则回退为从 store 拷贝（老模式），保证功能可用。
 */
async function linkWorkspaceToAgentStore(workspaceRoot, agentSkillsDir, agentAgentsDir, logId) {
  const startedAt = Date.now();
  const id = logId || path.basename(workspaceRoot) || "linkWorkspace";
  log(id, "INFO", "Start linkWorkspaceToAgentStore", {
    workspaceRoot,
    agentSkillsDir,
    agentAgentsDir,
    platform: process.platform,
  });

  try {
    for (const agentType of ALL_AGENT_TYPES) {
      const rootDir = path.join(workspaceRoot, AGENT_ROOT_MAP[agentType]);
      await ensureDir(rootDir);
      await forceDirSymlink(path.join(rootDir, "skills"), agentSkillsDir, id);
      await forceDirSymlink(path.join(rootDir, "agents"), agentAgentsDir, id);
    }

    const elapsedMs = Date.now() - startedAt;
    log(id, "INFO", "linkWorkspaceToAgentStore completed", {
      workspaceRoot,
      agentTypes: ALL_AGENT_TYPES,
      mode: "symlink",
      elapsedMs,
    });
    return { agentTypes: ALL_AGENT_TYPES, elapsedMs, mode: "symlink" };
  } catch (error) {
    log(id, "WARN", "Link to agent store failed, fallback to copy mode", {
      workspaceRoot,
      platform: process.platform,
      error: error.message,
    });
    const syncResult = await materializeAgentStoreByCopy(
      workspaceRoot,
      agentSkillsDir,
      agentAgentsDir,
      id
    );
    const elapsedMs = Date.now() - startedAt;
    log(id, "INFO", "linkWorkspaceToAgentStore completed (copy fallback)", {
      workspaceRoot,
      agentTypes: ALL_AGENT_TYPES,
      mode: "copy-fallback",
      elapsedMs,
      syncElapsedMs: syncResult?.elapsedMs,
    });
    return {
      agentTypes: ALL_AGENT_TYPES,
      elapsedMs,
      mode: "copy-fallback",
      syncElapsedMs: syncResult?.elapsedMs,
    };
  }
}

/**
 * 同步单个目标 agent 目录（从 .agents 拷贝）
 */
async function syncOneAgentType(workspaceRoot, agentType, primary, logId) {
  const targetRoot = path.join(workspaceRoot, AGENT_ROOT_MAP[agentType]);
  const targetSkills = path.join(targetRoot, "skills");
  const targetAgents = path.join(targetRoot, "agents");
  await ensureDir(targetRoot);

  await removePathIfExists(targetSkills);
  await removePathIfExists(targetAgents);
  await ensureDir(targetSkills);
  await ensureDir(targetAgents);

  await Promise.all([
    copyDirContents(primary.skillsDir, targetSkills),
    copyDirContents(primary.agentsDir, targetAgents),
  ]);

  log(logId, "DEBUG", "syncAgents target completed", {
    agentType,
    targetRoot,
  });
}

/**
 * 将主 agent 目录内容同步到其他 agent 目录（旧拷贝逻辑，无 agentId 时兼容）
 * 目标目录可并行发起，实际拷贝 I/O 由全局信号量限制为最多 16。
 * @param {string} workspaceRoot
 * @param {string} [logId] 可选，与调用方日志关联
 */
async function syncAgents(workspaceRoot, logId) {
  const startedAt = Date.now();
  const id = logId || path.basename(workspaceRoot) || "syncAgents";
  const targetAgentTypes = ALL_AGENT_TYPES.filter((t) => t !== PRIMARY_AGENT_TYPE);
  log(id, "INFO", "Start syncAgents", {
    workspaceRoot,
    targetAgentTypes,
    concurrency: SYNC_COPY_CONCURRENCY,
  });

  const primary = await ensurePrimaryAgentDirs(workspaceRoot);

  await Promise.all(
    targetAgentTypes.map((agentType) =>
      syncOneAgentType(workspaceRoot, agentType, primary, id)
    )
  );

  const elapsedMs = Date.now() - startedAt;
  log(id, "INFO", "syncAgents completed", {
    workspaceRoot,
    agentTypes: ALL_AGENT_TYPES,
    elapsedMs,
  });

  return { agentTypes: ALL_AGENT_TYPES, elapsedMs };
}

/**
 * 会话工作区 .agents/skills 是否已是链接（Unix 软链 / Windows junction）。
 * push 仅在「有 agentId 且已是链接」时走 store；否则保持实体目录老逻辑，避免冲掉旧会话技能。
 */
function isWorkspaceSkillsSymlinked(workspaceRoot) {
  if (!workspaceRoot) return false;
  const skillsPath = path.join(
    workspaceRoot,
    AGENT_ROOT_MAP[PRIMARY_AGENT_TYPE],
    "skills"
  );
  try {
    // Windows junction 在 Node 里同样表现为 isSymbolicLink() === true
    return fs.lstatSync(skillsPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export {
  AGENT_ROOT_MAP,
  ALL_AGENT_TYPES,
  ensurePrimaryAgentDirs,
  syncAgents,
  linkWorkspaceToAgentStore,
  forceDirSymlink,
  isWorkspaceSkillsSymlinked,
};
