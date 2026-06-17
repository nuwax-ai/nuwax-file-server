import path from "path";
import fs from "fs";
import git from "isomorphic-git";
import config from "../../appConfig/index.js";

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
 * 暂存所有变更（等价于 git add --all）。
 * 基于 statusMatrix 找出变更/新增/删除的文件，逐个 add/remove。
 * @param {string} dir 项目绝对路径
 */
async function addAll(dir) {
  const matrix = await git.statusMatrix({ fs, dir });
  await Promise.all(
    matrix.map(([filepath, head, workdir]) => {
      if (workdir === 2) {
        // 工作区有变更或新增文件
        return git.add({ fs, dir, filepath }).catch(() => {});
      }
      if (head === 1 && workdir === 0) {
        // 已跟踪文件被删除
        return git.remove({ fs, dir, filepath }).catch(() => {});
      }
      return undefined;
    })
  );
}

/**
 * 确保项目已初始化 Git，未初始化则自动执行 git init 并生成 .gitignore。
 * isomorphic-git 不支持 --allow-empty 提交，因此初始提交需要至少一个文件。
 * @param {string} projectPath
 */
async function ensureGitRepo(projectPath) {
  if (!isGitRepo(projectPath)) {
    await git.init({ fs, dir: projectPath, defaultBranch: "main" });
    await git.setConfig({ fs, dir: projectPath, path: "user.name", value: config.GIT_DEFAULT_AUTHOR_NAME });
    await git.setConfig({ fs, dir: projectPath, path: "user.email", value: config.GIT_DEFAULT_AUTHOR_EMAIL });

    // 先创建 .gitignore，确保有文件可提交
    ensureGitignore(projectPath);

    // 初始提交：添加 .gitignore（若存在）
    const gitignorePath = path.join(projectPath, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      await git.add({ fs, dir: projectPath, filepath: ".gitignore" });
    }

    // 若 .gitignore 不存在（GIT_AUTO_GITIGNORE=false），创建占位文件
    const stagedFiles = await git.listFiles({ fs, dir: projectPath });
    if (stagedFiles.length === 0) {
      fs.writeFileSync(path.join(projectPath, ".gitkeep"), "");
      await git.add({ fs, dir: projectPath, filepath: ".gitkeep" });
    }

    await git.commit({
      fs,
      dir: projectPath,
      message: "Initial commit",
      author: getDefaultAuthor(),
    });
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
      await Promise.all(
        files
          .filter((f) => fs.existsSync(path.join(projectPath, f)))
          .map((f) => git.add({ fs, dir: projectPath, filepath: f }))
      );
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
    const content = existingLines.length > 0 && existingLines[existingLines.length - 1] !== ""
      ? "\n" + newEntries.join("\n") + "\n"
      : newEntries.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, content, "utf8");
  }
}

export { isGitRepo, ensureGitRepo, ensureGitignore, autoGitAdd, addAll, getDefaultAuthor };
