import path from "path";
import fs from "fs";
import config from "../appConfig/index.js";
import { log } from "../utils/log/logUtils.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
  ResourceError,
} from "../utils/error/errorHandler.js";
import { resolveProjectPath } from "../utils/common/projectPathUtils.js";
import {
  getGitInstance,
  isGitRepo,
  ensureGitRepo,
  ensureGitignore,
} from "../utils/git/gitUtils.js";

/**
 * 解析目标路径并检查是否存在。
 * 通过 workspaceType 显式区分两种工作区：
 *   - "pageApp"：网页应用项目，用 projectId + isolationContext
 *   - "taskAgent"：通用智能体，用 userId + cId
 *
 * @param {Object} options
 * @param {"pageApp"|"taskAgent"} [options.workspaceType]
 * @param {string} [options.projectId]       pageApp 模式必传
 * @param {Object} [options.isolationContext]
 * @param {string} [options.userId]          taskAgent 模式必传
 * @param {string} [options.cId]             taskAgent 模式必传
 * @returns {{ targetPath: string, logId: string }}
 */
function resolveAndCheck(options) {
  const {
    workspaceType,
    projectId, isolationContext,
    userId, cId,
  } = options || {};

  if (!workspaceType || !["pageApp", "taskAgent"].includes(workspaceType)) {
    throw new ValidationError("workspaceType is required and must be pageApp or taskAgent", { field: "workspaceType" });
  }

  if (workspaceType === "taskAgent") {
    if (!userId || !cId) {
      throw new ValidationError("taskAgent mode requires userId and cId", { field: "userId/cId" });
    }
    const targetPath = path.join(config.COMPUTER_WORKSPACE_DIR, String(userId), String(cId));
    if (!fs.existsSync(targetPath)) {
      throw new ResourceError("Computer workspace does not exist", { userId, cId });
    }
    return { targetPath, logId: `computer:${userId}:${cId}` };
  }

  // workspaceType === "pageApp"
  if (!projectId) {
    throw new ValidationError("pageApp mode requires projectId", { field: "projectId" });
  }
  const targetPath = resolveProjectPath(projectId, isolationContext || {});
  if (!fs.existsSync(targetPath)) {
    throw new ResourceError("Project does not exist", { projectId });
  }
  return { targetPath, logId: projectId };
}

// ──────────────────────────── init ────────────────────────────

/**
 * 初始化 Git 仓库（幂等）
 * @param {Object} options
 * @param {string} [options.projectId]
 * @param {Object} [options.isolationContext]
 * @param {string} [options.userId]
 * @param {string} [options.cId]
 * @returns {Object}
 */
async function init(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);

  if (isGitRepo(targetPath)) {
    return { success: true, message: "Git repository already initialized", logId, alreadyExists: true };
  }

  try {
    const git = getGitInstance(targetPath);
    await git.init();
    ensureGitignore(targetPath);

    // 配置本地 user.name / user.email，不污染全局
    const authorName = config.GIT_DEFAULT_AUTHOR_NAME;
    const authorEmail = config.GIT_DEFAULT_AUTHOR_EMAIL;
    await git.addConfig("user.name", authorName, false, "local");
    await git.addConfig("user.email", authorEmail, false, "local");

    log(logId, "INFO", "Git repository initialized", { logId, targetPath });
    return { success: true, message: "Git repository initialized successfully", logId, alreadyExists: false };
  } catch (e) {
    log(logId, "ERROR", "Failed to initialize Git repository", { logId, error: e.message });
    throw new SystemError("Failed to initialize Git repository", { originalError: e.message });
  }
}

// ──────────────────────────── status ────────────────────────────

/**
 * 获取工作区状态
 */
async function status(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const statusResult = await git.status();

    return {
      success: true,
      logId,
      current: statusResult.current,
      staged: statusResult.staged,
      modified: statusResult.modified,
      created: statusResult.created,
      deleted: statusResult.deleted,
      conflicted: statusResult.conflicted,
      ahead: statusResult.ahead,
      behind: statusResult.behind,
      tracking: statusResult.tracking,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to get Git status", { logId, error: e.message });
    throw new SystemError("Failed to get Git status", { originalError: e.message });
  }
}

// ──────────────────────────── commit ────────────────────────────

/**
 * 暂存并提交
 */
async function commit(options = {}) {
  const { message, files, authorName, authorEmail } = options;
  if (!message || typeof message !== "string") {
    throw new ValidationError("Commit message cannot be empty", { field: "message" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    // 暂存文件
    if (Array.isArray(files) && files.length > 0) {
      await git.add(files);
    } else {
      await git.add("--all");
    }

    // 构建 commit 选项
    const commitOptions = [];
    if (authorName || authorEmail) {
      const name = authorName || config.GIT_DEFAULT_AUTHOR_NAME;
      const email = authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL;
      commitOptions.push(`--author=${name} <${email}>`);
    }

    const commitResult = await git.commit(message, commitOptions);

    log(logId, "INFO", "Git commit successful", {
      logId,
      commitHash: commitResult.commit,
      message,
    });

    return {
      success: true,
      message: "Commit successful",
      logId,
      commit: commitResult.commit,
      summary: commitResult.summary,
    };
  } catch (e) {
    // simple-git 在没有变更时抛出错误
    if (e.message && e.message.includes("nothing to commit")) {
      return { success: true, message: "Nothing to commit", logId, nothingToCommit: true };
    }
    log(logId, "ERROR", "Failed to commit", { logId, error: e.message });
    throw new SystemError("Failed to commit", { originalError: e.message });
  }
}

// ──────────────────────────── unstage ────────────────────────────

/**
 * 从暂存区撤回修改（git restore --staged），文件回到工作区 modified 状态
 */
async function unstage(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    if (Array.isArray(files) && files.length > 0) {
      await git.raw(["restore", "--staged", "--", ...files]);
      log(logId, "INFO", "Git unstage specified files", { logId, files });
      return {
        success: true,
        message: "Specified files unstaged successfully",
        logId,
        files,
      };
    } else {
      await git.raw(["restore", "--staged", "."]);
      log(logId, "INFO", "Git unstage all files", { logId });
      return {
        success: true,
        message: "All files unstaged successfully",
        logId,
        files: "all",
      };
    }
  } catch (e) {
    log(logId, "ERROR", "Failed to unstage", { logId, error: e.message });
    throw new SystemError("Failed to unstage files", { originalError: e.message });
  }
}

// ──────────────────────────── discard ────────────────────────────

/**
 * 清理因删除文件而产生的空目录。
 * 收集被删文件的所有父目录，从最深往浅逐级检查，空了就删，遇到非空或到达 root 停止。
 * @param {string} root 工作区根路径
 * @param {string[]} relativeFiles 被删除的相对路径文件列表
 */
async function cleanEmptyParentDirs(root, relativeFiles) {
  // 收集需要检查的目录（去重）
  const dirSet = new Set();
  for (const f of relativeFiles) {
    let dir = path.dirname(f);
    while (dir && dir !== ".") {
      dirSet.add(dir);
      dir = path.dirname(dir);
    }
  }

  // 按深度降序排列，先处理最深的目录
  const dirs = [...dirSet].sort((a, b) => {
    const depthA = a.split(/[/\\]/).length;
    const depthB = b.split(/[/\\]/).length;
    return depthB - depthA;
  });

  for (const relDir of dirs) {
    const absDir = path.join(root, relDir);
    try {
      const entries = await fs.promises.readdir(absDir);
      if (entries.length === 0) {
        await fs.promises.rmdir(absDir);
      }
    } catch (_) {
      // 目录不存在或权限问题，跳过
    }
  }
}

/**
 * 从暂存区撤回并丢弃工作区修改，文件完全还原到上次 commit 的状态。
 *
 * 需要区分两类文件：
 * - 已跟踪文件的修改/删除 → git restore --staged --worktree 即可
 * - 新增文件（从未被 commit 过）→ unstage 后需要从磁盘删除，
 *   因为 git restore --worktree 不会删除 untracked 文件
 */
async function discard(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const statusResult = await git.status();

    // 从 git status 中提取所有新增文件的集合（created = 暂存区中的新文件）
    const createdSet = new Set([...statusResult.created]);

    // 确定要操作的文件列表
    const targetFiles = Array.isArray(files) && files.length > 0 ? files : null;

    // 区分新增文件与已跟踪文件
    const newFiles = [];
    const trackedFiles = [];

    if (targetFiles) {
      for (const f of targetFiles) {
        if (createdSet.has(f)) {
          newFiles.push(f);
        } else {
          trackedFiles.push(f);
        }
      }
    } else {
      // 全部：暂存区中所有 created 视为新增，其余（staged + modified）视为已跟踪
      for (const f of statusResult.created) {
        newFiles.push(f);
      }
      // staged / modified / deleted 都是已跟踪文件
      const trackedSet = new Set([
        ...statusResult.staged,
        ...statusResult.modified,
        ...statusResult.deleted,
      ]);
      for (const f of trackedSet) {
        if (!createdSet.has(f)) {
          trackedFiles.push(f);
        }
      }
    }

    // 1) 已跟踪文件：restore --staged --worktree
    if (trackedFiles.length > 0) {
      await git.raw(["restore", "--staged", "--worktree", "--", ...trackedFiles]);
    }

    // 2) 新增文件：先从暂存区移除，再从磁盘删除
    if (newFiles.length > 0) {
      await git.raw(["rm", "--cached", "-f", "--", ...newFiles]);
      for (const f of newFiles) {
        const absPath = path.join(targetPath, f);
        if (fs.existsSync(absPath)) {
          await fs.promises.unlink(absPath);
        }
      }
      // 清理因删除文件而产生的空目录（从被删文件的父目录向上逐级检查）
      await cleanEmptyParentDirs(targetPath, newFiles);
    }

    const discardedCount = trackedFiles.length + newFiles.length;
    log(logId, "INFO", "Git discard", {
      logId,
      trackedFiles: trackedFiles.length,
      newFiles: newFiles.length,
    });

    return {
      success: true,
      message: "Files discarded successfully",
      logId,
      discardedCount,
      trackedFiles,
      newFiles,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to discard", { logId, error: e.message });
    throw new SystemError("Failed to discard files", { originalError: e.message });
  }
}

// ──────────────────────────── log ────────────────────────────

/**
 * 获取提交历史
 */
async function logHistory(options = {}) {
  const { maxCount: rawMax = 50, branch, skip: rawSkip = 0 } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const maxCount = Math.min(Math.max(1, rawMax), 500);
    const skip = Math.max(0, rawSkip);

    const args = [];
    if (branch) args.push(branch);
    args.push(`--max-count=${maxCount}`);
    if (skip > 0) args.push(`--skip=${skip}`);

    const logResult = await git.log(args);

    const commits = logResult.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author_name: entry.author_name,
      author_email: entry.author_email,
    }));

    return { success: true, logId, commits, total: commits.length };
  } catch (e) {
    log(logId, "ERROR", "Failed to get Git log", { logId, error: e.message });
    throw new SystemError("Failed to get Git log", { originalError: e.message });
  }
}

// ──────────────────────────── diff ────────────────────────────

/**
 * 差异对比
 */
async function diff(options = {}) {
  const { from, to, paths } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const diffArgs = [];

    if (from && to) {
      diffArgs.push(`${from}..${to}`);
    } else if (from) {
      diffArgs.push(from);
    }

    if (Array.isArray(paths) && paths.length > 0) {
      diffArgs.push("--", ...paths);
    }

    const [diffText, summary] = await Promise.all([
      git.diff(diffArgs),
      git.diffSummary(diffArgs),
    ]);

    return {
      success: true,
      logId,
      diff: diffText,
      summary: {
        files: summary.files.map((f) => ({
          file: f.file,
          changes: f.changes,
          insertions: f.insertions,
          deletions: f.deletions,
          binary: f.binary,
        })),
        insertions: summary.insertions,
        deletions: summary.deletions,
      },
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to get Git diff", { logId, error: e.message });
    throw new SystemError("Failed to get Git diff", { originalError: e.message });
  }
}

// ──────────────────────────── reset ────────────────────────────

/**
 * 重置 HEAD 到指定版本
 * - soft:  HEAD 移到 target，后续 commit 的改动保留在暂存区（staged）
 * - mixed: HEAD 移到 target，后续 commit 的改动变为 unstaged
 * - hard:  HEAD 移到 target，暂存区和工作区全部恢复到 target 状态，后续改动丢失
 */
async function reset(options = {}) {
  const { target, mode = "mixed" } = options;
  if (!target) {
    throw new ValidationError("Reset target cannot be empty", { field: "target" });
  }
  if (!["soft", "mixed", "hard"].includes(mode)) {
    throw new ValidationError("Mode must be soft, mixed or hard", { field: "mode" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    // 记录当前 HEAD，便于撤销
    const currentLog = await git.log({ maxCount: 1 });
    const previousHead = currentLog.latest ? currentLog.latest.hash : null;

    await git.reset([`--${mode}`, target]);

    log(logId, "INFO", "Git reset successful", {
      logId, target, mode, previousHead,
    });

    return {
      success: true,
      message: `Reset (${mode}) to ${target} successful`,
      logId,
      target,
      mode,
      previousHead,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to reset", { logId, target, mode, error: e.message });
    throw new SystemError("Failed to reset", { originalError: e.message });
  }
}

// ──────────────────────────── checkout ────────────────────────────

/**
 * 将 target 版本的文件检出到工作区和暂存区，HEAD 不动
 * 暂存区中的 staged 变更为后续 commit 改动的反向，可直接 commit 生成回滚提交
 */
async function checkout(options = {}) {
  const { target } = options;
  if (!target) {
    throw new ValidationError("Checkout target cannot be empty", { field: "target" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    await git.raw(["checkout", target, "--", "."]);

    log(logId, "INFO", "Git checkout files successful", { logId, target });

    return {
      success: true,
      message: `Checkout files from ${target} successful`,
      logId,
      target,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to checkout files", { logId, target, error: e.message });
    throw new SystemError("Failed to checkout files", { originalError: e.message });
  }
}

// ──────────────────────────── revert ────────────────────────────

/**
 * 创建新提交来撤销指定 commit 的改动，不修改历史
 */
async function revert(options = {}) {
  const { target } = options;
  if (!target) {
    throw new ValidationError("Revert target cannot be empty", { field: "target" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    await git.revert(target);

    log(logId, "INFO", "Git revert successful", { logId, target });

    return {
      success: true,
      message: `Revert ${target} successful`,
      logId,
      target,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to revert", { logId, target, error: e.message });
    throw new SystemError("Failed to revert", { originalError: e.message });
  }
}

// ──────────────────────────── tags ────────────────────────────

/**
 * 列出标签
 */
async function listTags(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const tagsResult = await git.tags();
    return {
      success: true,
      logId,
      tags: tagsResult.all,
      latest: tagsResult.latest,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to list tags", { logId, error: e.message });
    throw new SystemError("Failed to list tags", { originalError: e.message });
  }
}

/**
 * 创建标签
 */
async function createTag(options = {}) {
  const { tagName, message: tagMessage } = options;
  if (!tagName) {
    throw new ValidationError("Tag name cannot be empty", { field: "tagName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    if (tagMessage) {
      await git.addAnnotatedTag(tagName, tagMessage);
    } else {
      await git.addTag(tagName);
    }

    log(logId, "INFO", "Git tag created", { logId, tagName, annotated: !!tagMessage });
    return { success: true, message: "Tag created successfully", logId, tagName };
  } catch (e) {
    log(logId, "ERROR", "Failed to create tag", { logId, tagName, error: e.message });
    throw new SystemError("Failed to create tag", { originalError: e.message });
  }
}

/**
 * 删除标签
 */
async function deleteTag(options = {}) {
  const { tagName } = options;
  if (!tagName) {
    throw new ValidationError("Tag name cannot be empty", { field: "tagName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    await git.tag(["-d", tagName]);

    log(logId, "INFO", "Git tag deleted", { logId, tagName });
    return { success: true, message: "Tag deleted successfully", logId, tagName };
  } catch (e) {
    log(logId, "ERROR", "Failed to delete tag", { logId, tagName, error: e.message });
    throw new SystemError("Failed to delete tag", { originalError: e.message });
  }
}

// ──────────────────────────── branches ────────────────────────────

/**
 * 列出分支
 */
async function listBranches(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const branchResult = await git.branch();

    return {
      success: true,
      logId,
      branches: branchResult.branches,
      current: branchResult.current,
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to list branches", { logId, error: e.message });
    throw new SystemError("Failed to list branches", { originalError: e.message });
  }
}

/**
 * 创建分支
 */
async function createBranch(options = {}) {
  const { branchName, startPoint } = options;
  if (!branchName) {
    throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    if (startPoint) {
      await git.checkoutBranch(branchName, startPoint);
    } else {
      await git.checkoutLocalBranch(branchName);
    }

    log(logId, "INFO", "Git branch created", { logId, branchName, startPoint });
    return { success: true, message: "Branch created and switched to", logId, branchName };
  } catch (e) {
    log(logId, "ERROR", "Failed to create branch", { logId, branchName, error: e.message });
    throw new SystemError("Failed to create branch", { originalError: e.message });
  }
}

/**
 * 切换分支（安全：检查工作区是否 clean）
 */
async function switchBranch(options = {}) {
  const { branchName } = options;
  if (!branchName) {
    throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    // 检查工作区是否 clean
    const statusResult = await git.status();
    if (!statusResult.isClean()) {
      throw new BusinessError(
        "Working directory is not clean, please commit or stash your changes before switching branches",
        {
          staged: statusResult.staged,
          modified: statusResult.modified,
          untracked: statusResult.not_added,
        }
      );
    }

    await git.checkout(branchName);

    log(logId, "INFO", "Git branch switched", { logId, branchName });
    return { success: true, message: "Branch switched successfully", logId, branchName };
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    log(logId, "ERROR", "Failed to switch branch", { logId, branchName, error: e.message });
    throw new SystemError("Failed to switch branch", { originalError: e.message });
  }
}

/**
 * 删除分支
 */
async function deleteBranch(options = {}) {
  const { branchName, force = false } = options;
  if (!branchName) {
    throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    // 不允许删除当前分支
    const statusResult = await git.status();
    if (statusResult.current === branchName) {
      throw new BusinessError("Cannot delete the current branch, please switch to another branch first");
    }

    if (force) {
      await git.deleteLocalBranch(branchName, true);
    } else {
      await git.deleteLocalBranch(branchName);
    }

    log(logId, "INFO", "Git branch deleted", { logId, branchName, force });
    return { success: true, message: "Branch deleted successfully", logId, branchName };
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    log(logId, "ERROR", "Failed to delete branch", { logId, branchName, error: e.message });
    throw new SystemError("Failed to delete branch", { originalError: e.message });
  }
}

// ──────────────────────────── stash ────────────────────────────

/**
 * 暂存更改
 */
async function stashPush(options = {}) {
  const { message: stashMessage } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const stashArgs = ["push"];
    if (stashMessage) {
      stashArgs.push("-m", stashMessage);
    }
    await git.stash(stashArgs);

    log(logId, "INFO", "Git stash push", { logId, stashMessage });
    return { success: true, message: "Changes stashed successfully", logId };
  } catch (e) {
    log(logId, "ERROR", "Failed to stash", { logId, error: e.message });
    throw new SystemError("Failed to stash changes", { originalError: e.message });
  }
}

/**
 * 恢复暂存
 */
async function stashPop(options = {}) {
  const { index } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);

    if (index !== undefined && index !== null) {
      await git.stash(["pop", `stash@{${Number(index)}}`]);
    } else {
      await git.stash(["pop"]);
    }

    log(logId, "INFO", "Git stash pop", { logId, index });
    return { success: true, message: "Stash restored successfully", logId };
  } catch (e) {
    log(logId, "ERROR", "Failed to pop stash", { logId, index, error: e.message });
    throw new SystemError("Failed to pop stash", { originalError: e.message });
  }
}

/**
 * 暂存列表
 */
async function stashList(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const git = getGitInstance(targetPath);
    const stashResult = await git.stashList();

    const stashes = stashResult.all.map((entry) => ({
      hash: entry.hash,
      message: entry.message,
      date: entry.date,
    }));

    return { success: true, logId, stashes, total: stashes.length };
  } catch (e) {
    log(logId, "ERROR", "Failed to list stashes", { logId, error: e.message });
    throw new SystemError("Failed to list stashes", { originalError: e.message });
  }
}

export {
  init,
  status,
  commit,
  unstage,
  discard,
  logHistory,
  diff,
  reset,
  checkout,
  revert,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  stashPush,
  stashPop,
  stashList,
};

export default {
  init,
  status,
  commit,
  unstage,
  discard,
  logHistory,
  diff,
  reset,
  checkout,
  revert,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  stashPush,
  stashPop,
  stashList,
};
