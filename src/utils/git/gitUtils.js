import path from "path";
import fs from "fs";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import {
  shouldUseNativeGit,
  isNativeGitUnavailableError,
  markNativeGitMissing,
  nativeHasHead,
  nativeInit,
  nativeStatus,
  nativeAddAll,
  nativeStageFiles,
  nativeAddAllAndCommit,
  nativeCommitFiles,
  nativeUnstage,
  nativeDiscard,
  nativeLog,
  nativeDiff,
  nativeFileContent,
  nativeReset,
  nativeRevertToTree,
  nativeCheckoutFiles,
  nativeListTags,
  nativeCreateTag,
  nativeDeleteTag,
  nativeListBranches,
  nativeCreateBranch,
  nativeSwitchBranch,
  nativeDeleteBranch,
} from "./nativeGitUtils.js";
import {
  isoHasHead,
  isoInit,
  isoStatus,
  isoAddAll,
  isoStageFiles,
  isoCommitAll,
  isoCommitFiles,
  isoUnstage,
  isoDiscard,
  isoLog,
  isoDiff,
  isoFileContent,
  isoReset,
  isoRevertToTree,
  isoCheckoutFiles,
  isoListTags,
  isoCreateTag,
  isoDeleteTag,
  isoListBranches,
  isoCreateBranch,
  isoSwitchBranch,
  isoDeleteBranch,
  listWorkdirFilesSkippingIgnored,
  addAllFirstCommitWithIsomorphic,
} from "./isoGitOps.js";

/**
 * 检查目录下是否存在 .git（即是否已初始化 Git 仓库）
 * @param {string} projectPath
 * @returns {boolean}
 */
function isGitRepo(projectPath) {
  return fs.existsSync(path.join(projectPath, ".git"));
}

/**
 * 获取默认 author 对象（供 isomorphic-git commit 使用）
 * @returns {{name: string, email: string}}
 */
function getDefaultAuthor() {
  return {
    name: config.GIT_DEFAULT_AUTHOR_NAME,
    email: config.GIT_DEFAULT_AUTHOR_EMAIL,
  };
}

/**
 * 原生 git 不可用时的回退日志 + 负缓存
 * @param {string} dir
 * @param {unknown} err
 * @param {string} op
 */
function warnNativeFallback(dir, err, op) {
  markNativeGitMissing();
  const message =
    err && typeof err === "object" && "message" in err
      ? String(/** @type {{ message?: string }} */ (err).message)
      : String(err);
  log(path.basename(dir) || "git", "WARN", `Native git unavailable during ${op}, fallback to isomorphic-git`, {
    error: message,
  });
}

/**
 * 优先原生 git；仅本机无可用 git 时回退 isomorphic；其它错误直接抛出。
 * @template T
 * @param {string} dir
 * @param {string} op
 * @param {() => Promise<T>} nativeFn
 * @param {() => Promise<T>} isoFn
 * @returns {Promise<T>}
 */
async function withNativeFallback(dir, op, nativeFn, isoFn) {
  if (await shouldUseNativeGit()) {
    try {
      return await nativeFn();
    } catch (err) {
      if (!isNativeGitUnavailableError(err)) throw err;
      warnNativeFallback(dir, err, op);
    }
  }
  return isoFn();
}

/**
 * 仓库是否已有可解析的 HEAD
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasGitHead(dir) {
  return withNativeFallback(
    dir,
    "hasGitHead",
    () => nativeHasHead(dir),
    () => isoHasHead(dir)
  );
}

/**
 * 自动创建或合并 .gitignore 文件
 * @param {string} projectPath
 */
function ensureGitignore(projectPath) {
  if (!config.GIT_AUTO_GITIGNORE) return;

  const gitignorePath = path.join(projectPath, ".gitignore");
  const defaultEntries = config.GIT_GITIGNORE_ENTRIES || [];

  let existingLines = [];
  if (fs.existsSync(gitignorePath)) {
    existingLines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
  }

  const existingSet = new Set(existingLines.map((l) => l.trim()).filter(Boolean));
  const newEntries = defaultEntries.filter((entry) => !existingSet.has(entry));

  if (newEntries.length > 0) {
    const content =
      existingLines.length > 0 && existingLines[existingLines.length - 1] !== ""
        ? "\n" + newEntries.join("\n") + "\n"
        : newEntries.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, content, "utf8");
  }
}

/**
 * 初始化 Git 仓库（幂等底层：调用方需先判断 alreadyExists）
 * @param {string} dir
 * @param {{ authorName?: string, authorEmail?: string }} [options]
 */
async function initRepo(dir, options = {}) {
  const authorName = options.authorName || config.GIT_DEFAULT_AUTHOR_NAME;
  const authorEmail = options.authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL;

  await withNativeFallback(
    dir,
    "init",
    () => nativeInit(dir, { authorName, authorEmail }),
    () => isoInit(dir, { authorName, authorEmail })
  );
  ensureGitignore(dir);
}

/**
 * 确保项目已初始化 Git，未初始化则自动执行 git init 并生成 .gitignore。
 * @param {string} projectPath
 */
async function ensureGitRepo(projectPath) {
  if (!isGitRepo(projectPath)) {
    await initRepo(projectPath);
    const gitignorePath = path.join(projectPath, ".gitignore");
    const gitkeepPath = path.join(projectPath, ".gitkeep");
    if (!fs.existsSync(gitignorePath) && !fs.existsSync(gitkeepPath)) {
      fs.writeFileSync(gitkeepPath, "");
    }
  } else {
    ensureGitignore(projectPath);
  }
}

/**
 * 获取工作区状态
 * @param {string} dir
 */
async function getStatus(dir) {
  return withNativeFallback(
    dir,
    "status",
    () => nativeStatus(dir),
    () => isoStatus(dir)
  );
}

/**
 * 暂存所有变更（等价于 git add --all）。
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 */
async function addAll(dir, options = {}) {
  return withNativeFallback(
    dir,
    "addAll",
    () => nativeAddAll(dir),
    () => isoAddAll(dir, options)
  );
}

/**
 * 暂存指定文件列表
 * @param {string} dir
 * @param {string[]} files
 * @param {{ cache?: object, force?: boolean }} [options]
 */
async function stageFiles(dir, files, options = {}) {
  return withNativeFallback(
    dir,
    "stageFiles",
    () => nativeStageFiles(dir, files, options),
    () => isoStageFiles(dir, files, options)
  );
}

/**
 * 全量暂存并提交
 * @param {string} dir
 * @param {{ message: string, authorName?: string, authorEmail?: string, cache?: object }} options
 */
async function commitAllChanges(dir, options = {}) {
  const {
    message,
    authorName = config.GIT_DEFAULT_AUTHOR_NAME,
    authorEmail = config.GIT_DEFAULT_AUTHOR_EMAIL,
    cache,
  } = options;

  if (await shouldUseNativeGit()) {
    try {
      const result = await nativeAddAllAndCommit(dir, {
        message,
        authorName,
        authorEmail,
      });
      return { ...result, viaNative: true };
    } catch (err) {
      if (!isNativeGitUnavailableError(err)) throw err;
      warnNativeFallback(dir, err, "commitAllChanges");
    }
  }

  const result = await isoCommitAll(dir, {
    message,
    authorName,
    authorEmail,
    cache,
  });
  return { ...result, viaNative: false };
}

/**
 * 指定文件暂存并提交
 * @param {string} dir
 * @param {{ message: string, files: string[], authorName?: string, authorEmail?: string, cache?: object }} options
 */
async function commitFiles(dir, options) {
  const {
    message,
    files,
    authorName = config.GIT_DEFAULT_AUTHOR_NAME,
    authorEmail = config.GIT_DEFAULT_AUTHOR_EMAIL,
    cache = {},
  } = options;

  return withNativeFallback(
    dir,
    "commitFiles",
    () =>
      nativeCommitFiles(dir, {
        message,
        files,
        authorName,
        authorEmail,
        force: true,
      }),
    () =>
      isoCommitFiles(dir, {
        message,
        files,
        authorName,
        authorEmail,
        cache,
      })
  );
}

/**
 * 从暂存区撤回
 * @param {string} dir
 * @param {string[]|null} [files]
 */
async function unstageFiles(dir, files = null) {
  return withNativeFallback(
    dir,
    "unstage",
    async () => {
      await nativeUnstage(dir, files);
      return {
        files: Array.isArray(files) && files.length > 0 ? files : "all",
      };
    },
    () => isoUnstage(dir, files)
  );
}

/**
 * 丢弃工作区/暂存区变更（未跟踪也会删）
 * @param {string} dir
 * @param {string[]|null} [files]
 */
async function discardChanges(dir, files = null) {
  return withNativeFallback(
    dir,
    "discard",
    () => nativeDiscard(dir, files),
    () => isoDiscard(dir, files)
  );
}

/**
 * 提交历史
 * @param {string} dir
 * @param {{ maxCount?: number, skip?: number, branch?: string, filePath?: string }} [options]
 */
async function getLog(dir, options = {}) {
  return withNativeFallback(
    dir,
    "log",
    () => nativeLog(dir, options),
    () => isoLog(dir, options)
  );
}

/**
 * 差异对比
 * @param {string} dir
 * @param {{ source?: string, from?: string, to?: string, paths?: string[] }} [options]
 */
async function getDiff(dir, options = {}) {
  return withNativeFallback(
    dir,
    "diff",
    () => nativeDiff(dir, options),
    () => isoDiff(dir, options)
  );
}

/**
 * 读取指定版本文件内容
 * @param {string} dir
 * @param {{ ref: string, filePath: string }} options
 */
async function getFileContentAtRef(dir, options) {
  return withNativeFallback(
    dir,
    "fileContent",
    () => nativeFileContent(dir, options),
    () => isoFileContent(dir, options)
  );
}

/**
 * reset
 * @param {string} dir
 * @param {{ target: string, mode: "soft"|"mixed"|"hard" }} options
 */
async function resetTo(dir, options) {
  const result = await withNativeFallback(
    dir,
    "reset",
    () => nativeReset(dir, options),
    () => isoReset(dir, options)
  );
  if (options.mode === "hard") {
    ensureGitignore(dir);
    // 避免 ensureGitignore 追加后 .gitignore 处于 modified
    try {
      await stageFiles(dir, [".gitignore"], { force: true });
    } catch (_) {
      // .gitignore 可能不存在（AUTO_GITIGNORE 关闭）
    }
  }
  return result;
}

/**
 * 树对齐 revert（新建 commit）
 * 在底层树同步之后、提交之前注入 ensureGitignore，避免 clean 检查前弄脏工作区。
 * @param {string} dir
 * @param {{ target: string, message: string, authorName?: string, authorEmail?: string }} options
 */
async function revertToTree(dir, options) {
  const authorName = options.authorName || config.GIT_DEFAULT_AUTHOR_NAME;
  const authorEmail = options.authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL;
  const message =
    options.message || `Revert to ${String(options.target).substring(0, 7)}`;

  const beforeCommit = async () => {
    ensureGitignore(dir);
    try {
      await stageFiles(dir, [".gitignore"], { force: true });
    } catch (_) {}
  };

  return withNativeFallback(
    dir,
    "revert",
    () =>
      nativeRevertToTree(dir, {
        target: options.target,
        message,
        authorName,
        authorEmail,
        beforeCommit,
      }),
    () =>
      isoRevertToTree(dir, {
        target: options.target,
        message,
        authorName,
        authorEmail,
        beforeCommit,
      })
  );
}

/**
 * 检出文件到 worktree+index，HEAD 不动
 * @param {string} dir
 * @param {string} target
 */
async function checkoutFiles(dir, target) {
  await withNativeFallback(
    dir,
    "checkoutFiles",
    () => nativeCheckoutFiles(dir, target),
    () => isoCheckoutFiles(dir, target)
  );
  ensureGitignore(dir);
  try {
    await stageFiles(dir, [".gitignore"], { force: true });
  } catch (_) {}
}

/**
 * @param {string} dir
 */
async function listTags(dir) {
  return withNativeFallback(
    dir,
    "listTags",
    () => nativeListTags(dir),
    () => isoListTags(dir)
  );
}

/**
 * @param {string} dir
 * @param {{ tagName: string, message?: string }} options
 */
async function createTag(dir, options) {
  const author = getDefaultAuthor();
  return withNativeFallback(
    dir,
    "createTag",
    () =>
      nativeCreateTag(dir, {
        ...options,
        authorName: author.name,
        authorEmail: author.email,
      }),
    () =>
      isoCreateTag(dir, {
        ...options,
        authorName: author.name,
        authorEmail: author.email,
      })
  );
}

/**
 * @param {string} dir
 * @param {string} tagName
 */
async function deleteTag(dir, tagName) {
  return withNativeFallback(
    dir,
    "deleteTag",
    () => nativeDeleteTag(dir, tagName),
    () => isoDeleteTag(dir, tagName)
  );
}

/**
 * @param {string} dir
 */
async function listBranches(dir) {
  return withNativeFallback(
    dir,
    "listBranches",
    () => nativeListBranches(dir),
    () => isoListBranches(dir)
  );
}

/**
 * @param {string} dir
 * @param {{ branchName: string, startPoint?: string }} options
 */
async function createBranch(dir, options) {
  return withNativeFallback(
    dir,
    "createBranch",
    () => nativeCreateBranch(dir, options),
    () => isoCreateBranch(dir, options)
  );
}

/**
 * @param {string} dir
 * @param {string} branchName
 */
async function switchBranch(dir, branchName) {
  return withNativeFallback(
    dir,
    "switchBranch",
    () => nativeSwitchBranch(dir, branchName),
    () => isoSwitchBranch(dir, branchName)
  );
}

/**
 * @param {string} dir
 * @param {{ branchName: string, force?: boolean }} options
 */
async function deleteBranch(dir, options) {
  return withNativeFallback(
    dir,
    "deleteBranch",
    () => nativeDeleteBranch(dir, options),
    () => isoDeleteBranch(dir, options)
  );
}

/**
 * 文件操作后自动 git add，非阻塞（失败不影响主流程）
 * @param {string} projectPath
 * @param {string[]|null} files
 */
async function autoGitAdd(projectPath, files) {
  if (!isGitRepo(projectPath)) return;
  try {
    if (Array.isArray(files) && files.length > 0) {
      await stageFiles(projectPath, files);
    } else {
      await addAll(projectPath);
    }
  } catch (_) {
    // non-blocking
  }
}

export {
  isGitRepo,
  ensureGitRepo,
  ensureGitignore,
  autoGitAdd,
  addAll,
  isoAddAll as addAllWithIsomorphic,
  commitAllChanges,
  commitFiles,
  stageFiles,
  getDefaultAuthor,
  hasGitHead,
  listWorkdirFilesSkippingIgnored,
  withNativeFallback,
  initRepo,
  getStatus,
  unstageFiles,
  discardChanges,
  getLog,
  getDiff,
  getFileContentAtRef,
  resetTo,
  revertToTree,
  checkoutFiles,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
};
