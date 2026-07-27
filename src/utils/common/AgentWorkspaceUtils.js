import fs from "fs";
import path from "path";

const AGENT_ROOT_MAP = {
  agents: ".agents",
  claudecode: ".claude",
  opencode: ".opencode",
  codex: ".codex",
  // 对齐 Rust SYNC_TARGET_DIRS: grok_build / pi-agent skills 的 fan-out 目标。
  // syncAgents 遍历 ALL_AGENT_TYPES 会自动覆盖, 无需改 syncAgents 主体。
  grok: ".grok",
  pi: ".pi",
};

const ALL_AGENT_TYPES = Object.keys(AGENT_ROOT_MAP);
const PRIMARY_AGENT_TYPE = "agents";

/**
 * fan-out 版本标识 (从 AGENT_ROOT_MAP 派生, 排除 PRIMARY .agents)。
 * syncAgents 写入 .agents/.sync_version; 启动 reconciler 据此 O(1) 判断是否需补 sync。
 * 加新 agent 改 AGENT_ROOT_MAP 即自动变版本 → 触发下次启动 reconcile。
 * 对齐 Rust skills.rs sync_target_version()。
 */
function syncTargetVersion() {
  return Object.values(AGENT_ROOT_MAP)
    .filter((dir) => dir !== AGENT_ROOT_MAP[PRIMARY_AGENT_TYPE])
    .join(",");
  // → ".claude,.opencode,.codex,.grok,.pi"
}

async function removePathIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) return;
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function copyDirectory(srcDir, destDir) {
  const stat = await fs.promises.lstat(srcDir);
  if (stat.isDirectory()) {
    await ensureDir(destDir);
    const entries = await fs.promises.readdir(srcDir);
    for (const entry of entries) {
      await copyDirectory(path.join(srcDir, entry), path.join(destDir, entry));
    }
  } else {
    await ensureDir(path.dirname(destDir));
    await fs.promises.copyFile(srcDir, destDir);
  }
}

/**
 * 仅确保主 agent（.claude）目录存在，业务逻辑只写这一份
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
 * 将主 agent 目录内容同步到其他 agent 目录
 */
async function syncAgents(workspaceRoot) {
  const primary = await ensurePrimaryAgentDirs(workspaceRoot);

  for (const agentType of ALL_AGENT_TYPES) {
    if (agentType === PRIMARY_AGENT_TYPE) continue;
    const targetRoot = path.join(workspaceRoot, AGENT_ROOT_MAP[agentType]);
    const targetSkills = path.join(targetRoot, "skills");
    const targetAgents = path.join(targetRoot, "agents");
    await ensureDir(targetRoot);

    await removePathIfExists(targetSkills);
    await ensureDir(targetSkills);
    if (fs.existsSync(primary.skillsDir)) {
      const entries = await fs.promises.readdir(primary.skillsDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const srcPath = path.join(primary.skillsDir, entry.name);
        const dstPath = path.join(targetSkills, entry.name);
        await copyDirectory(srcPath, dstPath);
      }
    }

    await removePathIfExists(targetAgents);
    await ensureDir(targetAgents);
    if (fs.existsSync(primary.agentsDir)) {
      const entries = await fs.promises.readdir(primary.agentsDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const srcPath = path.join(primary.agentsDir, entry.name);
        const dstPath = path.join(targetAgents, entry.name);
        await copyDirectory(srcPath, dstPath);
      }
    }
  }

  // 版本 marker: 启动 reconciler 据此 O(1) 判断是否需补 sync (对齐 Rust skills.rs)。
  // 写失败不阻断 sync 结果 (最坏 reconciler 下次多 sync 一次, 幂等兜底)。
  try {
    await fs.promises.writeFile(
      path.join(workspaceRoot, ".agents", ".sync_version"),
      syncTargetVersion(),
      "utf8"
    );
  } catch {
    // marker 仅优化用途, 写失败忽略 (不 log, 对齐 Rust `let _ = fs::write`)
  }

  return { agentTypes: ALL_AGENT_TYPES };
}

export {
  ensurePrimaryAgentDirs,
  syncAgents,
  syncTargetVersion,
};
