import spawn from "cross-spawn";
import path from "path";
import fs from "fs";
import config from "../../appConfig/index.js";

/** 原生 git 可用时缓存 true；不可用不永久缓存，仅短时负缓存 */
let nativeGitAvailable = null;
/** 负缓存截止时间戳（ms） */
let nativeGitUnavailableUntil = 0;

/** 负缓存时长：避免 PATH 未就绪时永久判定不可用 */
const NATIVE_GIT_NEGATIVE_CACHE_MS = 30 * 1000;

/** 默认 git 命令超时（大仓库 add/commit 可能较久） */
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 重置可用性缓存（仅供测试）
 */
function resetNativeGitAvailabilityCache() {
  nativeGitAvailable = null;
  nativeGitUnavailableUntil = 0;
}

/**
 * 是否启用原生 git 加速（配置开关，默认 true）
 * @returns {boolean}
 */
function isNativeGitEnabled() {
  return config.GIT_USE_NATIVE !== false;
}

/**
 * 判断错误是否属于「本机无可用 git」（允许回退 isomorphic-git）
 * 其它错误（hook 失败、磁盘满、index 锁等）应直接抛出，禁止静默回退。
 * 注意：不匹配裸 "ENOENT"，避免 hook/脚本 stderr 误伤。
 * @param {unknown} err
 * @returns {boolean}
 */
function isNativeGitUnavailableError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ code?: string, message?: string, stderr?: string }} */ (err);
  if (e.code === "ENOENT" || e.code === "NATIVE_GIT_UNAVAILABLE") return true;
  const msg = `${e.message || ""} ${e.stderr || ""}`;
  return /spawn\s+git(\.exe)?\s+ENOENT|git(\.exe)?:?\s*command not found|git(\.exe)?\s+not found|is not recognized as an internal or external command/i.test(
    msg
  );
}

/**
 * 标记本机 git 暂不可用（清掉正缓存，写入短时负缓存）
 */
function markNativeGitMissing() {
  nativeGitAvailable = null;
  nativeGitUnavailableUntil = Date.now() + NATIVE_GIT_NEGATIVE_CACHE_MS;
}

/**
 * 在指定目录执行 git 命令（跨平台，via cross-spawn）
 * @param {string} cwd 工作目录
 * @param {string[]} args git 参数（不含 git 本身）
 * @param {{ allowFailure?: boolean, env?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function runGit(cwd, args, options = {}) {
  const {
    allowFailure = false,
    env = {},
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let forceKillTimer = null;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGTERM");
            } catch (_) {
              // ignore
            }
            // Windows / 顽固进程：SIGTERM 后再补一刀 SIGKILL
            forceKillTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch (_) {
                // ignore
              }
            }, 2000);
          }, timeoutMs)
        : null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      fn();
    };

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      finish(() => {
        if (allowFailure) {
          resolve({ stdout, stderr: stderr || err.message, exitCode: 1 });
          return;
        }
        reject(err);
      });
    });

    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          const error = new Error(
            `git ${args.join(" ")} timed out after ${timeoutMs}ms`
          );
          error.code = "ETIMEDOUT";
          error.exitCode = -1;
          error.stdout = stdout;
          error.stderr = stderr;
          if (allowFailure) {
            resolve({ stdout, stderr: stderr || error.message, exitCode: -1 });
            return;
          }
          reject(error);
          return;
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0 && !allowFailure) {
          const detail =
            (stderr || stdout || "").trim() || `git ${args.join(" ")} failed`;
          const error = new Error(detail);
          error.exitCode = exitCode;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  });
}

/**
 * author/committer 环境变量（避免 -c 拼接特殊字符）
 * @param {string} authorName
 * @param {string} authorEmail
 * @returns {Record<string, string>}
 */
function buildAuthorEnv(authorName, authorEmail) {
  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };
}

/**
 * 检测本机是否可用原生 git。
 * 成功结果永久缓存；失败仅短时负缓存，避免 PATH 稍后就绪时一直走慢路径。
 * @returns {Promise<boolean>}
 */
async function isNativeGitAvailable() {
  if (!isNativeGitEnabled()) {
    return false;
  }
  if (nativeGitAvailable === true) {
    return true;
  }
  if (Date.now() < nativeGitUnavailableUntil) {
    return false;
  }

  try {
    const result = await runGit(process.cwd(), ["--version"], {
      allowFailure: true,
      timeoutMs: 5 * 1000,
    });
    if (result.exitCode === 0) {
      nativeGitAvailable = true;
      nativeGitUnavailableUntil = 0;
      return true;
    }
  } catch (_) {
    // fall through
  }

  markNativeGitMissing();
  return false;
}

/**
 * 是否应走原生 git 热路径
 * @returns {Promise<boolean>}
 */
async function shouldUseNativeGit() {
  return isNativeGitAvailable();
}

/**
 * 仓库是否已有可解析的 HEAD
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function nativeHasHead(dir) {
  const result = await runGit(dir, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

/**
 * 解析完整 OID
 * @param {string} dir
 * @param {string} rev
 * @returns {Promise<string>}
 */
async function nativeResolveOid(dir, rev) {
  const { stdout } = await runGit(dir, ["rev-parse", rev]);
  return stdout.trim();
}

/**
 * 列出某 ref 下的全部文件路径
 * @param {string} dir
 * @param {string} ref
 * @returns {Promise<string[]>}
 */
async function nativeListFiles(dir, ref) {
  const { stdout } = await runGit(dir, ["ls-tree", "-r", "--name-only", ref]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 初始化仓库（defaultBranch=main）并写入 user.name / user.email
 * @param {string} dir
 * @param {{ authorName: string, authorEmail: string, defaultBranch?: string }} options
 */
async function nativeInit(dir, options) {
  const {
    authorName,
    authorEmail,
    defaultBranch = "main",
  } = options;

  const initWithBranch = await runGit(dir, ["init", "-b", defaultBranch], {
    allowFailure: true,
  });
  if (initWithBranch.exitCode !== 0) {
    await runGit(dir, ["init"]);
    await runGit(dir, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], {
      allowFailure: true,
    });
  }

  await runGit(dir, ["config", "user.name", authorName]);
  await runGit(dir, ["config", "user.email", authorEmail]);
}

/**
 * 解析 git status --porcelain=v1 -b
 * @param {string} dir
 * @returns {Promise<{
 *   current: string|null,
 *   staged: string[],
 *   modified: string[],
 *   created: string[],
 *   deleted: string[],
 *   untracked: string[],
 *   conflicted: string[],
 *   ahead: number,
 *   behind: number,
 *   tracking: string|null,
 * }>}
 */
async function nativeStatus(dir) {
  const { stdout } = await runGit(dir, ["status", "--porcelain=v1", "-b"]);
  const lines = stdout.split("\n").filter((l) => l.length > 0);

  let current = null;
  let tracking = null;
  let ahead = 0;
  let behind = 0;

  const staged = [];
  const modified = [];
  const created = [];
  const deleted = [];
  const untracked = [];
  const conflicted = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const branchInfo = line.slice(3).trim();
      // ## main...origin/main [ahead 1, behind 2]
      // ## release-1.2...origin/release-1.2
      // ## HEAD (no branch)
      // ## No commits yet on main
      const bracketMatch = branchInfo.match(/\s*\[([^\]]+)\]\s*$/);
      const abPart = bracketMatch ? bracketMatch[1] : null;
      const withoutBracket = bracketMatch
        ? branchInfo.slice(0, bracketMatch.index).trim()
        : branchInfo;

      if (
        withoutBracket.startsWith("HEAD (") ||
        withoutBracket === "HEAD" ||
        /^HEAD\b/i.test(withoutBracket) && withoutBracket.includes("Detached")
      ) {
        current = null;
      } else if (withoutBracket.startsWith("No commits yet on ")) {
        current = withoutBracket.slice("No commits yet on ".length).trim() || null;
      } else {
        const dots = withoutBracket.indexOf("...");
        if (dots >= 0) {
          current = withoutBracket.slice(0, dots) || null;
          tracking = withoutBracket.slice(dots + 3) || null;
        } else {
          current = withoutBracket || null;
        }
      }

      if (abPart) {
        const aheadM = abPart.match(/ahead\s+(\d+)/);
        const behindM = abPart.match(/behind\s+(\d+)/);
        if (aheadM) ahead = parseInt(aheadM[1], 10);
        if (behindM) behind = parseInt(behindM[1], 10);
      }
      continue;
    }

    // porcelain: XY PATH 或 XY ORIG -> PATH（rename）
    const xy = line.slice(0, 2);
    let filePath = line.slice(3);
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop();
    }
    // Git 引号路径为 C 风格转义，不能用 JSON.parse
    filePath = decodeGitPorcelainPath(filePath);

    const X = xy[0];
    const Y = xy[1];

    if (xy === "??") {
      untracked.push(filePath);
      continue;
    }
    if (xy === "!!") {
      continue;
    }

    const isConflict =
      X === "U" ||
      Y === "U" ||
      xy === "AA" ||
      xy === "DD";
    if (isConflict) {
      conflicted.push(filePath);
    }

    // staged: index 相对 HEAD 有变化
    if (X !== " " && X !== "?") {
      staged.push(filePath);
      if (X === "A" || X === "C") created.push(filePath);
      if (X === "D") deleted.push(filePath);
    }

    // modified: 工作区相对 index 有修改
    if (Y === "M" || Y === "T") {
      modified.push(filePath);
    }

    // 工作区删除
    if (Y === "D") {
      deleted.push(filePath);
    }
  }

  // 当前分支以 show-current 为准（避免 ## 行解析截断含 '.' 的分支名）
  const br = await runGit(dir, ["branch", "--show-current"], {
    allowFailure: true,
  });
  if (br.exitCode === 0) {
    current = br.stdout.trim() || null;
  }

  return {
    current,
    staged: [...new Set(staged)],
    modified: [...new Set(modified)],
    created: [...new Set(created)],
    deleted: [...new Set(deleted)],
    untracked: [...new Set(untracked)],
    conflicted: [...new Set(conflicted)],
    ahead,
    behind,
    tracking,
  };
}

/**
 * 原生 git add -A，并判断暂存区相对 HEAD 是否有可提交变更
 * @param {string} dir 仓库绝对路径
 * @returns {Promise<{ hasChanges: boolean, toAdd: string[], toRemove: string[] }>}
 */
async function nativeAddAll(dir) {
  await runGit(dir, ["add", "-A"]);

  // exit 0 = 无差异；exit 1 = 有差异；其它 = git 错误
  const diff = await runGit(dir, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (diff.exitCode === 0) {
    return { hasChanges: false, toAdd: [], toRemove: [] };
  }
  if (diff.exitCode === 1) {
    return { hasChanges: true, toAdd: [], toRemove: [] };
  }

  const detail =
    (diff.stderr || diff.stdout || "").trim() ||
    `git diff --cached --quiet failed (exit ${diff.exitCode})`;
  const error = new Error(detail);
  error.exitCode = diff.exitCode;
  error.stderr = diff.stderr;
  error.stdout = diff.stdout;
  throw error;
}

/**
 * 暂存指定路径（含删除）；force 时对齐 git add -f。
 * 单路径 pathspec 失败不拖垮同批其它路径（对齐 iso 先 add 再逐个 remove）。
 * @param {string} dir
 * @param {string[]} files
 * @param {{ force?: boolean }} [options]
 */
async function nativeStageFiles(dir, files, options = {}) {
  const { force = false } = options;
  if (!Array.isArray(files) || files.length === 0) return;

  const toAdd = [];
  const toRemove = [];
  for (const f of files) {
    if (fs.existsSync(path.join(dir, f))) toAdd.push(f);
    else toRemove.push(f);
  }

  const prefix = force ? ["add", "-A", "-f"] : ["add", "-A"];
  await stagePathspecsResilient(dir, prefix, toAdd);

  // 缺失路径：尝试暂存删除（未跟踪且不存在则忽略）
  for (const f of toRemove) {
    const r = await runGit(
      dir,
      ["rm", "--cached", "-f", "--ignore-unmatch", "--", toLiteralPathspec(f)],
      { allowFailure: true }
    );
    if (r.exitCode !== 0 && !isPathspecNoMatchError(r)) {
      const detail =
        (r.stderr || r.stdout || "").trim() ||
        `git rm --cached failed for ${f}`;
      const error = new Error(detail);
      error.exitCode = r.exitCode;
      throw error;
    }
  }
}

/**
 * 是否为 pathspec 无匹配类错误（可跳过该路径继续其它文件）
 * @param {{ stderr?: string, stdout?: string }} result
 * @returns {boolean}
 */
function isPathspecNoMatchError(result) {
  const msg = `${result.stderr || ""} ${result.stdout || ""}`;
  return /did not match any file|pathspec.*did not match|No such file|exists on disk, but not in the index/i.test(
    msg
  );
}

/**
 * 分批 stage；整批失败时逐路径重试，跳过无匹配路径
 * @param {string} dir
 * @param {string[]} prefixArgs
 * @param {string[]} paths
 */
async function stagePathspecsResilient(dir, prefixArgs, paths) {
  if (!paths || paths.length === 0) return;
  const batchSize = 200;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    try {
      await runGit(dir, [
        ...prefixArgs,
        "--",
        ...toLiteralPathspecs(batch),
      ]);
    } catch (_) {
      for (const p of batch) {
        const r = await runGit(
          dir,
          [...prefixArgs, "--", toLiteralPathspec(p)],
          { allowFailure: true }
        );
        if (r.exitCode === 0 || isPathspecNoMatchError(r)) continue;
        const detail =
          (r.stderr || r.stdout || "").trim() ||
          `git ${prefixArgs.join(" ")} failed for ${p}`;
        const error = new Error(detail);
        error.exitCode = r.exitCode;
        throw error;
      }
    }
  }
}

/**
 * 原生 git：全量 add 后 commit（大仓库明显快于 isomorphic-git）
 * @param {string} dir 仓库绝对路径
 * @param {{ message: string, authorName: string, authorEmail: string }} options
 * @returns {Promise<{ nothingToCommit: boolean, commitHash?: string }>}
 */
async function nativeAddAllAndCommit(dir, options) {
  const { message, authorName, authorEmail } = options;
  const authorEnv = buildAuthorEnv(authorName, authorEmail);

  const { hasChanges } = await nativeAddAll(dir);
  if (!hasChanges) {
    return { nothingToCommit: true };
  }

  await runGit(dir, ["commit", "-m", message], { env: authorEnv });

  const { stdout } = await runGit(dir, ["rev-parse", "HEAD"]);
  const commitHash = stdout.trim();
  if (!commitHash) {
    throw new Error("Native git commit succeeded but HEAD is empty");
  }

  return { nothingToCommit: false, commitHash };
}

/**
 * 对已暂存内容执行 commit（不自动 add）；检查的是整个暂存区
 * @param {string} dir
 * @param {{ message: string, authorName: string, authorEmail: string }} options
 * @returns {Promise<{ nothingToCommit: boolean, commitHash?: string }>}
 */
async function nativeCommitStaged(dir, options) {
  const { message, authorName, authorEmail } = options;
  const diff = await runGit(dir, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (diff.exitCode === 0) {
    return { nothingToCommit: true };
  }
  if (diff.exitCode !== 1) {
    const detail =
      (diff.stderr || diff.stdout || "").trim() ||
      `git diff --cached --quiet failed (exit ${diff.exitCode})`;
    const error = new Error(detail);
    error.exitCode = diff.exitCode;
    throw error;
  }

  await runGit(dir, ["commit", "-m", message], {
    env: buildAuthorEnv(authorName, authorEmail),
  });
  const { stdout } = await runGit(dir, ["rev-parse", "HEAD"]);
  return { nothingToCommit: false, commitHash: stdout.trim() };
}

/**
 * 判断指定路径在暂存区相对 HEAD 是否有变更（对齐 isoCommitFiles 的局部 statusMatrix）
 * @param {string} dir
 * @param {string[]} files
 * @returns {Promise<boolean>}
 */
async function nativeHasStagedChangesForPaths(dir, files) {
  if (!Array.isArray(files) || files.length === 0) {
    const diff = await runGit(dir, ["diff", "--cached", "--quiet"], {
      allowFailure: true,
    });
    if (diff.exitCode === 0) return false;
    if (diff.exitCode === 1) return true;
    const detail =
      (diff.stderr || diff.stdout || "").trim() ||
      `git diff --cached --quiet failed (exit ${diff.exitCode})`;
    const error = new Error(detail);
    error.exitCode = diff.exitCode;
    throw error;
  }

  for (let i = 0; i < files.length; i += 200) {
    const batch = toLiteralPathspecs(files.slice(i, i + 200));
    const diff = await runGit(dir, ["diff", "--cached", "--quiet", "--", ...batch], {
      allowFailure: true,
    });
    if (diff.exitCode === 1) return true;
    if (diff.exitCode !== 0) {
      const detail =
        (diff.stderr || diff.stdout || "").trim() ||
        `git diff --cached --quiet failed (exit ${diff.exitCode})`;
      const error = new Error(detail);
      error.exitCode = diff.exitCode;
      throw error;
    }
  }
  return false;
}

/**
 * 暂存指定文件后，仅当这些路径相对 HEAD 有暂存变更时才 commit（对齐 isoCommitFiles）
 * @param {string} dir
 * @param {{ message: string, files: string[], authorName: string, authorEmail: string, force?: boolean }} options
 * @returns {Promise<{ nothingToCommit: boolean, commitHash?: string }>}
 */
async function nativeCommitFiles(dir, options) {
  const {
    message,
    files,
    authorName,
    authorEmail,
    force = true,
  } = options;

  await nativeStageFiles(dir, files, { force });
  const hasChanges = await nativeHasStagedChangesForPaths(dir, files);
  if (!hasChanges) {
    return { nothingToCommit: true };
  }
  return nativeCommitStaged(dir, { message, authorName, authorEmail });
}

/**
 * 是否为「pathspec 无匹配 / 无可 unstage」类可忽略错误
 * @param {{ stderr?: string, stdout?: string }} result
 * @returns {boolean}
 */
function isUnstageNoopError(result) {
  const msg = `${result.stderr || ""} ${result.stdout || ""}`;
  return /did not match any file|pathspec.*did not match|unstaged changes after reset|No changes|ambiguous argument 'HEAD'/i.test(
    msg
  );
}

/**
 * 分批对路径执行 git 命令，避免 Windows/macOS argv 长度上限。
 * 路径自动转为 :(literal)，避免 * ? [ 被当作 pathspec 通配。
 * @param {string} dir
 * @param {string[]} prefixArgs 不含 `--` 与路径的参数前缀
 * @param {string[]} paths
 * @param {{ allowFailure?: boolean, env?: Record<string, string> }} [options]
 * @param {number} [batchSize]
 */
async function runGitWithPathBatches(dir, prefixArgs, paths, options = {}, batchSize = 200) {
  if (!paths || paths.length === 0) return;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = toLiteralPathspecs(paths.slice(i, i + batchSize));
    await runGit(dir, [...prefixArgs, "--", ...batch], options);
  }
}

/**
 * 将相对路径转为字面 pathspec，避免 * ? [ 被 git 当通配/字符类。
 * Windows 反斜杠归一为正斜杠，与 git pathspec 惯例一致。
 * @param {string} p
 * @returns {string}
 */
function toLiteralPathspec(p) {
  let s = String(p || "").replace(/\\/g, "/");
  // 已是 magic pathspec（含 :(literal)）则不重复包装
  if (s.startsWith(":(") || s.startsWith(":!") || s.startsWith(":^")) {
    return s;
  }
  return `:(literal)${s}`;
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function toLiteralPathspecs(paths) {
  return (paths || []).map(toLiteralPathspec);
}

/**
 * 解码 git status --porcelain 中的引号路径（C 风格转义，非 JSON）。
 * 例：`"foo\\tbar"`、`"\\001x"`、含 `\"` 的路径。
 * @param {string} filePath
 * @returns {string}
 */
function decodeGitPorcelainPath(filePath) {
  const raw = String(filePath || "");
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }

  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= inner.length) break;
    const esc = inner[i];
    switch (esc) {
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "a":
        out += "\u0007";
        break;
      case "b":
        out += "\b";
        break;
      case "t":
        out += "\t";
        break;
      case "n":
        out += "\n";
        break;
      case "v":
        out += "\v";
        break;
      case "f":
        out += "\f";
        break;
      case "r":
        out += "\r";
        break;
      default:
        if (esc >= "0" && esc <= "7") {
          let oct = esc;
          if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
            oct += inner[++i];
            if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
              oct += inner[++i];
            }
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          // 未知转义：保留后续字符
          out += esc;
        }
        break;
    }
  }
  return out;
}

/**
 * 归一化为 git 风格正斜杠相对路径（去掉尾随斜杠，便于与 `foo/` 目录项比对）
 * @param {string} p
 * @returns {string}
 */
function normalizeGitPath(p) {
  let s = String(p || "").replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) {
    s = s.replace(/\/+$/, "");
  }
  return s;
}

/**
 * 找出会阻挡 `git restore` 写入 target 的未跟踪路径。
 * 对齐 isomorphic 的 writeFileSync 覆盖语义（原生 restore 遇同路径 untracked 会失败）。
 * @param {string[]} untrackedList
 * @param {Iterable<string>} targetPaths
 * @returns {string[]}
 */
function collectUntrackedRestoreBlockers(untrackedList, targetPaths) {
  const targets = [...targetPaths].map(normalizeGitPath).filter(Boolean);
  const untracked = (untrackedList || []).map(normalizeGitPath).filter(Boolean);
  const untrackedSet = new Set(untracked);
  const blockers = new Set();

  for (const t of targets) {
    if (untrackedSet.has(t)) blockers.add(t);
    // 未跟踪的父路径（例如 untracked 文件/目录挡住子路径创建）
    let parent = path.posix.dirname(t);
    while (parent && parent !== ".") {
      if (untrackedSet.has(parent)) blockers.add(parent);
      const next = path.posix.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  // 未跟踪路径是某 target 的前缀（目录下的文件会挡住 restore）
  for (const u of untracked) {
    for (const t of targets) {
      if (t === u || t.startsWith(`${u}/`)) {
        blockers.add(u);
        break;
      }
    }
  }

  return [...blockers];
}

/**
 * 删除会阻挡 restore 的未跟踪路径，再执行 restore（对齐 iso 覆盖写入）
 * @param {string} dir
 * @param {Iterable<string>} targetPaths
 * @param {string[]} [untrackedList] 已有 status.untracked 时可传入，避免重复查询
 */
async function removeUntrackedBlockingRestore(dir, targetPaths, untrackedList) {
  let untracked = untrackedList;
  if (!untracked) {
    const status = await nativeStatus(dir);
    untracked = status.untracked;
  }
  if (!untracked || untracked.length === 0) return;

  const blockers = collectUntrackedRestoreBlockers(untracked, targetPaths);
  for (const rel of blockers) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) {
      await fs.promises.rm(abs, { recursive: true, force: true });
    }
  }
  if (blockers.length > 0) {
    await cleanEmptyParentDirs(dir, blockers);
  }
}

/**
 * 从暂存区撤回。restore 失败时回退 reset；两者皆失败（且非 noop）则抛错。
 * @param {string} dir
 * @param {string[]|null} files null/空 = 全部
 */
async function nativeUnstage(dir, files) {
  const hasHead = await nativeHasHead(dir);

  if (Array.isArray(files) && files.length > 0) {
    if (hasHead) {
      // 分批 restore，避免大列表 argv 超限
      let restoreFailed = null;
      try {
        for (let i = 0; i < files.length; i += 200) {
          const batch = toLiteralPathspecs(files.slice(i, i + 200));
          const r = await runGit(dir, ["restore", "--staged", "--", ...batch], {
            allowFailure: true,
          });
          if (r.exitCode !== 0 && !isUnstageNoopError(r)) {
            restoreFailed = r;
            break;
          }
        }
      } catch (e) {
        restoreFailed = { stderr: e.message, stdout: "", exitCode: 1 };
      }
      if (!restoreFailed) return;

      let resetFailed = null;
      for (let i = 0; i < files.length; i += 200) {
        const batch = toLiteralPathspecs(files.slice(i, i + 200));
        const reset = await runGit(dir, ["reset", "HEAD", "--", ...batch], {
          allowFailure: true,
        });
        if (reset.exitCode !== 0 && !isUnstageNoopError(reset)) {
          resetFailed = reset;
          break;
        }
      }
      if (!resetFailed) return;

      const detail =
        (resetFailed.stderr ||
          resetFailed.stdout ||
          restoreFailed.stderr ||
          restoreFailed.stdout ||
          "").trim() || "git unstage failed";
      const error = new Error(detail);
      error.exitCode = resetFailed.exitCode || restoreFailed.exitCode;
      throw error;
    }

    // 尚无提交：用 rm --cached 撤暂存
    let rmFailed = null;
    for (let i = 0; i < files.length; i += 200) {
      const batch = toLiteralPathspecs(files.slice(i, i + 200));
      const rm = await runGit(dir, ["rm", "--cached", "-f", "--", ...batch], {
        allowFailure: true,
      });
      if (rm.exitCode !== 0 && !isUnstageNoopError(rm)) {
        rmFailed = rm;
        break;
      }
    }
    if (!rmFailed) return;
    const detail =
      (rmFailed.stderr || rmFailed.stdout || "").trim() ||
      "git unstage (rm --cached) failed";
    const error = new Error(detail);
    error.exitCode = rmFailed.exitCode;
    throw error;
  }

  // 全部撤回
  if (hasHead) {
    const r = await runGit(dir, ["restore", "--staged", "."], {
      allowFailure: true,
    });
    if (r.exitCode === 0 || isUnstageNoopError(r)) return;

    const reset = await runGit(dir, ["reset", "HEAD"], { allowFailure: true });
    if (reset.exitCode === 0 || isUnstageNoopError(reset)) return;

    const detail =
      (reset.stderr || reset.stdout || r.stderr || r.stdout || "").trim() ||
      "git unstage all failed";
    const error = new Error(detail);
    error.exitCode = reset.exitCode || r.exitCode;
    throw error;
  }

  const reset = await runGit(dir, ["reset"], { allowFailure: true });
  if (reset.exitCode === 0 || isUnstageNoopError(reset)) return;
  const detail =
    (reset.stderr || reset.stdout || "").trim() || "git unstage all failed";
  const error = new Error(detail);
  error.exitCode = reset.exitCode;
  throw error;
}

/**
 * 清理因删除产生的空目录
 * @param {string} root
 * @param {string[]} relativeFiles
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
 * 丢弃变更：跟踪文件还原到 HEAD；新增/未跟踪删除（对齐现有业务语义）
 * @param {string} dir
 * @param {string[]|null} files null = 全部
 * @returns {Promise<{
 *   discardedCount: number,
 *   trackedFiles: string[],
 *   newFiles: string[],
 *   untrackedFiles: string[],
 * }>}
 */
async function nativeDiscard(dir, files) {
  const status = await nativeStatus(dir);
  const targetSet = Array.isArray(files) && files.length > 0 ? new Set(files) : null;

  const trackedToRestore = [];
  const newFilesToRemove = [];
  const untrackedToDelete = [];

  // 已跟踪有改动：staged/modified/deleted（排除纯 untracked / 纯 created）
  const trackedCandidates = new Set([
    ...status.staged,
    ...status.modified,
    ...status.deleted,
  ]);
  for (const f of status.created) {
    trackedCandidates.delete(f);
  }

  for (const f of trackedCandidates) {
    if (targetSet && !targetSet.has(f)) continue;
    trackedToRestore.push(f);
  }
  const restoreSet = new Set(trackedToRestore);

  for (const f of status.created) {
    if (targetSet && !targetSet.has(f)) continue;
    // 同路径若需从 HEAD restore，勿当新增删掉
    if (restoreSet.has(f)) continue;
    newFilesToRemove.push(f);
  }
  for (const f of status.untracked) {
    if (targetSet && !targetSet.has(f)) continue;
    // 同路径会 restore：先清 blocker 再还原；此处不再删，避免 restore 后被抹掉
    if (restoreSet.has(f)) continue;
    untrackedToDelete.push(f);
  }

  const hasHead = await nativeHasHead(dir);

  if (trackedToRestore.length > 0 && hasHead) {
    // 先清同路径 untracked，避免 restore 被挡住（对齐 iso writeFileSync）
    await removeUntrackedBlockingRestore(
      dir,
      trackedToRestore,
      status.untracked
    );
    await runGitWithPathBatches(
      dir,
      ["restore", "--source=HEAD", "--staged", "--worktree"],
      trackedToRestore
    );
  }

  if (newFilesToRemove.length > 0) {
    await runGitWithPathBatches(
      dir,
      ["rm", "-f", "--cached"],
      newFilesToRemove,
      { allowFailure: true }
    );
    for (const f of newFilesToRemove) {
      const absPath = path.join(dir, f);
      if (fs.existsSync(absPath)) {
        await fs.promises.unlink(absPath);
      }
    }
    await cleanEmptyParentDirs(dir, newFilesToRemove);
  }

  for (const f of untrackedToDelete) {
    const absPath = path.join(dir, f);
    if (fs.existsSync(absPath)) {
      const st = fs.statSync(absPath);
      if (st.isDirectory()) {
        await fs.promises.rm(absPath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(absPath);
      }
    }
  }
  if (untrackedToDelete.length > 0) {
    await cleanEmptyParentDirs(dir, untrackedToDelete);
  }

  return {
    discardedCount:
      trackedToRestore.length + newFilesToRemove.length + untrackedToDelete.length,
    trackedFiles: trackedToRestore,
    newFiles: newFilesToRemove,
    untrackedFiles: untrackedToDelete,
  };
}

/**
 * 是否为「空历史 / 无法解析 ref」类错误（可返回空列表）
 * @param {string} msg
 * @returns {boolean}
 */
function isEmptyOrMissingRefLogError(msg) {
  return /unknown revision|bad revision|invalid object name|ambiguous argument|does not have any commits|Needed a single revision|not a valid object name|unknown revision or path not in the working tree/i.test(
    msg
  );
}

/**
 * 提交历史
 * @param {string} dir
 * @param {{ maxCount?: number, skip?: number, branch?: string, filePath?: string }} options
 * @returns {Promise<Array<{ hash: string, date: string, message: string, author_name: string, author_email: string }>>}
 */
async function nativeLog(dir, options = {}) {
  const { maxCount = 50, skip = 0, branch, filePath } = options;

  if (!(await nativeHasHead(dir))) {
    return [];
  }

  const args = [
    "log",
    `--skip=${skip}`,
    `-n`,
    String(maxCount),
    "--format=%H%x00%aI%x00%B%x00%an%x00%ae%x1e",
  ];
  if (branch) args.push(branch);
  if (filePath) {
    args.push("--", toLiteralPathspec(filePath));
  }

  const result = await runGit(dir, args, { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    // 仅空仓 / 非法 ref 返回空列表；权限、损坏等真实错误向上抛
    if (isEmptyOrMissingRefLogError(detail)) {
      return [];
    }
    const error = new Error(detail || `git log failed (exit ${result.exitCode})`);
    error.exitCode = result.exitCode;
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }

  const records = result.stdout.split("\x1e").filter((r) => r.trim());
  return records.map((rec) => {
    const parts = rec.replace(/^\n/, "").split("\x00");
    const [hash, dateRaw, message, author_name, author_email] = parts;
    // 对齐 iso：统一为 UTC ISO（带 Z），避免 %aI 带本地偏移导致 API 不一致
    let date = "";
    if (dateRaw) {
      const parsed = new Date(dateRaw);
      date = Number.isNaN(parsed.getTime()) ? dateRaw : parsed.toISOString();
    }
    return {
      hash: (hash || "").trim(),
      date,
      message: (message || "").replace(/\n$/, ""),
      author_name: author_name || "",
      author_email: author_email || "",
    };
  }).filter((c) => c.hash);
}

/**
 * 解析 --numstat 输出
 * @param {string} text
 * @returns {Array<{ file: string, changes: number, insertions: number, deletions: number, binary: boolean }>}
 */
function parseNumstat(text) {
  const files = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [insStr, delStr, file] = parts;
    const binary = insStr === "-" || delStr === "-";
    const insertions = binary ? 0 : parseInt(insStr, 10) || 0;
    const deletions = binary ? 0 : parseInt(delStr, 10) || 0;
    files.push({
      file,
      changes: insertions + deletions,
      insertions,
      deletions,
      binary,
    });
  }
  return files;
}

/**
 * 差异对比
 * @param {string} dir
 * @param {{ source?: "worktree"|"staged"|"commit", from?: string, to?: string, paths?: string[] }} options
 * @returns {Promise<{ diff: string, summary: { files: Array, insertions: number, deletions: number } }>}
 */
async function nativeDiff(dir, options = {}) {
  const { source = "worktree", from, to, paths } = options;
  const pathArgs =
    Array.isArray(paths) && paths.length > 0
      ? ["--", ...toLiteralPathspecs(paths)]
      : [];

  if (source !== "commit" && !(await nativeHasHead(dir))) {
    return { diff: "", summary: { files: [], insertions: 0, deletions: 0 } };
  }

  /** @type {string[]} */
  let diffArgs;
  /** @type {string[]} */
  let numstatArgs;

  if (source === "commit") {
    if (from && to) {
      diffArgs = ["diff", from, to, ...pathArgs];
      numstatArgs = ["diff", "--numstat", from, to, ...pathArgs];
    } else if (from) {
      // 相对父提交；根提交时 git show 更稳
      const parents = await runGit(dir, ["rev-list", "--parents", "-n", "1", from], {
        allowFailure: true,
      });
      const tokens = (parents.stdout || "").trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) {
        // 初始 commit：与空树对比
        const emptyTree = await runGit(dir, ["hash-object", "-t", "tree", "/dev/null"], {
          allowFailure: true,
        });
        // 跨平台：用 git show
        diffArgs = ["show", "--format=", "--patch", from, ...pathArgs];
        numstatArgs = ["show", "--format=", "--numstat", from, ...pathArgs];
        void emptyTree;
      } else {
        const parent = tokens[1];
        diffArgs = ["diff", parent, from, ...pathArgs];
        numstatArgs = ["diff", "--numstat", parent, from, ...pathArgs];
      }
    } else {
      const err = new Error("source=commit requires at least 'from'");
      err.code = "VALIDATION";
      throw err;
    }
  } else if (source === "staged") {
    diffArgs = ["diff", "--cached", ...pathArgs];
    numstatArgs = ["diff", "--cached", "--numstat", ...pathArgs];
  } else {
    // worktree vs HEAD（含已暂存与未暂存，相对 HEAD）
    diffArgs = ["diff", "HEAD", ...pathArgs];
    numstatArgs = ["diff", "HEAD", "--numstat", ...pathArgs];
  }

  const [diffResult, numstatResult] = await Promise.all([
    runGit(dir, diffArgs, { allowFailure: true }),
    runGit(dir, numstatArgs, { allowFailure: true }),
  ]);

  const diffText = diffResult.exitCode === 0 || diffResult.exitCode === 1
    ? diffResult.stdout
    : "";
  // git diff 有差异时 exit 1；show/diff 正常也可能非 0
  if (diffResult.exitCode > 1 && !diffText) {
    throw new Error(
      (diffResult.stderr || diffResult.stdout || "git diff failed").trim()
    );
  }

  const summaryFiles =
    numstatResult.exitCode === 0 || numstatResult.exitCode === 1
      ? parseNumstat(numstatResult.stdout)
      : [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const f of summaryFiles) {
    totalInsertions += f.insertions;
    totalDeletions += f.deletions;
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
 * 读取指定版本文件内容；缺失返回空串
 * @param {string} dir
 * @param {{ ref: string, filePath: string }} options
 * @returns {Promise<string>}
 */
async function nativeFileContent(dir, options) {
  const { ref, filePath } = options;

  if (ref === "worktree" || ref === "staged" || ref === "") {
    const fullPath = path.join(dir, filePath);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
  }

  const result = await runGit(dir, ["show", `${ref}:${filePath}`], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return "";
  return result.stdout;
}

/**
 * reset
 * @param {string} dir
 * @param {{ target: string, mode: "soft"|"mixed"|"hard" }} options
 * @returns {Promise<{ previousHead: string|null }>}
 */
async function nativeReset(dir, options) {
  const { target, mode } = options;
  if (!(await nativeHasHead(dir))) {
    const err = new Error("Cannot reset: repository has no commits yet");
    err.code = "BUSINESS";
    throw err;
  }

  // 与 isoReset 对齐：detached HEAD 时拒绝（避免只动 HEAD 不更新分支）
  const branchResult = await runGit(dir, ["branch", "--show-current"], {
    allowFailure: true,
  });
  const currentBranch =
    branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
  if (!currentBranch) {
    const err = new Error("Cannot reset: detached HEAD");
    err.code = "BUSINESS";
    throw err;
  }

  const previousHead = await nativeResolveOid(dir, "HEAD");

  // hard：先清与目标树冲突的 untracked，对齐 iso writeFileSync 覆盖语义
  if (mode === "hard") {
    let targetFiles = [];
    try {
      targetFiles = await nativeListFiles(dir, target);
    } catch (_) {
      // target 非法时仍交给后续 reset 抛错
      targetFiles = [];
    }
    if (targetFiles.length > 0) {
      await removeUntrackedBlockingRestore(dir, targetFiles);
    }
  }

  await runGit(dir, ["reset", `--${mode}`, target]);
  return { previousHead };
}

/**
 * 树对齐 revert：工作区/index 对齐到 target 后新建 commit（保留历史）
 * @param {string} dir
 * @param {{ target: string, message: string, authorName: string, authorEmail: string, beforeCommit?: () => Promise<void> }} options
 * @returns {Promise<{ nothingToCommit?: boolean, commitHash?: string, targetOid: string, previousHead: string }>}
 */
async function nativeRevertToTree(dir, options) {
  const { target, message, authorName, authorEmail, beforeCommit } = options;

  if (!(await nativeHasHead(dir))) {
    const err = new Error("Cannot revert: repository has no commits yet");
    err.code = "BUSINESS";
    throw err;
  }

  let targetOid;
  try {
    targetOid = await nativeResolveOid(dir, target);
  } catch (_) {
    const err = new Error("Revert target commit does not exist");
    err.code = "VALIDATION";
    err.field = "target";
    err.target = target;
    throw err;
  }

  // 工作区须 clean（未跟踪不阻止）
  const status = await nativeStatus(dir);
  const dirty =
    status.staged.length > 0 ||
    status.modified.length > 0 ||
    status.deleted.length > 0 ||
    status.created.length > 0 ||
    status.conflicted.length > 0;
  if (dirty) {
    const err = new Error(
      "Working directory is not clean, please commit or stash your changes before reverting"
    );
    err.code = "BUSINESS";
    err.staged = status.staged;
    err.modified = status.modified;
    throw err;
  }

  const previousHead = await nativeResolveOid(dir, "HEAD");
  const headFiles = new Set(await nativeListFiles(dir, previousHead));
  const targetFiles = new Set(await nativeListFiles(dir, targetOid));

  // 用 pathspec "." 整树恢复；先清掉会冲突的 untracked（对齐 iso 覆盖）
  if (targetFiles.size > 0) {
    await removeUntrackedBlockingRestore(dir, targetFiles, status.untracked);
    await runGit(dir, [
      "restore",
      `--source=${targetOid}`,
      "--worktree",
      "--staged",
      ".",
    ]);
  }

  // 删除 HEAD 有但 target 没有的文件（分批 rm，同样规避 argv 上限）
  const removed = [...headFiles].filter((f) => !targetFiles.has(f));
  if (removed.length > 0) {
    await runGitWithPathBatches(dir, ["rm", "-f"], removed);
    await cleanEmptyParentDirs(dir, removed);
  }

  if (typeof beforeCommit === "function") {
    await beforeCommit();
  }

  const stagedCheck = await runGit(dir, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (stagedCheck.exitCode === 0) {
    return {
      nothingToCommit: true,
      targetOid,
      previousHead,
    };
  }

  await runGit(dir, ["commit", "-m", message], {
    env: buildAuthorEnv(authorName, authorEmail),
  });
  const commitHash = await nativeResolveOid(dir, "HEAD");
  return { nothingToCommit: false, commitHash, targetOid, previousHead };
}

/**
 * 检出 target 文件到 worktree+index，HEAD 不动。
 * 仅写入 target 树内文件（对齐 isoCheckoutFiles），不删除 HEAD 有而 target 无的路径。
 * @param {string} dir
 * @param {string} target
 */
async function nativeCheckoutFiles(dir, target) {
  const files = await nativeListFiles(dir, target);
  if (files.length === 0) return;
  // 先清冲突 untracked，再按 target 文件列表分批 restore（禁止 pathspec "."）
  await removeUntrackedBlockingRestore(dir, files);
  await runGitWithPathBatches(
    dir,
    ["restore", `--source=${target}`, "--worktree", "--staged"],
    files
  );
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function nativeListTags(dir) {
  const { stdout } = await runGit(dir, ["tag", "--list"]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * @param {string} dir
 * @param {{ tagName: string, message?: string, authorName?: string, authorEmail?: string }} options
 */
async function nativeCreateTag(dir, options) {
  const { tagName, message, authorName, authorEmail } = options;
  if (message) {
    await runGit(dir, ["tag", "-a", tagName, "-m", message], {
      env: buildAuthorEnv(
        authorName || config.GIT_DEFAULT_AUTHOR_NAME,
        authorEmail || config.GIT_DEFAULT_AUTHOR_EMAIL
      ),
    });
  } else {
    await runGit(dir, ["tag", tagName]);
  }
}

/**
 * @param {string} dir
 * @param {string} tagName
 */
async function nativeDeleteTag(dir, tagName) {
  await runGit(dir, ["tag", "-d", tagName]);
}

/**
 * @param {string} dir
 * @returns {Promise<{ branches: Record<string, { name: string, current: boolean }>, current: string|null }>}
 */
async function nativeListBranches(dir) {
  const { stdout } = await runGit(dir, ["branch", "--format=%(refname:short)"]);
  const names = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const cur = await runGit(dir, ["branch", "--show-current"], {
    allowFailure: true,
  });
  const current = cur.exitCode === 0 && cur.stdout.trim() ? cur.stdout.trim() : null;

  const branches = {};
  for (const name of names) {
    branches[name] = { name, current: name === current };
  }
  return { branches, current };
}

/**
 * @param {string} dir
 * @param {{ branchName: string, startPoint?: string }} options
 */
async function nativeCreateBranch(dir, options) {
  const { branchName, startPoint } = options;
  if (startPoint) {
    await runGit(dir, ["checkout", "-b", branchName, startPoint]);
  } else {
    await runGit(dir, ["checkout", "-b", branchName]);
  }
}

/**
 * @param {string} dir
 * @param {string} branchName
 */
async function nativeSwitchBranch(dir, branchName) {
  const status = await nativeStatus(dir);
  const dirty =
    status.staged.length > 0 ||
    status.modified.length > 0 ||
    status.deleted.length > 0 ||
    status.created.length > 0 ||
    status.conflicted.length > 0;
  if (dirty) {
    const err = new Error(
      "Working directory is not clean, please commit or stash your changes before switching branches"
    );
    err.code = "BUSINESS";
    err.staged = status.staged;
    err.modified = status.modified;
    throw err;
  }
  await runGit(dir, ["checkout", branchName]);
}

/**
 * @param {string} dir
 * @param {{ branchName: string, force?: boolean }} options
 */
async function nativeDeleteBranch(dir, options) {
  const { branchName, force = false } = options;
  const cur = await runGit(dir, ["branch", "--show-current"], {
    allowFailure: true,
  });
  if (cur.stdout.trim() === branchName) {
    const err = new Error(
      "Cannot delete the current branch, please switch to another branch first"
    );
    err.code = "BUSINESS";
    throw err;
  }
  await runGit(dir, ["branch", force ? "-D" : "-d", branchName]);
}

export {
  isNativeGitEnabled,
  isNativeGitAvailable,
  shouldUseNativeGit,
  isNativeGitUnavailableError,
  markNativeGitMissing,
  runGit,
  buildAuthorEnv,
  nativeHasHead,
  nativeResolveOid,
  nativeListFiles,
  nativeInit,
  nativeStatus,
  nativeAddAll,
  nativeStageFiles,
  nativeAddAllAndCommit,
  nativeCommitStaged,
  nativeCommitFiles,
  nativeHasStagedChangesForPaths,
  toLiteralPathspec,
  toLiteralPathspecs,
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
  resetNativeGitAvailabilityCache,
  cleanEmptyParentDirs,
  collectUntrackedRestoreBlockers,
  removeUntrackedBlockingRestore,
  decodeGitPorcelainPath,
};
