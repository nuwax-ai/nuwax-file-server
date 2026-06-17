import path from "path";
import fs from "fs";
import crypto from "crypto";
import git from "isomorphic-git";
import { createPatch } from "diff";
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
  ensureGitignore,
  addAll,
  getDefaultAuthor,
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

// ──────────────────────────── helpers ────────────────────────────

/**
 * 检测 buffer 是否为二进制内容（前 8000 字节中是否包含 \0）
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinaryBuffer(buf) {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 计算 git blob hash（SHA1 of "blob <size>\0<content>"）
 * @param {Buffer} buf
 * @returns {string} 40 字符的 hex hash
 */
function gitBlobHash(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`);
  return crypto.createHash("sha1").update(Buffer.concat([header, buf])).digest("hex");
}

/**
 * 生成 git diff 格式的差异文本并统计行数变更。
 * createPatch 生成 unified diff，但头部格式与 git diff 不同（Index:/===  vs diff --git）。
 * 这里保留 createPatch 的 hunk 内容不变，替换头部为 git diff 格式。
 *
 * @param {string} filepath  文件相对路径
 * @param {string} oldContent  旧内容（文本）
 * @param {string} newContent  新内容（文本）
 * @param {boolean} hasOld  是否存在旧版本
 * @param {boolean} hasNew  是否存在新版本
 * @param {Buffer|null} oldBuf  旧内容 Buffer（用于计算 blob hash）
 * @param {Buffer|null} newBuf  新内容 Buffer（用于计算 blob hash）
 * @returns {{ diff: string, insertions: number, deletions: number }}
 */
function makeDiffPatch(filepath, oldContent, newContent, hasOld, hasNew, oldBuf, newBuf) {
  const patch = createPatch(
    filepath,
    hasOld ? oldContent : "",
    hasNew ? newContent : "",
    hasOld ? `a/${filepath}` : "/dev/null",
    hasNew ? `b/${filepath}` : "/dev/null"
  );

  // createPatch 前 4 行是头部（Index: / === / --- / +++），第 5 行起是 hunks
  const lines = patch.split("\n");
  const rawHunks = lines.slice(4);
  if (rawHunks.length > 0 && rawHunks[rawHunks.length - 1] === "") rawHunks.pop();

  // Pass 1: 修正 @@ 行（count=1 时省略），统计增删行数
  const fixedHunks = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of rawHunks) {
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        const oldStart = m[1];
        const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        const newStart = m[3];
        const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;
        const oldPart = oldLines === 1 ? oldStart : `${oldStart},${oldLines}`;
        const newPart = newLines === 1 ? newStart : `${newStart},${newLines}`;
        fixedHunks.push(`@@ -${oldPart} +${newPart} @@`);
        continue;
      }
    }
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    fixedHunks.push(line);
  }

  // Pass 2: 在最后一个 hunk 的尾部补充 \ No newline at end of file
  const oldNoNewline = hasOld && oldContent !== "" && !oldContent.endsWith("\n");
  const newNoNewline = hasNew && newContent !== "" && !newContent.endsWith("\n");

  if ((oldNoNewline || newNoNewline) && fixedHunks.length > 0) {
    // 找到最后一个 hunk 的起始位置
    let lastHunkStart = 0;
    for (let i = 0; i < fixedHunks.length; i++) {
      if (fixedHunks[i].startsWith("@@")) lastHunkStart = i;
    }
    // 在最后一个 hunk 中，从后往前找最后一行各类型的位置
    let lastDel = -1, lastAdd = -1, lastCtx = -1;
    for (let i = fixedHunks.length - 1; i > lastHunkStart; i--) {
      const l = fixedHunks[i];
      if (l.startsWith("-") && !l.startsWith("---") && lastDel < 0) lastDel = i;
      else if (l.startsWith("+") && !l.startsWith("++") && lastAdd < 0) lastAdd = i;
      else if (l.startsWith(" ") && lastCtx < 0) lastCtx = i;
    }
    const lastIdx = Math.max(lastDel, lastAdd, lastCtx);

    if (lastIdx >= 0) {
      const lastLine = fixedHunks[lastIdx];
      if (lastLine.startsWith(" ")) {
        // 上下文行：新旧两侧内容相同
        if (oldNoNewline || newNoNewline) {
          fixedHunks.splice(lastIdx + 1, 0, "\\ No newline at end of file");
        }
      } else if (lastLine.startsWith("+")) {
        // 新增行结尾：找前面最近的 - 行判断是否是替换
        let prevIdx = -1;
        for (let i = lastIdx - 1; i > lastHunkStart; i--) {
          if (fixedHunks[i].startsWith("-") && !fixedHunks[i].startsWith("---")) { prevIdx = i; break; }
        }
        if (prevIdx >= 0 && oldNoNewline) {
          fixedHunks.splice(prevIdx + 1, 0, "\\ No newline at end of file");
          if (newNoNewline) fixedHunks.splice(lastIdx + 2, 0, "\\ No newline at end of file");
        } else if (newNoNewline) {
          fixedHunks.splice(lastIdx + 1, 0, "\\ No newline at end of file");
        }
      } else if (lastLine.startsWith("-") && oldNoNewline) {
        fixedHunks.splice(lastIdx + 1, 0, "\\ No newline at end of file");
      }
    }
  }

  // 构建 git diff 头部
  const oldHash = hasOld && oldBuf ? gitBlobHash(oldBuf).substring(0, 7) : "0000000";
  const newHash = hasNew && newBuf ? gitBlobHash(newBuf).substring(0, 7) : "0000000";

  const header = [];
  header.push(`diff --git a/${filepath} b/${filepath}`);

  if (!hasOld) {
    header.push("new file mode 100644");
    header.push(`index 0000000..${newHash}`);
  } else if (!hasNew) {
    header.push("deleted file mode 100644");
    header.push(`index ${oldHash}..0000000`);
  } else {
    header.push(`index ${oldHash}..${newHash} 100644`);
  }

  header.push(`--- ${hasOld ? `a/${filepath}` : "/dev/null"}`);
  header.push(`+++ ${hasNew ? `b/${filepath}` : "/dev/null"}`);

  const gitDiff = [...header, ...fixedHunks].join("\n") + "\n";
  return { diff: gitDiff, insertions, deletions };
}

/**
 * 获取 HEAD commit OID
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function getHeadOid(dir) {
  return git.resolveRef({ fs, dir, ref: "HEAD" });
}

/**
 * 从指定 commit 读取某文件的文本内容
 * @param {string} dir
 * @param {string} commitOid
 * @param {string} filepath
 * @returns {Promise<{content: string, buf: Buffer} | null>} null 表示文件不存在
 */
async function readFileAtCommit(dir, commitOid, filepath) {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: commitOid, filepath });
    const buf = Buffer.from(blob);
    return { content: buf.toString("utf8"), buf };
  } catch (_) {
    return null;
  }
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
    await git.init({ fs, dir: targetPath, defaultBranch: "main" });
    ensureGitignore(targetPath);

    await git.setConfig({ fs, dir: targetPath, path: "user.name", value: config.GIT_DEFAULT_AUTHOR_NAME });
    await git.setConfig({ fs, dir: targetPath, path: "user.email", value: config.GIT_DEFAULT_AUTHOR_EMAIL });

    log(logId, "INFO", "Git repository initialized", { logId, targetPath });
    return { success: true, message: "Git repository initialized successfully", logId, alreadyExists: false };
  } catch (e) {
    log(logId, "ERROR", "Failed to initialize Git repository", { logId, error: e.message });
    throw new SystemError("Failed to initialize Git repository", { originalError: e.message });
  }
}

// ──────────────────────────── status ────────────────────────────

/**
 * 获取工作区状态（基于 statusMatrix 解析）
 */
async function status(options = {}) {
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const current = await git.currentBranch({ fs, dir: targetPath, fullname: false });
    const matrix = await git.statusMatrix({ fs, dir: targetPath });

    const staged = [];
    const modified = [];
    const created = [];
    const deleted = [];
    const untracked = [];

    for (const [f, H, W, S] of matrix) {
      // 暂存区变更（index vs HEAD）
      if (S === 3) {
        staged.push(f);
        created.push(f);
      } else if (S === 2) {
        staged.push(f);
      } else if (S === 0 && H === 1) {
        staged.push(f);
        deleted.push(f);
      }

      // 工作区变更（workdir vs index，仅针对 index 中已存在的文件）
      if (W === 2 && S !== 0) {
        modified.push(f);
      } else if (W === 0 && S !== 0) {
        deleted.push(f);
      }

      // 未跟踪文件（不在 index 中但在工作区存在）
      if (S === 0 && W !== 0) {
        untracked.push(f);
      }
    }

    return {
      success: true,
      logId,
      current,
      staged: [...new Set(staged)],
      modified: [...new Set(modified)],
      created: [...new Set(created)],
      deleted: [...new Set(deleted)],
      untracked: [...new Set(untracked)],
      conflicted: [],
      ahead: 0,
      behind: 0,
      tracking: null,
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
    // 暂存文件
    if (Array.isArray(files) && files.length > 0) {
      const existingFiles = files.filter((f) => fs.existsSync(path.join(targetPath, f)));
      await Promise.all(
        existingFiles.map((f) => git.add({ fs, dir: targetPath, filepath: f }))
      );
    } else {
      await addAll(targetPath);
    }

    // 检查是否有可提交的变更
    const matrix = await git.statusMatrix({ fs, dir: targetPath });
    const hasChanges = matrix.some(([, , , S]) => S !== 1);
    if (!hasChanges) {
      return { success: true, message: "Nothing to commit", logId, nothingToCommit: true };
    }

    const author = {
      name: authorName || config.GIT_DEFAULT_AUTHOR_NAME,
      email: authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL,
    };

    const commitHash = await git.commit({
      fs,
      dir: targetPath,
      message,
      author,
    });

    log(logId, "INFO", "Git commit successful", { logId, commitHash, message });

    return {
      success: true,
      message: "Commit successful",
      logId,
      commit: commitHash,
      summary: { changes: hasChanges ? 1 : 0 },
    };
  } catch (e) {
    log(logId, "ERROR", "Failed to commit", { logId, error: e.message });
    throw new SystemError("Failed to commit", { originalError: e.message });
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
      await Promise.all(
        files.map((f) => git.add({ fs, dir: targetPath, filepath: f }))
      );
    } else {
      await addAll(targetPath);
    }

    log(logId, "INFO", "Git add successful", { logId, filesCount: files ? files.length : "all" });
    return { success: true, message: "Files staged successfully", logId };
  } catch (e) {
    log(logId, "ERROR", "Failed to add files", { logId, error: e.message });
    throw new SystemError("Failed to add files", { originalError: e.message });
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
    if (Array.isArray(files) && files.length > 0) {
      for (const f of files) {
        await git.resetIndex({ fs, dir: targetPath, filepath: f });
      }
      log(logId, "INFO", "Git unstage specified files", { logId, files });
      return { success: true, message: "Specified files unstaged successfully", logId, files };
    }

    // 撤回全部：找出所有已暂存的文件并 resetIndex
    const matrix = await git.statusMatrix({ fs, dir: targetPath });
    const stagedFiles = matrix.filter(([, , , S]) => S !== 1).map(([f]) => f);
    for (const f of stagedFiles) {
      await git.resetIndex({ fs, dir: targetPath, filepath: f });
    }
    log(logId, "INFO", "Git unstage all files", { logId });
    return { success: true, message: "All files unstaged successfully", logId, files: "all" };
  } catch (e) {
    log(logId, "ERROR", "Failed to unstage", { logId, error: e.message });
    throw new SystemError("Failed to unstage files", { originalError: e.message });
  }
}

// ──────────────────────────── discard ────────────────────────────

/**
 * 清理因删除文件而产生的空目录。
 */
async function cleanEmptyParentDirs(root, relativeFiles) {
  const dirSet = new Set();
  for (const f of relativeFiles) {
    let dir = path.dirname(f);
    while (dir && dir !== ".") {
      dirSet.add(dir);
      dir = path.dirname(dir);
    }
  }

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
 */
async function discard(options = {}) {
  const { files } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const matrix = await git.statusMatrix({ fs, dir: targetPath });

    const targetSet = Array.isArray(files) && files.length > 0 ? new Set(files) : null;

    const trackedToRestore = [];
    const newFilesToRemove = [];
    const untrackedToDelete = [];

    for (const [f, H, W, S] of matrix) {
      if (targetSet && !targetSet.has(f)) continue;

      if (H !== 0) {
        // 已跟踪文件：若 index 或 workdir 与 HEAD 不一致，需要 checkout
        if (S !== 1 || W !== 1) {
          trackedToRestore.push(f);
        }
      } else if (H === 0 && S !== 0) {
        // 暂存区中的新增文件（从未 commit 过）
        newFilesToRemove.push(f);
      } else if (H === 0 && S === 0 && W !== 0) {
        // 未跟踪文件
        untrackedToDelete.push(f);
      }
    }

    // 1) 已跟踪文件：从 HEAD 读取内容，写回 workdir 和 index
    const headOid = await getHeadOid(targetPath);
    for (const f of trackedToRestore) {
      const result = await readFileAtCommit(targetPath, headOid, f);
      if (!result) continue;
      const fullPath = path.join(targetPath, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, result.buf);
      await git.add({ fs, dir: targetPath, filepath: f });
    }

    // 2) 新增文件（暂存区）：从 index 移除 + 从磁盘删除
    for (const f of newFilesToRemove) {
      try {
        await git.remove({ fs, dir: targetPath, filepath: f });
      } catch (_) {}
      const absPath = path.join(targetPath, f);
      if (fs.existsSync(absPath)) {
        await fs.promises.unlink(absPath);
      }
    }
    if (newFilesToRemove.length > 0) {
      await cleanEmptyParentDirs(targetPath, newFilesToRemove);
    }

    // 3) 未跟踪文件：直接从磁盘删除
    for (const f of untrackedToDelete) {
      const absPath = path.join(targetPath, f);
      if (fs.existsSync(absPath)) {
        await fs.promises.unlink(absPath);
      }
    }
    if (untrackedToDelete.length > 0) {
      await cleanEmptyParentDirs(targetPath, untrackedToDelete);
    }

    const discardedCount = trackedToRestore.length + newFilesToRemove.length + untrackedToDelete.length;
    log(logId, "INFO", "Git discard", {
      logId,
      trackedFiles: trackedToRestore.length,
      newFiles: newFilesToRemove.length,
      untrackedFiles: untrackedToDelete.length,
    });

    return {
      success: true,
      message: "Files discarded successfully",
      logId,
      discardedCount,
      trackedFiles: trackedToRestore,
      newFiles: newFilesToRemove,
      untrackedFiles: untrackedToDelete,
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
  const { maxCount: rawMax = 50, branch, skip: rawSkip = 0, filePath } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const maxCount = Math.min(Math.max(1, rawMax), 500);
    const skip = Math.max(0, rawSkip);

    const logArgs = {
      fs,
      dir: targetPath,
      depth: maxCount + skip,
    };
    if (branch) logArgs.ref = branch;
    if (filePath) logArgs.filepath = filePath;

    const logResult = await git.log(logArgs);

    // 应用 skip
    const entries = logResult.slice(skip, skip + maxCount);

    const commits = entries.map((entry) => ({
      hash: entry.oid,
      date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
      message: entry.commit.message,
      author_name: entry.commit.author.name,
      author_email: entry.commit.author.email,
    }));

    return { success: true, logId, commits, total: commits.length };
  } catch (e) {
    log(logId, "ERROR", "Failed to get Git log", { logId, error: e.message });
    throw new SystemError("Failed to get Git log", { originalError: e.message });
  }
}

// ──────────────────────────── diff ────────────────────────────

/**
 * 差异对比（基于 isomorphic-git listFiles/readBlob + jsdiff 实现）
 *
 * @param {Object} options
 * @param {"worktree"|"staged"|"commit"} [options.source] 对比来源：
 *   - "worktree": 工作区 vs HEAD（默认）
 *   - "staged":   暂存区 vs HEAD（git diff --cached）
 *   - "commit":   两个 commit 之间的对比，需配合 from/to 使用
 * @param {string} [options.from] commit hash（source=commit 时使用）
 * @param {string} [options.to]   commit hash（source=commit 时使用）
 * @param {string[]} [options.paths] 限定文件范围
 */
async function diff(options = {}) {
  const { source = "worktree", from, to, paths } = options;
  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const pathFilter = Array.isArray(paths) && paths.length > 0 ? new Set(paths) : null;
    let diffText = "";
    const summaryFiles = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    /**
     * 处理单个文件的 diff 并累积结果
     */
    async function processFile(filepath, oldResult, newResult) {
      const hasOld = !!oldResult;
      const hasNew = !!newResult;

      // 检查内容是否相同
      if (hasOld && hasNew && oldResult.content === newResult.content) return;

      let isBinary = false;
      if (hasOld && isBinaryBuffer(oldResult.buf)) isBinary = true;
      if (hasNew && !isBinary && isBinaryBuffer(newResult.buf)) isBinary = true;

      if (isBinary) {
        const oldHash = hasOld ? gitBlobHash(oldResult.buf).substring(0, 7) : "0000000";
        const newHash = hasNew ? gitBlobHash(newResult.buf).substring(0, 7) : "0000000";
        const binHeader = [`diff --git a/${filepath} b/${filepath}`];
        if (!hasOld) {
          binHeader.push("new file mode 100644");
          binHeader.push(`index 0000000..${newHash}`);
        } else if (!hasNew) {
          binHeader.push("deleted file mode 100644");
          binHeader.push(`index ${oldHash}..0000000`);
        } else {
          binHeader.push(`index ${oldHash}..${newHash} 100644`);
        }
        binHeader.push(`Binary files ${hasOld ? `a/${filepath}` : "/dev/null"} and ${hasNew ? `b/${filepath}` : "/dev/null"} differ`);
        diffText += binHeader.join("\n") + "\n";
        summaryFiles.push({ file: filepath, changes: 0, insertions: 0, deletions: 0, binary: true });
        return;
      }

      const { diff: patch, insertions, deletions } = makeDiffPatch(
        filepath,
        hasOld ? oldResult.content : "",
        hasNew ? newResult.content : "",
        hasOld, hasNew,
        hasOld ? oldResult.buf : null,
        hasNew ? newResult.buf : null
      );
      diffText += patch;
      summaryFiles.push({ file: filepath, changes: insertions + deletions, insertions, deletions, binary: false });
      totalInsertions += insertions;
      totalDeletions += deletions;
    }

    // ── commit 模式：两个 commit 之间 ──
    if (source === "commit") {
      let fromOid, toOid;

      if (from && to) {
        fromOid = from;
        toOid = to;
      } else if (from) {
        // 只有 from：对比 from 相对其父提交的变化
        const commit = await git.readCommit({ fs, dir: targetPath, oid: from });
        if (commit.commit.parent && commit.commit.parent.length > 0) {
          fromOid = commit.commit.parent[0];
          toOid = from;
        } else {
          // 初始 commit：对比空树，所有文件都是新增
          fromOid = null;
          toOid = from;
        }
      } else {
        throw new ValidationError("source=commit requires at least 'from'", { field: "from" });
      }

      const fromFiles = fromOid
        ? new Set(await git.listFiles({ fs, dir: targetPath, ref: fromOid }))
        : new Set();
      const toFiles = new Set(await git.listFiles({ fs, dir: targetPath, ref: toOid }));
      const allFiles = new Set([...fromFiles, ...toFiles]);

      for (const f of allFiles) {
        if (pathFilter && !pathFilter.has(f)) continue;

        const oldResult = fromFiles.has(f) ? await readFileAtCommit(targetPath, fromOid, f) : null;
        const newResult = toFiles.has(f) ? await readFileAtCommit(targetPath, toOid, f) : null;

        await processFile(f, oldResult, newResult);
      }
    } else {
      // ── worktree / staged 模式：基于 statusMatrix + HEAD ──
      const headOid = await getHeadOid(targetPath);
      const matrix = await git.statusMatrix({ fs, dir: targetPath });

      for (const [f, H, W, S] of matrix) {
        if (pathFilter && !pathFilter.has(f)) continue;

        if (source === "staged") {
          // staged：只看 index vs HEAD（S !== 1），排除 untracked
          if (S === 1 || (H === 0 && S === 0)) continue;
        } else {
          // worktree：看所有与 HEAD 的差异，排除 untracked
          if (H === 0 && S === 0) continue;
          if (H === 1 && W === 1 && S === 1) continue;
        }

        // 读取 HEAD 版本
        const oldResult = H !== 0 ? await readFileAtCommit(targetPath, headOid, f) : null;

        // 读取当前版本（workdir 文件内容）
        let newResult = null;
        if (W !== 0) {
          const fullPath = path.join(targetPath, f);
          if (fs.existsSync(fullPath)) {
            try {
              const buf = fs.readFileSync(fullPath);
              newResult = { content: buf.toString("utf8"), buf };
            } catch (_) {}
          }
        }

        await processFile(f, oldResult, newResult);
      }
    }

    return {
      success: true,
      logId,
      source,
      diff: diffText,
      summary: {
        files: summaryFiles,
        insertions: totalInsertions,
        deletions: totalDeletions,
      },
    };
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    log(logId, "ERROR", "Failed to get Git diff", { logId, error: e.message });
    throw new SystemError("Failed to get Git diff", { originalError: e.message });
  }
}

// ──────────────────────────── file content ────────────────────────────

/**
 * 获取指定 git 版本的文件内容
 * @param {Object} options
 * @param {string} [options.ref] git 引用
 *   - "worktree": 读取工作区文件
 *   - "staged" 或 "": 读取暂存区文件（近似：读取工作区文件）
 *   - 其他: 读取指定版本的文件
 * @param {string} [options.filePath] 文件相对路径
 */
async function fileContent(options = {}) {
  const { ref = "HEAD", filePath } = options;
  if (!filePath) {
    throw new ValidationError("filePath is required", { field: "filePath" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    let content;

    if (ref === "worktree" || ref === "staged" || ref === "") {
      const fullPath = path.join(targetPath, filePath);
      content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    } else {
      try {
        const oid = await git.resolveRef({ fs, dir: targetPath, ref });
        const { blob } = await git.readBlob({ fs, dir: targetPath, oid, filepath: filePath });
        content = Buffer.from(blob).toString("utf8");
      } catch (_) {
        content = "";
      }
    }

    return { success: true, logId, filePath, ref, content };
  } catch (e) {
    if (e instanceof ResourceError) throw e;
    log(logId, "ERROR", "Failed to get file content", { logId, ref, filePath, error: e.message });
    throw new SystemError("Failed to get file content", { originalError: e.message });
  }
}

// ──────────────────────────── reset ────────────────────────────

/**
 * 重置 HEAD 到指定版本
 * - soft:  HEAD 移到 target，index 和 workdir 不变
 * - mixed: HEAD 移到 target，index 跟随，workdir 不变
 * - hard:  HEAD 移到 target，index 和 workdir 全部恢复
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
    // 记录当前 HEAD
    const currentLog = await git.log({ fs, dir: targetPath, depth: 1 });
    const previousHead = currentLog.length > 0 ? currentLog[0].oid : null;

    const currentBranch = await git.currentBranch({ fs, dir: targetPath, fullname: false });
    if (!currentBranch) {
      throw new BusinessError("Cannot reset: detached HEAD");
    }

    // hard 模式：先记录当前 HEAD 的文件列表，用于后续清理
    const oldFiles = mode === "hard"
      ? new Set(await git.listFiles({ fs, dir: targetPath, ref: "HEAD" }))
      : null;

    // 移动分支指针到 target
    await git.writeRef({
      fs,
      dir: targetPath,
      ref: `refs/heads/${currentBranch}`,
      value: target,
      force: true,
    });

    if (mode === "mixed" || mode === "hard") {
      // resetIndex 要求逐文件操作，先获取 target 文件列表
      const targetFiles = await git.listFiles({ fs, dir: targetPath, ref: target });
      const targetSet = new Set(targetFiles);

      // 将 target 中每个文件在 index 中重置为 target 版本
      for (const f of targetFiles) {
        await git.resetIndex({ fs, dir: targetPath, filepath: f, ref: target });
      }

      // 从 index 中移除 target 不存在的文件
      const matrix = await git.statusMatrix({ fs, dir: targetPath });
      for (const [f, , , S] of matrix) {
        if (!targetSet.has(f) && S !== 0) {
          try { await git.remove({ fs, dir: targetPath, filepath: f }); } catch (_) {}
        }
      }
    }

    if (mode === "hard") {
      // 手动同步 workdir：写入 target 的所有文件
      const hardTargetFiles = await git.listFiles({ fs, dir: targetPath, ref: target });
      const hardTargetSet = new Set(hardTargetFiles);

      for (const f of hardTargetFiles) {
        const result = await readFileAtCommit(targetPath, target, f);
        if (!result) continue;
        const fullPath = path.join(targetPath, f);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, result.buf);
      }

      // 删除旧 HEAD 中存在但 target 中不存在的文件
      if (oldFiles) {
        for (const f of oldFiles) {
          if (!hardTargetSet.has(f)) {
            const fullPath = path.join(targetPath, f);
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
            }
          }
        }
      }
    }

    log(logId, "INFO", "Git reset successful", { logId, target, mode, previousHead });

    return {
      success: true,
      message: `Reset (${mode}) to ${target} successful`,
      logId,
      target,
      mode,
      previousHead,
    };
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    log(logId, "ERROR", "Failed to reset", { logId, target, mode, error: e.message });
    throw new SystemError("Failed to reset", { originalError: e.message });
  }
}

// ──────────────────────────── checkout ────────────────────────────

/**
 * 将 target 版本的文件检出到工作区和暂存区，HEAD 不动。
 * isomorphic-git 的 checkout 会切换分支，因此用 listFiles + readBlob 手动恢复文件。
 */
async function checkout(options = {}) {
  const { target } = options;
  if (!target) {
    throw new ValidationError("Checkout target cannot be empty", { field: "target" });
  }

  const { targetPath, logId } = resolveAndCheck(options);
  await ensureGitRepo(targetPath);

  try {
    const files = await git.listFiles({ fs, dir: targetPath, ref: target });

    for (const filepath of files) {
      const result = await readFileAtCommit(targetPath, target, filepath);
      if (!result) continue;

      const fullPath = path.join(targetPath, filepath);

      // 确保父目录存在
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      // 写入工作区
      fs.writeFileSync(fullPath, result.buf);
      // 加入暂存区
      await git.add({ fs, dir: targetPath, filepath });
    }

    log(logId, "INFO", "Git checkout files successful", { logId, target });
    return { success: true, message: `Checkout files from ${target} successful`, logId, target };
  } catch (e) {
    log(logId, "ERROR", "Failed to checkout files", { logId, target, error: e.message });
    throw new SystemError("Failed to checkout files", { originalError: e.message });
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
    const tags = await git.listTags({ fs, dir: targetPath });
    return {
      success: true,
      logId,
      tags,
      latest: tags.length > 0 ? tags[tags.length - 1] : null,
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
    if (tagMessage) {
      await git.annotatedTag({
        fs, dir: targetPath,
        ref: tagName,
        message: tagMessage,
        tagger: getDefaultAuthor(),
      });
    } else {
      await git.tag({ fs, dir: targetPath, ref: tagName });
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
    await git.deleteRef({ fs, dir: targetPath, ref: `refs/tags/${tagName}` });

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
    const branches = await git.listBranches({ fs, dir: targetPath });
    const current = await git.currentBranch({ fs, dir: targetPath, fullname: false });

    const branchesObj = {};
    for (const name of branches) {
      branchesObj[name] = { name, current: name === current };
    }

    return { success: true, logId, branches: branchesObj, current };
  } catch (e) {
    log(logId, "ERROR", "Failed to list branches", { logId, error: e.message });
    throw new SystemError("Failed to list branches", { originalError: e.message });
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
    const object = startPoint || "HEAD";
    await git.branch({ fs, dir: targetPath, ref: branchName, object, checkout: true });

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
    // 检查工作区是否 clean（忽略未跟踪文件，git checkout 允许在有未跟踪文件时切换）
    const matrix = await git.statusMatrix({ fs, dir: targetPath });
    const hasChanges = matrix.some(([f, H, W, S]) => {
      if (H === 0 && S === 0) return false; // 未跟踪文件不阻止切换
      return W !== 1 || S !== 1;
    });
    if (hasChanges) {
      const tracked = matrix.filter(([, H]) => H !== 0);
      const modified = tracked.filter(([, , W]) => W !== 1).map(([f]) => f);
      const staged = tracked.filter(([, , , S]) => S !== 1).map(([f]) => f);
      throw new BusinessError(
        "Working directory is not clean, please commit or stash your changes before switching branches",
        { staged, modified }
      );
    }

    await git.checkout({ fs, dir: targetPath, ref: branchName });

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
    const current = await git.currentBranch({ fs, dir: targetPath, fullname: false });
    if (current === branchName) {
      throw new BusinessError("Cannot delete the current branch, please switch to another branch first");
    }

    await git.deleteBranch({ fs, dir: targetPath, ref: branchName, force });

    log(logId, "INFO", "Git branch deleted", { logId, branchName, force });
    return { success: true, message: "Branch deleted successfully", logId, branchName };
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    log(logId, "ERROR", "Failed to delete branch", { logId, branchName, error: e.message });
    throw new SystemError("Failed to delete branch", { originalError: e.message });
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
  checkout,
  listTags,
  createTag,
  deleteTag,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
};
