import spawn from "cross-spawn";
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
 * 原生 git：全量 add 后 commit（大仓库明显快于 isomorphic-git）
 * author/committer 仅通过环境变量注入，避免 -c 拼接特殊字符问题。
 * @param {string} dir 仓库绝对路径
 * @param {{ message: string, authorName: string, authorEmail: string }} options
 * @returns {Promise<{ nothingToCommit: boolean, commitHash?: string }>}
 */
async function nativeAddAllAndCommit(dir, options) {
  const { message, authorName, authorEmail } = options;
  const authorEnv = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

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

export {
  isNativeGitEnabled,
  isNativeGitAvailable,
  shouldUseNativeGit,
  isNativeGitUnavailableError,
  markNativeGitMissing,
  runGit,
  nativeAddAll,
  nativeAddAllAndCommit,
  resetNativeGitAvailabilityCache,
};
