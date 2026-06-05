import path from "path";
import fs from "fs";
import { simpleGit } from "simple-git";
import config from "../../appConfig/index.js";

/**
 * 创建 simple-git 实例
 * @param {string} projectPath 项目绝对路径
 * @returns {import('simple-git').SimpleGit}
 */
function getGitInstance(projectPath) {
  return simpleGit(projectPath);
}

/**
 * 检查目录下是否存在 .git（即是否已初始化 Git 仓库）
 * @param {string} projectPath
 * @returns {boolean}
 */
function isGitRepo(projectPath) {
  return fs.existsSync(path.join(projectPath, ".git"));
}

/**
 * 确保项目已初始化 Git，未初始化则自动执行 git init 并生成 .gitignore。
 * @param {string} projectPath
 */
async function ensureGitRepo(projectPath) {
  if (!isGitRepo(projectPath)) {
    const git = simpleGit(projectPath);
    await git.init(["-b", "main"]);
    ensureGitignore(projectPath);
    await git.addConfig("user.name", config.GIT_DEFAULT_AUTHOR_NAME, false, "local");
    await git.addConfig("user.email", config.GIT_DEFAULT_AUTHOR_EMAIL, false, "local");
    await git.addConfig("init.defaultBranch", "main", false, "local");
    // 创建初始提交，确保 HEAD 存在
    await git.commit("Initial commit", ["--allow-empty"]);
  }
}

export { getGitInstance, isGitRepo, ensureGitRepo, ensureGitignore, autoGitAdd };

/**
 * 文件操作后自动 git add，非阻塞（失败不影响主流程）
 * @param {string} projectPath 项目绝对路径
 * @param {string[]|null} files 相对路径文件列表，null 时 add --all
 */
async function autoGitAdd(projectPath, files) {
  if (!isGitRepo(projectPath)) return;
  try {
    const git = getGitInstance(projectPath);
    if (Array.isArray(files) && files.length > 0) {
      await git.add(files);
    } else {
      await git.add("--all");
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
    const content = existingLines.length > 0 && existingLines[existingLines.length - 1] !== ""
      ? "\n" + newEntries.join("\n") + "\n"
      : newEntries.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, content, "utf8");
  }
}
