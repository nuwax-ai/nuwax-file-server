import fs from "fs";
import path from "path";

const AGENT_ROOT_MAP = {
  claudecode: ".claude",
  opencode: ".opencode",
};

const ALL_AGENT_TYPES = Object.keys(AGENT_ROOT_MAP);

async function removePathIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) return;
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * 确保工作区存在统一的 .nuwax 存储目录
 * @param {string} workspaceRoot
 * @returns {Promise<{nuwaxDir:string, skillsDir:string, agentsDir:string}>}
 */
async function ensureNuwaxDirs(workspaceRoot) {
  const nuwaxDir = path.join(workspaceRoot, ".nuwax");
  const skillsDir = path.join(nuwaxDir, "skills");
  const agentsDir = path.join(nuwaxDir, "agents");
  await ensureDir(nuwaxDir);
  await ensureDir(skillsDir);
  await ensureDir(agentsDir);
  return { nuwaxDir, skillsDir, agentsDir };
}

/**
 * 对每一种 agent 建立 skills/agents 软链接映射
 * @param {string} workspaceRoot
 * @returns {Promise<{agentTypes:string[], skillsDir:string, agentsDir:string}>}
 */
async function ensureAgentWorkspaceLinks(workspaceRoot) {
  const { skillsDir, agentsDir } = await ensureNuwaxDirs(workspaceRoot);

  for (const agentType of ALL_AGENT_TYPES) {
    const agentRootDir = path.join(workspaceRoot, AGENT_ROOT_MAP[agentType]);
    const skillsLinkPath = path.join(agentRootDir, "skills");
    const agentsLinkPath = path.join(agentRootDir, "agents");

    await ensureDir(agentRootDir);
    await removePathIfExists(skillsLinkPath);
    await removePathIfExists(agentsLinkPath);

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await fs.promises.symlink(skillsDir, skillsLinkPath, symlinkType);
    await fs.promises.symlink(agentsDir, agentsLinkPath, symlinkType);
  }

  return { agentTypes: ALL_AGENT_TYPES, skillsDir, agentsDir };
}

export {
  ensureNuwaxDirs,
  ensureAgentWorkspaceLinks,
};
