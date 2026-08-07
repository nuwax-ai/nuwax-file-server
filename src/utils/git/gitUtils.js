import path from "path";
import fs from "fs";
import git from "isomorphic-git";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import {
  shouldUseNativeGit,
  nativeAddAll,
  nativeAddAllAndCommit,
  isNativeGitUnavailableError,
  markNativeGitMissing,
} from "./nativeGitUtils.js";

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
 * 仓库是否已有可解析的 HEAD（即至少有一次提交）
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasGitHead(dir) {
  try {
    await git.resolveRef({ fs, dir, ref: "HEAD" });
    return true;
  } catch (_) {
    return false;
  }
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
 * 首提交场景：遍历工作区，尊重 gitignore，收集待 add 的文件路径。
 * 对已 ignore 的目录返回 null 以剪枝，避免深入 node_modules 等大目录。
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 * @returns {Promise<string[]>}
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

      // 根目录：继续向下走
      if (filepath === ".") return;

      const type = await workdir.type();
      if (type === "tree") {
        // 目录被 ignore 则剪枝（不进入子树）
        if (await git.isIgnored({ fs, dir, filepath })) {
          return null;
        }
        return;
      }

      if (type !== "blob") return null;

      if (await git.isIgnored({ fs, dir, filepath })) {
        return null;
      }

      files.push(filepath);
    },
  });

  return files;
}

/**
 * 首提交专用：跳过 statusMatrix，walk + ignore 后直接 batch add
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 * @returns {Promise<{ hasChanges: boolean, toAdd: string[], toRemove: string[] }>}
 */
async function addAllFirstCommitWithIsomorphic(dir, options = {}) {
  const { cache } = options;
  const toAdd = await listWorkdirFilesSkippingIgnored(dir, { cache });

  if (toAdd.length > 0) {
    // 已按 ignore 过滤；force 仅保证与历史 addAll 行为一致
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force: true });
  }

  return { hasChanges: toAdd.length > 0, toAdd, toRemove: [] };
}

/**
 * isomorphic-git 实现的全量暂存。
 * 无 HEAD（真正的首提交）时跳过 statusMatrix，改为 walk + ignore 后直接 add。
 * @param {string} dir
 * @param {{ cache?: object }} [options]
 * @returns {Promise<{ hasChanges: boolean, toAdd: string[], toRemove: string[] }>}
 */
async function addAllWithIsomorphic(dir, options = {}) {
  const { cache } = options;

  // 首提交：没有 HEAD，不存在「相对 HEAD 的删除/修改」，无需全量 statusMatrix
  if (!(await hasGitHead(dir))) {
    return addAllFirstCommitWithIsomorphic(dir, { cache });
  }

  const matrix = await git.statusMatrix({ fs, dir, cache });
  const toAdd = [];
  const toRemove = [];

  for (const [filepath, head, workdir, stage] of matrix) {
    // 工作区有变更/新增，且尚未 staged 到与工作区一致
    if (workdir === 2 && stage !== 2) {
      toAdd.push(filepath);
    }
    // 已跟踪文件被删除，且删除尚未 staged
    if (head === 1 && workdir === 0 && stage !== 0) {
      toRemove.push(filepath);
    }
  }

  if (toAdd.length > 0) {
    // force：未跟踪且被 ignore 的不会进 matrix；已跟踪被 ignore 的仍需能 add（对齐原生 git）
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force: true });
  }
  for (const filepath of toRemove) {
    await git.remove({ fs, dir, filepath, cache });
  }

  // 本次刚 stage，或调用前已有暂存（STAGE 与 HEAD 不一致）
  const hasChanges =
    toAdd.length > 0 ||
    toRemove.length > 0 ||
    matrix.some(([, , , stage]) => stage !== 1);

  return { hasChanges, toAdd, toRemove };
}

/**
 * 暂存所有变更（等价于 git add --all）。
 * 优先原生 git；仅当本机无可用 git 时回退 isomorphic-git，其它错误直接抛出。
 * @param {string} dir 项目绝对路径
 * @param {{ cache?: object }} [options]
 * @returns {Promise<{ hasChanges: boolean, toAdd: string[], toRemove: string[] }>}
 */
async function addAll(dir, options = {}) {
  if (await shouldUseNativeGit()) {
    try {
      return await nativeAddAll(dir);
    } catch (err) {
      if (!isNativeGitUnavailableError(err)) throw err;
      warnNativeFallback(dir, err, "addAll");
    }
  }
  return addAllWithIsomorphic(dir, options);
}

/**
 * 全量暂存并提交（项目初始化等热路径）。
 * 优先原生 git；仅当本机无可用 git 时回退 isomorphic-git，其它错误直接抛出。
 * @param {string} dir 项目绝对路径
 * @param {{ message: string, authorName?: string, authorEmail?: string, cache?: object }} options
 * @returns {Promise<{ nothingToCommit: boolean, commitHash?: string, viaNative?: boolean }>}
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

  const { hasChanges } = await addAllWithIsomorphic(dir, { cache });
  if (!hasChanges) {
    return { nothingToCommit: true, viaNative: false };
  }

  const commitHash = await git.commit({
    fs,
    dir,
    message,
    author: { name: authorName, email: authorEmail },
    cache,
  });

  return { nothingToCommit: false, commitHash, viaNative: false };
}

/**
 * 暂存指定文件列表（等价于对每个文件执行 git add，并能处理删除）：
 *   - 磁盘上存在的文件 → git.add
 *   - 磁盘上不存在但已被跟踪的文件 → git.remove（暂存删除）
 *   - 既不存在也未被跟踪 → remove 为 no-op，等价忽略
 * @param {string} dir 项目绝对路径
 * @param {string[]} files 相对路径文件列表
 * @param {{ cache?: object, force?: boolean }} [options] force 默认 false（尊重 gitignore）；API 显式暂存时可传 true
 */
async function stageFiles(dir, files, options = {}) {
  const { cache, force = false } = options;
  const toAdd = [];
  const toRemove = [];

  for (const f of files) {
    const fullPath = path.join(dir, f);
    if (fs.existsSync(fullPath)) {
      toAdd.push(f);
    } else {
      toRemove.push(f);
    }
  }

  if (toAdd.length > 0) {
    await git.add({ fs, dir, filepath: toAdd, parallel: true, cache, force });
  }
  for (const filepath of toRemove) {
    // 与 addAll 一致：删除暂存失败直接抛出，避免静默跳过后误判 nothing to commit
    await git.remove({ fs, dir, filepath, cache });
  }
}

/**
 * 确保项目已初始化 Git，未初始化则自动执行 git init 并生成 .gitignore。
 * 不创建占位 Initial commit，以便后续全量首提交可走 walk / 原生 git 快路径。
 * 若关闭 AUTO_GITIGNORE 且无 .gitignore，写入 .gitkeep（仍不 commit），避免空仓无文件可提交。
 * @param {string} projectPath
 */
async function ensureGitRepo(projectPath) {
  if (!isGitRepo(projectPath)) {
    await git.init({ fs, dir: projectPath, defaultBranch: "main" });
    await git.setConfig({ fs, dir: projectPath, path: "user.name", value: config.GIT_DEFAULT_AUTHOR_NAME });
    await git.setConfig({ fs, dir: projectPath, path: "user.email", value: config.GIT_DEFAULT_AUTHOR_EMAIL });
    ensureGitignore(projectPath);

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
 * 文件操作后自动 git add，非阻塞（失败不影响主流程）
 * @param {string} projectPath 项目绝对路径
 * @param {string[]|null} files 相对路径文件列表，null 时 add --all
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

/**
 * 自动创建或合并 .gitignore 文件
 * 将配置中的默认条目追加到项目 .gitignore（不重复追加）
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

export {
  isGitRepo,
  ensureGitRepo,
  ensureGitignore,
  autoGitAdd,
  addAll,
  addAllWithIsomorphic,
  commitAllChanges,
  stageFiles,
  getDefaultAuthor,
  hasGitHead,
  listWorkdirFilesSkippingIgnored,
};
