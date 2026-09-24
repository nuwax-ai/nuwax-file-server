import { resolveWorkspaceDir, WORKSPACE_TYPE } from "../utils/computer/workspaceContext.js";
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
  isGitRepo,
  ensureGitRepo,
  initRepo,
  getStatus,
  addAll,
  commitAllChanges,
  commitFiles,
  stageFiles,
  unstageFiles,
  discardChanges,
  getLog,
  getDiff,
  getFileContentAtRef,
  resetTo,
  revertToTree,
  checkoutFiles,
  listTags as gitListTags,
  createTag as gitCreateTag,
  deleteTag as gitDeleteTag,
  listBranches as gitListBranches,
  createBranch as gitCreateBranch,
  switchBranch as gitSwitchBranch,
  deleteBranch as gitDeleteBranch,
} from "../utils/git/gitUtils.js";

/**
 * 解析目标路径并检查是否存在。
 * workspaceType 词表统一四值（与 /computer/* 同一套）：
 *   - "pageApp"：网页应用项目，项目隔离模型，用 projectId + isolationContext 定位
 *   - "userApp" / "normalProject" / "taskAgent"：会话工作区，workspacePath（显式绑定目录）优先，
 *     缺省按类型默认规则定位（userApp → {USERAPP_WORKSPACE_DIR}/{appId}，
 *     normalProject → {COMPUTER_WORKSPACE_DIR}/{userId}/normalProject/{projectId}（小写，与
 *     workspaceContext.resolveWorkspaceDir 及沙箱侧布局一致），
 *     taskAgent → {COMPUTER_WORKSPACE_DIR}/{userId}/{cId}）
 *
 * @param {Object} options
 * @param {"userApp"|"pageApp"|"normalProject"|"taskAgent"} [options.workspaceType]
 * @param {string} [options.projectId]       pageApp 模式必传
 * @param {Object} [options.isolationContext]
 * @param {string} [options.userId]          会话工作区模式必传
 * @param {string} [options.cId]             会话工作区模式必传
 * @returns {{ targetPath: string, logId: string }}
 */
function resolveAndCheck(options) {
  const {
    workspaceType: rawWorkspaceType,
    projectId, isolationContext,
    userId, cId,
    serviceContext,
  } = options || {};

  // 类型来源：serviceContext 归一结果（x-workspace-type header / body / query，见 workspaceContext）优先，
  // 显式 workspaceType 参数兜底；大小写不敏感归一，无法归一直接报错（git 含破坏性操作，不做缺省猜测）
  const normalizeType = (t) => {
    const key = String(t || "").trim().toLowerCase();
    return Object.values(WORKSPACE_TYPE).find((v) => v.toLowerCase() === key) || "";
  };
  const workspaceType = (serviceContext && serviceContext.workspaceType) || normalizeType(rawWorkspaceType);
  if (!workspaceType) {
    throw new ValidationError(
      "workspaceType is required and must be one of userApp, pageApp, normalProject, taskAgent",
      { field: "workspaceType" }
    );
  }

  // pageApp：项目隔离模型，不走会话工作区规则
  if (workspaceType === WORKSPACE_TYPE.PAGEAPP) {
    if (!projectId) {
      throw new ValidationError("pageApp mode requires projectId", { field: "projectId" });
    }
    const targetPath = resolveProjectPath(projectId, isolationContext || {});
    if (!fs.existsSync(targetPath)) {
      throw new ResourceError("Project does not exist", { projectId });
    }
    return { targetPath, logId: projectId };
  }

  // userApp / normalProject / taskAgent：会话工作区
  if (!userId || !cId) {
    throw new ValidationError("conversation workspace mode requires userId and cId", { field: "userId/cId" });
  }
  // serviceContext 解析失败（缺参/非法目录等）时按显式类型兜底组装定位上下文
  const service = serviceContext || {
    workspaceType,
    isUserApp: workspaceType === WORKSPACE_TYPE.USERAPP,
    isNormalProject: workspaceType === WORKSPACE_TYPE.NORMAL_PROJECT,
  };
  // 项目类型无显式目录时，必须有 appId(projectId) 才能按类型默认规则定位
  if ((service.isUserApp || service.isNormalProject) && !service.workspacePath && !service.appId) {
    throw new ValidationError(
      `appId(projectId) is required for ${workspaceType} workspace when workspacePath is absent`,
      { field: "appId" }
    );
  }
  // workspacePath 优先（resolveWorkspaceDir 内），缺省按类型默认规则
  const targetPath = resolveWorkspaceDir(service, userId, cId);
  if (!fs.existsSync(targetPath)) {
    throw new ResourceError("Workspace does not exist", { userId, cId, targetPath, workspaceType });
  }
  return { targetPath, logId: `computer:${userId}:${cId}` };
}

/**
 * 将底层带 code 的错误映射为业务/校验错误，其余包装为 SystemError
 * @param {unknown} e
 * @param {string} logId
 * @param {string} action
 * @param {object} [extra]
 */
function rethrowGitError(e, logId, action, extra = {}) {
  if (
    e instanceof ValidationError ||
    e instanceof BusinessError ||
    e instanceof ResourceError
  ) {
    throw e;
  }
  const code = e && typeof e === "object" && "code" in e ? e.code : null;
  if (code === "VALIDATION") {
    const details = { ...extra };
    if (e && typeof e === "object") {
      if (e.field != null) details.field = e.field;
      if (e.target != null) details.target = e.target;
    }
    throw new ValidationError(e.message || "Validation failed", details);
  }
  if (code === "BUSINESS") {
    throw new BusinessError(e.message || "Business error", {
      ...(e && typeof e === "object" && e.staged != null ? { staged: e.staged } : {}),
      ...(e && typeof e === "object" && e.modified != null
        ? { modified: e.modified }
        : {}),
      ...extra,
    });
  }
  log(logId, "ERROR", `Failed to ${action}`, { logId, error: e.message, ...extra });
  throw new SystemError(`Failed to ${action}`, { originalError: e.message });
}

// ──────────────────────────── init ────────────────────────────

/**
 * 初始化 Git 仓库（幂等）
 */
async function init(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);

  if (isGitRepo(targetPath)) {
    return { success: true, message: "Git repository already initialized", logId, alreadyExists: true };
  }

  try {
    await initRepo(targetPath);
    log(logId, "INFO", "Git repository initialized", { logId, targetPath });
    return { success: true, message: "Git repository initialized successfully", logId, alreadyExists: false };
  } catch (e) {
    rethrowGitError(e, logId, "initialize Git repository");
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
    const result = await getStatus(targetPath);
    return {
      success: true,
      logId,
      current: result.current,
      staged: result.staged,
      modified: result.modified,
      created: result.created,
      deleted: result.deleted,
      untracked: result.untracked,
      conflicted: result.conflicted || [],
      ahead: result.ahead || 0,
      behind: result.behind || 0,
      tracking: result.tracking ?? null,
    };
  } catch (e) {
    rethrowGitError(e, logId, "get Git status");
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
    const author = {
      name: authorName || config.GIT_DEFAULT_AUTHOR_NAME,
      email: authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL,
    };

    let result;
    if (Array.isArray(files) && files.length > 0) {
      result = await commitFiles(targetPath, {
        message,
        files,
        authorName: author.name,
        authorEmail: author.email,
      });
    } else {
      result = await commitAllChanges(targetPath, {
        message,
        authorName: author.name,
        authorEmail: author.email,
        cache: {},
      });
    }

    if (result.nothingToCommit) {
      return { success: true, message: "Nothing to commit", logId, nothingToCommit: true };
    }

    log(logId, "INFO", "Git commit successful", {
      logId,
      commitHash: result.commitHash,
      message,
      viaNative: result.viaNative === true,
    });

    return {
      success: true,
      message: "Commit successful",
      logId,
      commit: result.commitHash,
      summary: { changes: 1 },
    };
  } catch (e) {
    rethrowGitError(e, logId, "commit");
  }
}

// ──────────────────────────── add ────────────────────────────

/**
 * 暂存文件（git add），files 为空时暂存全部变更
 */
async function add(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    if (Array.isArray(files) && files.length > 0) {
      await stageFiles(targetPath, files, { force: true });
    } else {
      await addAll(targetPath, { cache: {} });
    }

    log(logId, "INFO", "Git add successful", { logId, filesCount: files ? files.length : "all" });
    return { success: true, message: "Files staged successfully", logId };
  } catch (e) {
    rethrowGitError(e, logId, "add files");
  }
}

// ──────────────────────────── unstage ────────────────────────────

/**
 * 从暂存区撤回修改
 */
async function unstage(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const result = await unstageFiles(
      targetPath,
      Array.isArray(files) && files.length > 0 ? files : null
    );
    const label = result.files === "all" ? "all files" : "specified files";
    log(logId, "INFO", `Git unstage ${label}`, { logId, files: result.files });
    return {
      success: true,
      message:
        result.files === "all"
          ? "All files unstaged successfully"
          : "Specified files unstaged successfully",
      logId,
      files: result.files,
    };
  } catch (e) {
    rethrowGitError(e, logId, "unstage");
  }
}

// ──────────────────────────── discard ────────────────────────────

/**
 * 从暂存区撤回并丢弃工作区修改（未跟踪文件也会删除）
 */
async function discard(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const result = await discardChanges(
      targetPath,
      Array.isArray(files) && files.length > 0 ? files : null
    );

    log(logId, "INFO", "Git discard", {
      logId,
      trackedFiles: result.trackedFiles.length,
      newFiles: result.newFiles.length,
      untrackedFiles: result.untrackedFiles.length,
    });

    return {
      success: true,
      message: "Files discarded successfully",
      logId,
      discardedCount: result.discardedCount,
      trackedFiles: result.trackedFiles,
      newFiles: result.newFiles,
      untrackedFiles: result.untrackedFiles,
    };
  } catch (e) {
    rethrowGitError(e, logId, "discard");
  }
}

// ──────────────────────────── log ────────────────────────────

/**
 * 获取提交历史
 */
async function logHistory(options = {}) {
  const { maxCount: rawMax = 50, branch, skip: rawSkip = 0, filePath } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const maxCount = Math.min(Math.max(1, rawMax), 500);
    const skip = Math.max(0, rawSkip);
    const commits = await getLog(targetPath, { maxCount, skip, branch, filePath });
    return { success: true, logId, commits, total: commits.length };
  } catch (e) {
    rethrowGitError(e, logId, "get Git log");
  }
}

// ──────────────────────────── diff ────────────────────────────

/**
 * 差异对比（优先原生 git diff；无 git 时回退 isomorphic + jsdiff）
 */
async function diff(options = {}) {
  const { source = "worktree", from, to, paths } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    if (source === "commit" && !from) {
      throw new ValidationError("source=commit requires at least 'from'", { field: "from" });
    }

    const result = await getDiff(targetPath, { source, from, to, paths });
    return {
      success: true,
      logId,
      source,
      diff: result.diff,
      summary: result.summary,
    };
  } catch (e) {
    rethrowGitError(e, logId, "get Git diff", { source });
  }
}

// ──────────────────────────── file content ────────────────────────────

/**
 * 获取指定 git 版本的文件内容
 */
async function fileContent(options = {}) {
  const { ref = "HEAD", filePath } = options;
  if (!filePath) {
    throw new ValidationError("filePath is required", { field: "filePath" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const content = await getFileContentAtRef(targetPath, { ref, filePath });
    return { success: true, logId, filePath, ref, content };
  } catch (e) {
    rethrowGitError(e, logId, "get file content", { ref, filePath });
  }
}

// ──────────────────────────── reset ────────────────────────────

/**
 * 重置 HEAD 到指定版本
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
    const result = await resetTo(targetPath, { target, mode });
    log(logId, "INFO", "Git reset successful", {
      logId,
      target,
      mode,
      previousHead: result.previousHead,
    });

    return {
      success: true,
      message: `Reset (${mode}) to ${target} successful`,
      logId,
      target,
      mode,
      previousHead: result.previousHead,
    };
  } catch (e) {
    rethrowGitError(e, logId, "reset", { target, mode });
  }
}

// ──────────────────────────── revert ────────────────────────────

/**
 * 通过新建 commit 将文件树回退到 target（保留完整历史）
 */
async function revert(options = {}) {
  const { target, message, authorName, authorEmail } = options;
  if (!target) {
    throw new ValidationError("Revert target cannot be empty", { field: "target" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const revertMessage =
      message || `Revert to ${String(target).substring(0, 7)}`;
    const result = await revertToTree(targetPath, {
      target,
      message: revertMessage,
      authorName,
      authorEmail,
    });

    if (result.nothingToCommit) {
      log(logId, "INFO", "Nothing to revert, current HEAD already matches target", {
        logId,
        target: result.targetOid,
      });
      return {
        success: true,
        message: "Nothing to revert, already at target state",
        logId,
        nothingToCommit: true,
        target: result.targetOid,
      };
    }

    log(logId, "INFO", "Git revert successful", {
      logId,
      target: result.targetOid,
      commitHash: result.commitHash,
      previousHead: result.previousHead,
    });

    return {
      success: true,
      message: "Revert successful",
      logId,
      commit: result.commitHash,
      target: result.targetOid,
      previousHead: result.previousHead,
    };
  } catch (e) {
    rethrowGitError(e, logId, "revert", { target });
  }
}

// ──────────────────────────── checkout ────────────────────────────

/**
 * 将 target 版本的文件检出到工作区和暂存区，HEAD 不动
 */
async function checkout(options = {}) {
  const { target } = options;
  if (!target) {
    throw new ValidationError("Checkout target cannot be empty", { field: "target" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    await checkoutFiles(targetPath, target);
    log(logId, "INFO", "Git checkout files successful", { logId, target });
    return { success: true, message: `Checkout files from ${target} successful`, logId, target };
  } catch (e) {
    rethrowGitError(e, logId, "checkout files", { target });
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
    const tags = await gitListTags(targetPath);
    return {
      success: true,
      logId,
      tags,
      latest: tags.length > 0 ? tags[tags.length - 1] : null,
    };
  } catch (e) {
    rethrowGitError(e, logId, "list tags");
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
    await gitCreateTag(targetPath, { tagName, message: tagMessage });
    log(logId, "INFO", "Git tag created", { logId, tagName, annotated: !!tagMessage });
    return { success: true, message: "Tag created successfully", logId, tagName };
  } catch (e) {
    rethrowGitError(e, logId, "create tag", { tagName });
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
    await gitDeleteTag(targetPath, tagName);
    log(logId, "INFO", "Git tag deleted", { logId, tagName });
    return { success: true, message: "Tag deleted successfully", logId, tagName };
  } catch (e) {
    rethrowGitError(e, logId, "delete tag", { tagName });
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
    const result = await gitListBranches(targetPath);
    return {
      success: true,
      logId,
      branches: result.branches,
      current: result.current,
    };
  } catch (e) {
    rethrowGitError(e, logId, "list branches");
  }
}

/**
 * 创建分支并切换
 */
async function createBranch(options = {}) {
  const { branchName, startPoint } = options;
  if (!branchName) {
    throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    await gitCreateBranch(targetPath, { branchName, startPoint });
    log(logId, "INFO", "Git branch created", { logId, branchName, startPoint });
    return { success: true, message: "Branch created and switched to", logId, branchName };
  } catch (e) {
    rethrowGitError(e, logId, "create branch", { branchName });
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
    await gitSwitchBranch(targetPath, branchName);
    log(logId, "INFO", "Git branch switched", { logId, branchName });
    return { success: true, message: "Branch switched successfully", logId, branchName };
  } catch (e) {
    rethrowGitError(e, logId, "switch branch", { branchName });
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
    await gitDeleteBranch(targetPath, { branchName, force });
    log(logId, "INFO", "Git branch deleted", { logId, branchName, force });
    return { success: true, message: "Branch deleted successfully", logId, branchName };
  } catch (e) {
    rethrowGitError(e, logId, "delete branch", { branchName });
  }
}

export {
  init,
  status,
  commit,
  add,
  unstage,
  discard,
  logHistory,
  diff,
  fileContent,
  reset,
  revert,
  checkout,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
};

export default {
  init,
  status,
  commit,
  add,
  unstage,
  discard,
  logHistory,
  diff,
  fileContent,
  reset,
  revert,
  checkout,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
};
