/**
 * isomorphic-git 实现的仓库操作（原生 git 不可用时的回退路径）
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";
import git from "isomorphic-git";
import { createPatch } from "diff";
import config from "../../appConfig/index.js";
import { cleanEmptyParentDirs } from "./nativeGitUtils.js";

/**
 * @param {string} name
 * @param {string} email
 * @returns {{ name: string, email: string }}
 */
function authorOf(name, email) {
  return {
    name: name || config.GIT_DEFAULT_AUTHOR_NAME,
    email: email || config.GIT_DEFAULT_AUTHOR_EMAIL,
  };
}

/**
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
 * @param {Buffer} buf
 * @returns {string}
 */
function gitBlobHash(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`);
  return crypto.createHash("sha1").update(Buffer.concat([header, buf])).digest("hex");
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function getHeadOid(dir) {
  return git.resolveRef({ fs, dir, ref: "HEAD" });
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isoHasHead(dir) {
  try {
    await git.resolveRef({ fs, dir, ref: "HEAD" });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {string} commitOid
 * @param {string} filepath
 * @returns {Promise<{ content: string, buf: Buffer }|null>}
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

/**
 * @param {string} filepath
 * @param {string} oldContent
 * @param {string} newContent
 * @param {boolean} hasOld
 * @param {boolean} hasNew
 * @param {Buffer|null} oldBuf
 * @param {Buffer|null} newBuf
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

  const lines = patch.split("\n");
  const rawHunks = lines.slice(4);
  if (rawHunks.length > 0 && rawHunks[rawHunks.length - 1] === "") rawHunks.pop();

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

  const oldNoNewline = hasOld && oldContent !== "" && !oldContent.endsWith("\n");
  const newNoNewline = hasNew && newContent !== "" && !newContent.endsWith("\n");

  if ((oldNoNewline || newNoNewline) && fixedHunks.length > 0) {
    let lastHunkStart = 0;
    for (let i = 0; i < fixedHunks.length; i++) {
      if (fixedHunks[i].startsWith("@@")) lastHunkStart = i;
    }
    let lastDel = -1;
    let lastAdd = -1;
    let lastCtx = -1;
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
        if (oldNoNewline || newNoNewline) {
          fixedHunks.splice(lastIdx + 1, 0, "\\ No newline at end of file");
        }
      } else if (lastLine.startsWith("+")) {
        let prevIdx = -1;
        for (let i = lastIdx - 1; i > lastHunkStart; i--) {
          if (fixedHunks[i].startsWith("-") && !fixedHunks[i].startsWith("---")) {
            prevIdx = i;
            break;
          }
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
 * @param {string} dir
 * @param {{ authorName: string, authorEmail: string, defaultBranch?: string }} options
 */
async function isoInit(dir, options) {
  const { authorName, authorEmail, defaultBranch = "main" } = options;
  await git.init({ fs, dir, defaultBranch });
  await git.setConfig({ fs, dir, path: "user.name", value: authorName });
  await git.setConfig({ fs, dir, path: "user.email", value: authorEmail });
}

/**
 * @param {string} dir
 */
async function isoStatus(dir) {
  const current = await git.currentBranch({ fs, dir, fullname: false });
  const matrix = await git.statusMatrix({ fs, dir });

  const staged = [];
  const modified = [];
  const created = [];
  const deleted = [];
  const untracked = [];

  for (const [f, H, W, S] of matrix) {
    if (H !== S) staged.push(f);
    if (H === 0 && S !== 0) created.push(f);
    if ((H === 1 && S === 0) || (W === 0 && S !== 0)) deleted.push(f);
    if (S !== 0 && W !== 0 && W !== S) modified.push(f);
    if (H === 0 && S === 0 && W !== 0) untracked.push(f);
  }

  return {
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
}

/**
 * 首提交：walk + ignore 后 batch add
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 */
async function listWorkdirFilesSkippingIgnored(dir, options = {}) {
  const { cache } = options;
  const files = [];

  await git.walk({
    fs,
    dir,
    cache,
    trees: [git.WORKDIR()],
    map: async (filepath, [workdir]) => {
      if (!workdir) return null;
      if (filepath === ".") return;

      const type = await workdir.type();
      if (type === "tree") {
        if (await git.isIgnored({ fs, dir, filepath })) return null;
        return;
      }
      if (type !== "blob") return null;
      if (await git.isIgnored({ fs, dir, filepath })) return null;
      files.push(filepath);
    },
  });

  return files;
}

/**
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 */
async function addAllFirstCommitWithIsomorphic(dir, options = {}) {
  const { cache } = options;
  const toAdd = await listWorkdirFilesSkippingIgnored(dir, { cache });
  if (toAdd.length > 0) {
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force: true });
  }
  return { hasChanges: toAdd.length > 0, toAdd, toRemove: [] };
}

/**
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 */
async function isoAddAll(dir, options = {}) {
  const { cache } = options;
  if (!(await isoHasHead(dir))) {
    return addAllFirstCommitWithIsomorphic(dir, { cache });
  }

  const matrix = await git.statusMatrix({ fs, dir, cache });
  const toAdd = [];
  const toRemove = [];

  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 2 && stage !== 2) toAdd.push(filepath);
    if (head === 1 && workdir === 0 && stage !== 0) toRemove.push(filepath);
  }

  if (toAdd.length > 0) {
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force: true });
  }
  for (const filepath of toRemove) {
    await git.remove({ fs, dir, filepath, cache });
  }

  const hasChanges =
    toAdd.length > 0 ||
    toRemove.length > 0 ||
    matrix.some(([, , , stage]) => stage !== 1);

  return { hasChanges, toAdd, toRemove };
}

/**
 * @param {string} dir
 * @param {string[]} files
 * @param {{ cache?: object, force?: boolean }} [options]
 */
async function isoStageFiles(dir, files, options = {}) {
  const { cache, force = false } = options;
  const toAdd = [];
  const toRemove = [];

  for (const f of files) {
    const fullPath = path.join(dir, f);
    if (fs.existsSync(fullPath)) toAdd.push(f);
    else toRemove.push(f);
  }

  if (toAdd.length > 0) {
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force });
  }
  for (const filepath of toRemove) {
    await git.remove({ fs, dir, filepath, cache });
  }
}

/**
 * @param {string} dir
 * @param {{ message: string, authorName: string, authorEmail: string, cache?: object }} options
 */
async function isoCommitAll(dir, options) {
  const { message, authorName, authorEmail, cache } = options;
  const { hasChanges } = await isoAddAll(dir, { cache });
  if (!hasChanges) return { nothingToCommit: true };

  const commitHash = await git.commit({
    fs,
    dir,
    message,
    author: authorOf(authorName, authorEmail),
    cache,
  });
  return { nothingToCommit: false, commitHash };
}

/**
 * @param {string} dir
 * @param {{ message: string, authorName: string, authorEmail: string, files: string[], cache?: object }} options
 */
async function isoCommitFiles(dir, options) {
  const { message, authorName, authorEmail, files, cache = {} } = options;
  await isoStageFiles(dir, files, { cache, force: true });
  const matrix = await git.statusMatrix({ fs, dir, cache, filepaths: files });
  const hasChanges = matrix.some(([, , , S]) => S !== 1);
  if (!hasChanges) return { nothingToCommit: true };

  const commitHash = await git.commit({
    fs,
    dir,
    message,
    author: authorOf(authorName, authorEmail),
    cache,
  });
  return { nothingToCommit: false, commitHash };
}

/**
 * @param {string} dir
 * @param {string[]|null} files
 */
async function isoUnstage(dir, files) {
  if (Array.isArray(files) && files.length > 0) {
    for (const f of files) {
      await git.resetIndex({ fs, dir, filepath: f });
    }
    return { files };
  }

  const matrix = await git.statusMatrix({ fs, dir });
  const stagedFiles = matrix.filter(([, , , S]) => S !== 1).map(([f]) => f);
  for (const f of stagedFiles) {
    await git.resetIndex({ fs, dir, filepath: f });
  }
  return { files: "all" };
}

/**
 * @param {string} dir
 * @param {string[]|null} files
 */
async function isoDiscard(dir, files) {
  const matrix = await git.statusMatrix({ fs, dir });
  const targetSet = Array.isArray(files) && files.length > 0 ? new Set(files) : null;

  const trackedToRestore = [];
  const newFilesToRemove = [];
  const untrackedToDelete = [];

  for (const [f, H, W, S] of matrix) {
    if (targetSet && !targetSet.has(f)) continue;

    if (H !== 0) {
      if (S !== 1 || W !== 1) trackedToRestore.push(f);
    } else if (H === 0 && S !== 0) {
      newFilesToRemove.push(f);
    } else if (H === 0 && S === 0 && W !== 0) {
      untrackedToDelete.push(f);
    }
  }

  if (trackedToRestore.length > 0 && (await isoHasHead(dir))) {
    const headOid = await getHeadOid(dir);
    for (const f of trackedToRestore) {
      const result = await readFileAtCommit(dir, headOid, f);
      if (!result) continue;
      const fullPath = path.join(dir, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, result.buf);
      await git.add({ fs, dir, filepath: f });
    }
  }

  for (const f of newFilesToRemove) {
    try {
      await git.remove({ fs, dir, filepath: f });
    } catch (_) {}
    const absPath = path.join(dir, f);
    if (fs.existsSync(absPath)) await fs.promises.unlink(absPath);
  }
  if (newFilesToRemove.length > 0) await cleanEmptyParentDirs(dir, newFilesToRemove);

  for (const f of untrackedToDelete) {
    const absPath = path.join(dir, f);
    if (fs.existsSync(absPath)) await fs.promises.unlink(absPath);
  }
  if (untrackedToDelete.length > 0) await cleanEmptyParentDirs(dir, untrackedToDelete);

  return {
    discardedCount:
      trackedToRestore.length + newFilesToRemove.length + untrackedToDelete.length,
    trackedFiles: trackedToRestore,
    newFiles: newFilesToRemove,
    untrackedFiles: untrackedToDelete,
  };
}

/**
 * @param {string} dir
 * @param {{ maxCount?: number, skip?: number, branch?: string, filePath?: string }} options
 */
async function isoLog(dir, options = {}) {
  const { maxCount = 50, skip = 0, branch, filePath } = options;
  if (!(await isoHasHead(dir))) return [];

  const logArgs = { fs, dir, depth: maxCount + skip };
  if (branch) logArgs.ref = branch;
  if (filePath) logArgs.filepath = filePath;

  try {
    const logResult = await git.log(logArgs);
    const entries = logResult.slice(skip, skip + maxCount);
    return entries.map((entry) => ({
      hash: entry.oid,
      date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
      message: entry.commit.message,
      author_name: entry.commit.author.name,
      author_email: entry.commit.author.email,
    }));
  } catch (e) {
    if (
      e?.code === "NotFoundError" ||
      /NotFoundError|Could not find|unable to resolve|does not have any commits/i.test(
        String(e?.message || "")
      )
    ) {
      return [];
    }
    throw e;
  }
}

/**
 * @param {string} dir
 * @param {{ source?: string, from?: string, to?: string, paths?: string[] }} options
 */
async function isoDiff(dir, options = {}) {
  const { source = "worktree", from, to, paths } = options;
  const pathFilter = Array.isArray(paths) && paths.length > 0 ? new Set(paths) : null;
  let diffText = "";
  const summaryFiles = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  async function processFile(filepath, oldResult, newResult) {
    const hasOld = !!oldResult;
    const hasNew = !!newResult;
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
      binHeader.push(
        `Binary files ${hasOld ? `a/${filepath}` : "/dev/null"} and ${hasNew ? `b/${filepath}` : "/dev/null"} differ`
      );
      diffText += binHeader.join("\n") + "\n";
      summaryFiles.push({ file: filepath, changes: 0, insertions: 0, deletions: 0, binary: true });
      return;
    }

    const { diff: patch, insertions, deletions } = makeDiffPatch(
      filepath,
      hasOld ? oldResult.content : "",
      hasNew ? newResult.content : "",
      hasOld,
      hasNew,
      hasOld ? oldResult.buf : null,
      hasNew ? newResult.buf : null
    );
    diffText += patch;
    summaryFiles.push({
      file: filepath,
      changes: insertions + deletions,
      insertions,
      deletions,
      binary: false,
    });
    totalInsertions += insertions;
    totalDeletions += deletions;
  }

  if (source === "commit") {
    let fromOid;
    let toOid;

    if (from && to) {
      fromOid = from;
      toOid = to;
    } else if (from) {
      const commit = await git.readCommit({ fs, dir, oid: from });
      if (commit.commit.parent && commit.commit.parent.length > 0) {
        fromOid = commit.commit.parent[0];
        toOid = from;
      } else {
        fromOid = null;
        toOid = from;
      }
    } else {
      const err = new Error("source=commit requires at least 'from'");
      err.code = "VALIDATION";
      throw err;
    }

    const fromFiles = fromOid
      ? new Set(await git.listFiles({ fs, dir, ref: fromOid }))
      : new Set();
    const toFiles = new Set(await git.listFiles({ fs, dir, ref: toOid }));
    const allFiles = new Set([...fromFiles, ...toFiles]);

    for (const f of allFiles) {
      if (pathFilter && !pathFilter.has(f)) continue;
      const oldResult = fromFiles.has(f) ? await readFileAtCommit(dir, fromOid, f) : null;
      const newResult = toFiles.has(f) ? await readFileAtCommit(dir, toOid, f) : null;
      await processFile(f, oldResult, newResult);
    }
  } else {
    if (!(await isoHasHead(dir))) {
      return { diff: "", summary: { files: [], insertions: 0, deletions: 0 } };
    }

    const headOid = await getHeadOid(dir);
    const matrix = await git.statusMatrix({ fs, dir });

    for (const [f, H, W, S] of matrix) {
      if (pathFilter && !pathFilter.has(f)) continue;

      if (source === "staged") {
        if (S === 1 || (H === 0 && S === 0)) continue;
      } else {
        if (H === 0 && S === 0) continue;
        if (H === 1 && W === 1 && S === 1) continue;
      }

      const oldResult = H !== 0 ? await readFileAtCommit(dir, headOid, f) : null;
      let newResult = null;
      if (W !== 0) {
        const fullPath = path.join(dir, f);
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
    diff: diffText,
    summary: {
      files: summaryFiles,
      insertions: totalInsertions,
      deletions: totalDeletions,
    },
  };
}

/**
 * @param {string} dir
 * @param {{ ref: string, filePath: string }} options
 */
async function isoFileContent(dir, options) {
  const { ref, filePath } = options;
  if (ref === "worktree" || ref === "staged" || ref === "") {
    const fullPath = path.join(dir, filePath);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
  }

  try {
    const oid = await git.resolveRef({ fs, dir, ref });
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: filePath });
    return Buffer.from(blob).toString("utf8");
  } catch (_) {
    return "";
  }
}

/**
 * @param {string} dir
 * @param {{ target: string, mode: string }} options
 */
async function isoReset(dir, options) {
  const { target, mode } = options;
  if (!(await isoHasHead(dir))) {
    const err = new Error("Cannot reset: repository has no commits yet");
    err.code = "BUSINESS";
    throw err;
  }

  const currentLog = await git.log({ fs, dir, depth: 1 });
  const previousHead = currentLog.length > 0 ? currentLog[0].oid : null;

  const currentBranch = await git.currentBranch({ fs, dir, fullname: false });
  if (!currentBranch) {
    const err = new Error("Cannot reset: detached HEAD");
    err.code = "BUSINESS";
    throw err;
  }

  const oldFiles =
    mode === "hard" ? new Set(await git.listFiles({ fs, dir, ref: "HEAD" })) : null;

  await git.writeRef({
    fs,
    dir,
    ref: `refs/heads/${currentBranch}`,
    value: target,
    force: true,
  });

  if (mode === "mixed" || mode === "hard") {
    const targetFiles = await git.listFiles({ fs, dir, ref: target });
    const targetSet = new Set(targetFiles);

    for (const f of targetFiles) {
      await git.resetIndex({ fs, dir, filepath: f, ref: target });
    }

    const matrix = await git.statusMatrix({ fs, dir });
    for (const [f, , , S] of matrix) {
      if (!targetSet.has(f) && S !== 0) {
        try {
          await git.remove({ fs, dir, filepath: f });
        } catch (_) {}
      }
    }
  }

  if (mode === "hard") {
    const hardTargetFiles = await git.listFiles({ fs, dir, ref: target });
    const hardTargetSet = new Set(hardTargetFiles);

    for (const f of hardTargetFiles) {
      const result = await readFileAtCommit(dir, target, f);
      if (!result) continue;
      const fullPath = path.join(dir, f);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, result.buf);
    }

    if (oldFiles) {
      for (const f of oldFiles) {
        if (!hardTargetSet.has(f)) {
          const fullPath = path.join(dir, f);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
  }

  return { previousHead };
}

/**
 * @param {string} dir
 * @param {{ target: string, message: string, authorName: string, authorEmail: string, beforeCommit?: () => Promise<void> }} options
 */
async function isoRevertToTree(dir, options) {
  const { target, message, authorName, authorEmail, beforeCommit } = options;

  if (!(await isoHasHead(dir))) {
    const err = new Error("Cannot revert: repository has no commits yet");
    err.code = "BUSINESS";
    throw err;
  }

  let targetOid;
  try {
    const result = await git.readCommit({ fs, dir, oid: target });
    targetOid = result.oid;
  } catch (_) {
    const err = new Error("Revert target commit does not exist");
    err.code = "VALIDATION";
    err.field = "target";
    err.target = target;
    throw err;
  }

  const beforeMatrix = await git.statusMatrix({ fs, dir });
  const hasUncommitted = beforeMatrix.some(([, H, W, S]) => {
    if (H === 0 && S === 0) return false;
    return W !== 1 || S !== 1;
  });
  if (hasUncommitted) {
    const tracked = beforeMatrix.filter(([, H]) => H !== 0);
    const err = new Error(
      "Working directory is not clean, please commit or stash your changes before reverting"
    );
    err.code = "BUSINESS";
    err.staged = tracked.filter(([, , , S]) => S !== 1).map(([f]) => f);
    err.modified = tracked.filter(([, , W]) => W !== 1).map(([f]) => f);
    throw err;
  }

  const targetFiles = new Set(await git.listFiles({ fs, dir, ref: targetOid }));
  const headOid = await getHeadOid(dir);
  const headFiles = new Set(await git.listFiles({ fs, dir, ref: headOid }));
  const removedFiles = [];

  for (const filepath of targetFiles) {
    const result = await readFileAtCommit(dir, targetOid, filepath);
    if (!result) continue;
    const fullPath = path.join(dir, filepath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, result.buf);
    await git.add({ fs, dir, filepath });
  }

  for (const filepath of headFiles) {
    if (!targetFiles.has(filepath)) {
      removedFiles.push(filepath);
      try {
        await git.remove({ fs, dir, filepath });
      } catch (_) {}
      const fullPath = path.join(dir, filepath);
      if (fs.existsSync(fullPath)) await fs.promises.unlink(fullPath);
    }
  }
  if (removedFiles.length > 0) await cleanEmptyParentDirs(dir, removedFiles);

  if (typeof beforeCommit === "function") {
    await beforeCommit();
  }

  const afterMatrix = await git.statusMatrix({ fs, dir });
  const hasRealChanges = afterMatrix.some(([, , , S]) => S !== 1);
  if (!hasRealChanges) {
    return { nothingToCommit: true, targetOid, previousHead: headOid };
  }

  const commitHash = await git.commit({
    fs,
    dir,
    message,
    author: authorOf(authorName, authorEmail),
  });

  return { nothingToCommit: false, commitHash, targetOid, previousHead: headOid };
}

/**
 * @param {string} dir
 * @param {string} target
 */
async function isoCheckoutFiles(dir, target) {
  const files = await git.listFiles({ fs, dir, ref: target });
  for (const filepath of files) {
    const result = await readFileAtCommit(dir, target, filepath);
    if (!result) continue;
    const fullPath = path.join(dir, filepath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, result.buf);
    await git.add({ fs, dir, filepath });
  }
}

/**
 * @param {string} dir
 */
async function isoListTags(dir) {
  return git.listTags({ fs, dir });
}

/**
 * @param {string} dir
 * @param {{ tagName: string, message?: string, authorName?: string, authorEmail?: string }} options
 */
async function isoCreateTag(dir, options) {
  const { tagName, message, authorName, authorEmail } = options;
  if (message) {
    await git.annotatedTag({
      fs,
      dir,
      ref: tagName,
      message,
      tagger: authorOf(authorName, authorEmail),
    });
  } else {
    await git.tag({ fs, dir, ref: tagName });
  }
}

/**
 * @param {string} dir
 * @param {string} tagName
 */
async function isoDeleteTag(dir, tagName) {
  await git.deleteRef({ fs, dir, ref: `refs/tags/${tagName}` });
}

/**
 * @param {string} dir
 */
async function isoListBranches(dir) {
  const branches = await git.listBranches({ fs, dir });
  const current = await git.currentBranch({ fs, dir, fullname: false });
  const branchesObj = {};
  for (const name of branches) {
    branchesObj[name] = { name, current: name === current };
  }
  return { branches: branchesObj, current };
}

/**
 * @param {string} dir
 * @param {{ branchName: string, startPoint?: string }} options
 */
async function isoCreateBranch(dir, options) {
  const { branchName, startPoint } = options;
  await git.branch({
    fs,
    dir,
    ref: branchName,
    object: startPoint || "HEAD",
    checkout: true,
  });
}

/**
 * @param {string} dir
 * @param {string} branchName
 */
async function isoSwitchBranch(dir, branchName) {
  const matrix = await git.statusMatrix({ fs, dir });
  const hasChanges = matrix.some(([, H, W, S]) => {
    if (H === 0 && S === 0) return false;
    return W !== 1 || S !== 1;
  });
  if (hasChanges) {
    const tracked = matrix.filter(([, H]) => H !== 0);
    const err = new Error(
      "Working directory is not clean, please commit or stash your changes before switching branches"
    );
    err.code = "BUSINESS";
    err.staged = tracked.filter(([, , , S]) => S !== 1).map(([f]) => f);
    err.modified = tracked.filter(([, , W]) => W !== 1).map(([f]) => f);
    throw err;
  }
  await git.checkout({ fs, dir, ref: branchName });
}

/**
 * @param {string} dir
 * @param {{ branchName: string, force?: boolean }} options
 */
async function isoDeleteBranch(dir, options) {
  const { branchName, force = false } = options;
  const current = await git.currentBranch({ fs, dir, fullname: false });
  if (current === branchName) {
    const err = new Error(
      "Cannot delete the current branch, please switch to another branch first"
    );
    err.code = "BUSINESS";
    throw err;
  }
  await git.deleteBranch({ fs, dir, ref: branchName, force });
}

export {
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
};
