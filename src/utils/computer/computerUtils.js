import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { extractZip } from "../common/zipUtils.js";
import {
  ValidationError,
  SystemError,
  FileError,
} from "../error/errorHandler.js";
import { log } from "../log/logUtils.js";

/**
 * 确保工作空间根目录存在：$COMPUTER_WORKSPACE_DIR
 */
async function ensureWorkspaceRoot(logId = "computer") {
  const workspaceRoot = config.COMPUTER_WORKSPACE_DIR;

  if (!workspaceRoot) {
    throw new ValidationError("COMPUTER_WORKSPACE_DIR 配置不存在", {
      field: "COMPUTER_WORKSPACE_DIR",
    });
  }

  if (!fs.existsSync(workspaceRoot)) {
    await fs.promises.mkdir(workspaceRoot, { recursive: true });
    log(logId, "INFO", "创建用户工作空间根目录", { workspaceRoot });
  }

  return workspaceRoot;
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
 * 创建工作空间并（可选）处理上传的 zip，提取 skills 目录
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object|null} file multer 文件对象（zip），可以为空
 */
async function createWorkspace(userId, cId, file) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }

  const workspaceRoot = await ensureWorkspaceRoot(logId);
  const tmpRoot = path.join(
    workspaceRoot,
    String(userId),
    String(cId),
    ".tmp"
  );

  // 目标：$COMPUTER_WORKSPACE_DIR/userId/cId/
  const userWorkspaceRoot = path.join(
    workspaceRoot,
    String(userId),
    String(cId)
  );
  const claudeDir = path.join(userWorkspaceRoot, ".claude");
  const targetSkillsDir = path.join(claudeDir, "skills");
  const targetAgentsDir = path.join(claudeDir, "agents");

  // 始终：保证工作空间目录、.claude 目录存在，并清空（删除）现有 skills 和 agents 目录
  if (!fs.existsSync(userWorkspaceRoot)) {
    await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
  }
  if (!fs.existsSync(claudeDir)) {
    await fs.promises.mkdir(claudeDir, { recursive: true });
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

  // 恢复保留的 skills
  if (fs.existsSync(preservedSkillsTemp)) {
    await fs.promises.mkdir(targetSkillsDir, { recursive: true });
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
  log(logId, "INFO", "删除旧 skills 和 agents 目录完成", {
    userId,
    cId,
    targetSkillsDir,
    targetAgentsDir,
    skillsExists: skillsExistsAfter,
    agentsExists: agentsExistsAfter,
  });

  // 如果没有文件：不写入 skills 和 agents
  if (!file) {
    log(logId, "INFO", "创建工作空间（无上传文件，无 skills 和 agents）", {
      userId,
      cId,
      workspaceRoot,
      claudeDir,
      skillsDir: null,
      agentsDir: null,
    });

    return {
      message: "工作空间已创建（无上传文件，无 skills 和 agents）",
      workspaceRoot,
    };
  }

  // 有上传文件时，要求是 zip
  if (!file.path) {
    throw new ValidationError("上传文件无有效路径", { field: "file.path" });
  }

  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  if (ext !== ".zip") {
    throw new ValidationError("仅支持 zip 文件", {
      field: "file",
      originalName: file.originalname,
    });
  }

  log(logId, "INFO", "开始处理上传的 zip 文件", {
    userId,
    cId,
    workspaceRoot,
    tempZipPath: file.path,
  });

  const extractRoot = path.join(
    tmpRoot,
    `skill_extract_${Date.now()}_${Math.round(Math.random() * 1e6)}`
  );

  try {
    if (!fs.existsSync(tmpRoot)) {
      await fs.promises.mkdir(tmpRoot, { recursive: true });
    }
    await fs.promises.mkdir(extractRoot, { recursive: true });
    await extractZip(file.path, extractRoot);

    // 查找压缩包中的 skills 和 agents 目录
    const skillsDir = await findDir(extractRoot, "skills");
    const agentsDir = await findDir(extractRoot, "agents");

    const updatedDirs = [];

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
      }
      updatedDirs.push("skills");
      log(logId, "INFO", "skills 已更新到工作空间", {
        userId,
        cId,
        workspaceRoot,
        claudeDir,
        targetSkillsDir,
      });
    } else {
      log(logId, "INFO", "zip 中未找到 skills 目录，跳过", {
        userId,
        cId,
        extractRoot,
      });
    }

    // 如果压缩包中有 agents 目录，就写入
    if (agentsDir) {
      await moveDirectory(agentsDir, targetAgentsDir);
      updatedDirs.push("agents");
      log(logId, "INFO", "agents 已更新到工作空间", {
        userId,
        cId,
        workspaceRoot,
        claudeDir,
        targetAgentsDir,
      });
    } else {
      log(logId, "INFO", "zip 中未找到 agents 目录，跳过", {
        userId,
        cId,
        extractRoot,
      });
    }

    // 如果两个目录都没找到，记录警告但不中断流程
    if (updatedDirs.length === 0) {
      log(logId, "WARN", "zip 中未找到 skills 和 agents 目录", {
        userId,
        cId,
        extractRoot,
      });
    }

    const message = updatedDirs.length > 0
      ? `工作空间创建完成，${updatedDirs.join(" 和 ")} 已更新`
      : "工作空间创建完成（zip 中未找到 skills 和 agents）";

    return {
      message,
      workspaceRoot,
    };
  } catch (error) {
    log(logId, "ERROR", "处理上传的 zip 文件失败", {
      userId,
      cId,
      error: error.message,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`创建工作空间失败: ${error.message}`, {
      userId,
      cId,
    });
  } finally {
    // 清理临时目录和临时 zip 文件
    try {
      if (fs.existsSync(extractRoot)) {
        await fs.promises.rm(extractRoot, { recursive: true, force: true });
      }
    } catch (e) {
      log(logId, "WARN", "清理临时解压的 zip 失败", {
        extractRoot,
        error: e.message,
      });
    }
    // 清理上传的 zip 文件
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "清理上传的 zip 文件失败", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
  }
}

/**
 * 推送技能到工作空间
 * file 为 zip 压缩包，其中应包含 skills 目录，skills 目录下为具体 skill 子目录
 * 如有同名 skill 则覆盖，否则新增；不处理 agents 目录
 * @param {string|number} userId
 * @param {string|number} cId
 * @param {Object} file multer 文件对象（zip）
 */
async function pushSkillsToWorkspace(userId, cId, file) {
  const logId = `computer:${userId}:${cId}`;

  if (!userId) {
    throw new ValidationError("userId 不能为空", { field: "userId" });
  }
  if (!cId) {
    throw new ValidationError("cId 不能为空", { field: "cId" });
  }
  if (!file || !file.path) {
    throw new ValidationError("上传文件无有效路径", { field: "file.path" });
  }

  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  if (ext !== ".zip") {
    throw new ValidationError("仅支持 zip 文件", {
      field: "file",
      originalName: file?.originalname,
    });
  }

  const workspaceRoot = await ensureWorkspaceRoot(logId);
  const tmpRoot = path.join(
    workspaceRoot,
    String(userId),
    String(cId),
    ".tmp"
  );
  const userWorkspaceRoot = path.join(
    workspaceRoot,
    String(userId),
    String(cId)
  );
  const claudeDir = path.join(userWorkspaceRoot, ".claude");
  const targetSkillsDir = path.join(claudeDir, "skills");

  const extractRoot = path.join(
    tmpRoot,
    `skill_push_${Date.now()}_${Math.round(Math.random() * 1e6)}`
  );

  try {
    if (!fs.existsSync(userWorkspaceRoot)) {
      await fs.promises.mkdir(userWorkspaceRoot, { recursive: true });
    }
    if (!fs.existsSync(claudeDir)) {
      await fs.promises.mkdir(claudeDir, { recursive: true });
    }
    if (!fs.existsSync(targetSkillsDir)) {
      await fs.promises.mkdir(targetSkillsDir, { recursive: true });
    }
    if (!fs.existsSync(tmpRoot)) {
      await fs.promises.mkdir(tmpRoot, { recursive: true });
    }

    await fs.promises.mkdir(extractRoot, { recursive: true });
    await extractZip(file.path, extractRoot);

    // 查找压缩包中的 skills 目录，遍历其下具体 skill 子目录
    const skillsDir = await findDir(extractRoot, "skills");
    if (!skillsDir) {
      log(logId, "WARN", "zip 中未找到 skills 目录", {
        userId,
        cId,
        extractRoot,
      });
      return {
        message: "zip 中未找到 skills 目录",
        workspaceRoot,
        updatedSkills: [],
      };
    }

    const skillEntries = await fs.promises.readdir(skillsDir, {
      withFileTypes: true,
    });
    const skillDirs = skillEntries.filter((e) => e.isDirectory() && !e.name.startsWith("."));

    if (skillDirs.length === 0) {
      log(logId, "WARN", "zip 的 skills 目录下未找到 skill 子目录", {
        userId,
        cId,
        skillsDir,
      });
      return {
        message: "zip 的 skills 目录下未找到 skill 子目录",
        workspaceRoot,
        updatedSkills: [],
      };
    }

    const updatedSkills = [];

    for (const skillDir of skillDirs) {
      const srcSkillPath = path.join(skillsDir, skillDir.name);
      const destSkillPath = path.join(targetSkillsDir, skillDir.name);

      if (fs.existsSync(destSkillPath)) {
        await removeDirIfExists(destSkillPath);
      }

      await moveDirectory(srcSkillPath, destSkillPath);
      updatedSkills.push(skillDir.name);

      log(logId, "INFO", "skill 已推送到工作空间", {
        userId,
        cId,
        skillName: skillDir.name,
        destSkillPath,
      });
    }

    const message =
      updatedSkills.length > 0
        ? `已推送 ${updatedSkills.length} 个 skill: ${updatedSkills.join(", ")}`
        : "zip 中未找到有效 skill 目录";

    return {
      message,
      workspaceRoot,
      updatedSkills,
    };
  } catch (error) {
    log(logId, "ERROR", "推送 skill 到工作空间失败", {
      userId,
      cId,
      error: error.message,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`推送 skill 失败: ${error.message}`, {
      userId,
      cId,
    });
  } finally {
    try {
      if (fs.existsSync(extractRoot)) {
        await fs.promises.rm(extractRoot, { recursive: true, force: true });
      }
    } catch (e) {
      log(logId, "WARN", "清理临时解压目录失败", {
        extractRoot,
        error: e.message,
      });
    }
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "清理上传的 zip 文件失败", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
  }
}

export { createWorkspace, pushSkillsToWorkspace };


