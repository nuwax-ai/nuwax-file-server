import { log } from "../utils/log/logUtils.js";
import config from "../appConfig/index.js";
import path from "path";
import fs from "fs";
import { extractZip } from "../utils/common/zipUtils.js";
import { startDevServer } from "../utils/build/startDevUtils.js";
import { restartDevServer } from "../utils/build/restartDevUtils.js";
import { stopDevServer } from "../utils/build/stopDevUtils.js";
import {
  ValidationError,
  BusinessError,
  SystemError,
  FileError,
  ResourceError,
} from "../utils/error/errorHandler.js";
import { sanitizeSensitivePaths } from "../utils/common/sensitiveUtils.js";
import { removeNodeModules } from "../utils/buildDependency/dependencyManager.js";
import {
  backupProjectToZip,
  copyDirectoryFiltered,
} from "../utils/project/backupUtils.js";
import { createPnpmNpmrc } from "../utils/common/npmrcUtils.js";
import { resolveProjectPath } from "../utils/common/projectPathUtils.js";
import {
  ensurePrimaryAgentDirs,
  syncAgents,
} from "../utils/common/AgentWorkspaceUtils.js";

/**
 * 创建项目目录
 * @param {string} projectId - 项目ID
 * @param {string} templateType - 模板类型(react|vue3)
 * @returns {Promise<Object>} 创建结果
 */
async function createProject(projectId, templateType = "react", isolationContext = {}) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  const allowedTemplateTypes = ["react", "vue3"];
  if (!allowedTemplateTypes.includes(templateType)) {
    throw new ValidationError("Template type is invalid, only supports react or vue3", {
      field: "templateType",
      templateType,
      allowedValues: allowedTemplateTypes,
    });
  }
  const templateNameMap = {
    react: config.INIT_PROJECT_NAME_REACT || "react-vite-template",
    vue3: config.INIT_PROJECT_NAME_VUE3 || "vue3-vite-template",
  };
  const templateName = templateNameMap[templateType];

  const projectPath = resolveProjectPath(projectId, isolationContext);

  // 检查目录是否已存在
  if (fs.existsSync(projectPath)) {
    throw new BusinessError(`Project directory ${projectId} already exists`, {
      projectId,
      projectPath,
    });
  }

  try {
    // 创建项目目录
    fs.mkdirSync(projectPath, { recursive: true });
    log(projectId, "INFO", `Project directory created successfully: ${projectPath}`, { projectId });
    // 准备模板路径
    const initDir = config.INIT_PROJECT_DIR;
    const templateZipPath = path.join(
      initDir,
      `${templateName}.zip`
    );
    const templateDir = path.join(initDir, templateName);

    log(projectId, "DEBUG", "Start checking template directory", { templateDir, templateZipPath });

    // 如果模板目录不存在，则尝试从zip解压
    if (!fs.existsSync(templateDir)) {
      if (!fs.existsSync(templateZipPath)) {
        log(projectId, "ERROR", `Initialization template does not exist: ${templateZipPath}`, {
          projectId,
          templateZipPath,
        });
        throw new ResourceError("Initialization template does not exist", {});
      }
      log(
        projectId,
        "INFO",
        `Template directory does not exist, starting to unzip template: ${templateZipPath}`,
        {
          projectId,
          templateZipPath,
        }
      );
      await extractZip(templateZipPath, templateDir);
      log(projectId, "INFO", "Template unzip completed", { projectId });
      if (!fs.existsSync(templateDir)) {
        throw new SystemError("Template unzip directory still does not exist", {});
      }
    }

    // 将模板内容复制到项目目录（不包含顶层 react-vite 目录）
    log(projectId, "DEBUG", "Start copying template content to project directory", { templateDir, projectPath });
    const entries = await fs.promises.readdir(templateDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const srcPath = path.join(templateDir, entry.name);
      const destPath = path.join(projectPath, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.mkdir(destPath, { recursive: true });
        // 复制目录
        await copyDirectoryFiltered(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(srcPath, destPath);
      }
    }

    // 为项目创建 .npmrc 配置文件
    log(projectId, "DEBUG", "Start creating .npmrc configuration file", { projectPath });
    await createPnpmNpmrc(projectPath, projectId);

    log(projectId, "INFO", `Project ${projectId} initialized successfully`, { projectId, elapsedMs: Date.now() - startTime });

    if (config.GIT_ENABLED) {
      try {
        const gitService = await import("./gitService.js");
        await gitService.init({ workspaceType: "pageApp", projectId, isolationContext });
        await gitService.commit({
          workspaceType: "pageApp",
          projectId,
          isolationContext,
          message: `init project: ${projectId}`,
        });
      } catch (gitErr) {
        log(projectId, "WARN", "Git init/commit failed, skipping", { error: gitErr.message });
      }
    }

    return {
      success: true,
      message: `Project ${projectId} created successfully`,
      projectPath: projectPath,
    };
  } catch (error) {
    log(projectId, "ERROR", `Project ${projectId} initialization failed: ${error.message}`, {
      projectId,
      elapsedMs: Date.now() - startTime,
    });
    throw new SystemError(`Project ${projectId} initialization failed: ${error.message}`, {
      projectId,
      projectPath,
      originalError: error.message,
    });
  }
}

/**
 * 检查并移除顶层文件夹
 * @param {string} projectPath - 项目路径
 * @returns {Promise<void>}
 */
async function removeTopLevelFolder(projectPath) {
  const entries = await fs.promises.readdir(projectPath, {
    withFileTypes: true,
  });

  // 过滤噪声条目
  const noisePatterns = config.TOP_LEVEL_NOISE_PATTERNS;

  const filteredEntries = entries.filter((entry) => {
    const name = entry.name;

    // 过滤以点开头的隐藏文件/目录（所有以点开头的都算噪声）
    if (name.startsWith(".")) {
      return false;
    }

    // 过滤其他噪声条目
    return !noisePatterns.some((pattern) => {
      if (pattern.endsWith("*")) {
        return name.startsWith(pattern.slice(0, -1));
      }
      return name === pattern;
    });
  });

  // 如果过滤后只有一个目录，则认为是顶层文件夹
  if (filteredEntries.length === 1 && filteredEntries[0].isDirectory()) {
    const topLevelDir = path.join(projectPath, filteredEntries[0].name);
    const tempDir = path.join(projectPath, "..", `temp_${Date.now()}`);

    // 将顶层文件夹内容移动到临时目录
    await fs.promises.rename(topLevelDir, tempDir);

    // 将临时目录内容移回项目目录
    const tempEntries = await fs.promises.readdir(tempDir);
    for (const entry of tempEntries) {
      const srcPath = path.join(tempDir, entry);
      const destPath = path.join(projectPath, entry);
      await fs.promises.rename(srcPath, destPath);
    }

    // 删除临时目录
    await fs.promises.rmdir(tempDir);
  }
}

/**
 * 清理项目目录（删除整个项目目录）
 * @param {string} projectId - 项目ID
 * @returns {Promise<void>}
 */
async function cleanupProjectDirectory(projectId, isolationContext = {}) {
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }

  const projectPath = resolveProjectPath(projectId, isolationContext);

  if (fs.existsSync(projectPath)) {
    try {
      log(projectId, "INFO", `Start cleaning project directory: ${projectPath}`, { projectId });
      await fs.promises.rm(projectPath, { recursive: true, force: true });
      log(projectId, "INFO", `Project directory cleaned up: ${projectPath}`, { projectId });
    } catch (error) {
      log(projectId, "ERROR", `Failed to clean project directory: ${error.message}`, {
        projectId,
        projectPath,
        originalError: error.message,
      });
      throw new SystemError(`Failed to clean project directory: ${error.message}`, {
        projectId,
        projectPath,
        originalError: error.message,
      });
    }
  } else {
    log(projectId, "INFO", `Project directory does not exist, no need to clean: ${projectPath}`, {
      projectId,
    });
  }
}

/**
 * 检查目录是否为空
 */
function isDirectoryEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return true;
  }

  try {
    const entries = fs.readdirSync(dirPath);
    // 过滤掉隐藏文件和系统文件
    const filteredEntries = entries.filter((entry) => {
      return !entry.startsWith(".") && entry !== "node_modules";
    });
    return filteredEntries.length === 0;
  } catch (error) {
    const projectId = path.basename(dirPath);
    log(projectId, "ERROR", `Failed to check if directory is empty: ${error.message}`, {
      dirPath,
    });
    return true; // 出错时默认认为为空
  }
}

/**
 * 上传项目压缩包
 */
async function uploadProject(
  projectId,
  zipFilePath,
  req,
  codeVersion,
  pid,
  basePath,
  isolationContext = {}
) {
  const startTime = Date.now();
  const projectPath = resolveProjectPath(projectId, isolationContext);

  try {
    // 检查项目目录是否为空
    const isEmpty = isDirectoryEmpty(projectPath);

    if (!isEmpty) {
      // 目录非空，需要备份当前项目
      log(projectId, "INFO", `Project directory is not empty, starting to backup current version`, { projectId });

      // 检查是否已存在 codeVersion-1 的备份
      const prevVersion = parseInt(codeVersion) - 1;
      const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
      const backupZipPath = path.join(
        backupDir,
        `${projectId}-v${prevVersion}.zip`
      );

      if (!fs.existsSync(backupZipPath)) {
        // 备份当前项目（Git 启用时跳过 zip 备份）
        try {
          if (!config.GIT_ENABLED) {
            await backupProjectOfVersion(projectId, prevVersion, isolationContext);
          }
          log(projectId, "INFO", `Current version backed up: ${backupZipPath}`, {
            projectId,
          });
        } catch (backupError) {
          log(projectId, "ERROR", `Failed to backup current version: ${backupError.message}`, {
            projectId,
          });
          throw new SystemError(`Failed to backup current version: ${backupError.message}`, {
            projectId,
            originalError: backupError.message,
          });
        }
      } else {
        log(projectId, "INFO", `Backup file already exists, skipping backup: ${backupZipPath}`, {
          projectId,
        });
      }

      // 停止旧版本的dev服务器
      if (pid && !isNaN(Number(pid))) {
        const pidNum = Number(pid);
        log(projectId, "INFO", `Stopping old version dev server, PID: ${pidNum}`, {
          projectId,
        });
        try {
          await stopDevServer(req, projectId, pidNum, { strict: true });
          log(projectId, "INFO", `Old version dev server stopped`, { projectId });
        } catch (stopError) {
          log(
            projectId,
            "WARN",
            `Failed to stop old version dev server: ${stopError.message}`,
            {
              projectId,
              pid: pidNum,
            }
          );
          // 停止失败不影响后续流程，继续执行
        }
      }

      // 清空项目目录
      if (fs.existsSync(projectPath)) {
        log(projectId, "INFO", `Cleaning project directory: ${projectPath}`, {
          projectId,
        });
        await fs.promises.rm(projectPath, { recursive: true, force: true });
      }
    } else {
      log(projectId, "INFO", `Project directory is empty, directly deploying new project`, { projectId });
    }

    // 创建项目目录
    fs.mkdirSync(projectPath, { recursive: true });
    log(projectId, "INFO", `Project directory created successfully: ${projectPath}`, { projectId });

    // 解压压缩包到项目目录
    log(projectId, "DEBUG", "Start extracting zip file to project directory", { projectId, zipFilePath });
    await extractZip(zipFilePath, projectPath);
    log(projectId, "DEBUG", "Zip file extracted successfully", { projectId });

    // 检查并移除顶层文件夹
    log(projectId, "DEBUG", "Check and remove top level folder", { projectId });
    await removeTopLevelFolder(projectPath);

    // 检查并删除 node_modules 文件夹
    log(projectId, "DEBUG", "Check and remove node_modules folder", { projectId });
    await removeNodeModules(projectPath);

    // 为项目创建 .npmrc 配置文件
    log(projectId, "DEBUG", "Start creating .npmrc configuration file", { projectId });
    await createPnpmNpmrc(projectPath, projectId);

    if (config.GIT_ENABLED) {
      try {
        const gitService = await import("./gitService.js");
        await gitService.init({ workspaceType: "pageApp", projectId, isolationContext });
        await gitService.commit({
          workspaceType: "pageApp",
          projectId,
          isolationContext,
          message: `upload project v${codeVersion}`,
        });
      } catch (gitErr) {
        log(projectId, "WARN", "Git commit failed after upload, skipping", { error: gitErr.message });
      }
    }

    // 不需要启动dev,前端会调用启动
    log(projectId, "INFO", `Project ${projectId} uploaded successfully`, { projectId, codeVersion, elapsedMs: Date.now() - startTime });
    return {
      success: true,
      message: `Project ${projectId} uploaded successfully`,
      projectId: projectId,
      codeVersion: codeVersion,
    };
  } catch (error) {
    log(projectId, "ERROR", `Failed to upload project: ${error.message}`, { projectId, elapsedMs: Date.now() - startTime });

    // 上传失败时清理项目目录
    try {
      await cleanupProjectDirectory(projectId, isolationContext);
      log(projectId, "INFO", "Failed to upload project, project directory cleaned up", { projectId });
    } catch (cleanupError) {
      log(projectId, "ERROR", `Failed to clean project directory: ${cleanupError.message}`, {
        projectId,
        originalError: cleanupError.message,
      });
      // 清理失败不影响主错误抛出
    }

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`Failed to upload project: ${error.message}`, {
        projectId,
        projectPath,
        zipFilePath,
        originalError: error.message,
      });
    }

    throw error;
  }
}

/**
 * 备份项目为指定版本zip
 * @param {string} projectId 项目ID
 * @param {number|string} codeVersion 版本号
 * @returns {Promise<string>} zip文件路径
 */
async function backupProjectOfVersion(projectId, codeVersion, isolationContext = {}) {
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion cannot be empty", {
      field: "codeVersion",
    });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion must be a number", {
      field: "codeVersion",
    });
  }

  const projectPath = resolveProjectPath(projectId, isolationContext);
  if (!fs.existsSync(projectPath)) {
    throw new ResourceError("Project does not exist", { projectId });
  }

  // 构建zip文件路径
  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const zipName = `${projectId}-v${versionNum}.zip`;
  const outZipPath = path.join(backupDir, zipName);

  // 进行备份
  log(projectId, "DEBUG", "Start backing up project to zip", { projectId, versionNum, outZipPath });
  return await backupProjectToZip(projectId, projectPath, outZipPath);
}

/**
 * 处理上传的文件（移动到项目目录）
 * @param {string} projectId 项目ID
 * @param {string} codeVersion 代码版本
 * @param {Object} file 上传的文件对象（来自multer）
 * @returns {Promise<Object>} 处理结果，包含文件路径
 */
async function handleFileUpload(projectId, codeVersion, file) {
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  if (!codeVersion) {
    throw new ValidationError("codeVersion cannot be empty", { field: "codeVersion" });
  }
  if (!file) {
    throw new ValidationError("Please upload a zip file", { field: "zipFile" });
  }

  // 创建项目目录
  const projectPath = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  // 将文件从临时目录移动到项目目录
  const tempFilePath = file.path;
  const projectFilePath = path.join(
    projectPath,
    `${projectId}-v${codeVersion}.zip`
  );

  try {
    fs.renameSync(tempFilePath, projectFilePath);
    log(projectId, "INFO", "File saved successfully", {
      projectId,
      codeVersion,
      filePath: projectFilePath,
    });
    return { success: true, filePath: projectFilePath };
  } catch (moveErr) {
    log(projectId, "ERROR", "Failed to move file", {
      projectId,
      codeVersion,
      error: moveErr.message,
    });

    // 清理临时文件
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupErr) {
        log(projectId, "ERROR", "Failed to clean temporary file", {
          projectId,
          error: cleanupErr.message,
        });
      }
    }
    throw new SystemError("Failed to save file", {
      projectId,
      codeVersion,
      originalError: moveErr.message,
    });
  }
}

/**
 * 规范化 skillUrls 参数，兼容数组/JSON 字符串/单字符串
 * @param {unknown} skillUrls
 * @returns {string[]}
 */
function normalizeSkillUrls(skillUrls) {
  if (!skillUrls) return [];
  if (Array.isArray(skillUrls)) {
    return skillUrls
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof skillUrls === "string") {
    const trimmed = skillUrls.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean);
      }
    } catch {
      // 非 JSON 字符串，按单个 URL 处理
    }
    return [trimmed];
  }
  return [];
}

/**
 * 删除目录（如果存在）
 * @param {string} targetDir
 */
async function removeDirIfExists(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  await fs.promises.rm(targetDir, { recursive: true, force: true });
}

/**
 * 安全移动目录（跨设备时回退为 copy）
 * @param {string} srcDir
 * @param {string} destDir
 */
async function moveDirectory(srcDir, destDir) {
  try {
    await fs.promises.rename(srcDir, destDir);
  } catch (err) {
    if (err.code === "EXDEV") {
      async function copyRecursive(src, dest) {
        const stat = await fs.promises.lstat(src);
        if (stat.isDirectory()) {
          await fs.promises.mkdir(dest, { recursive: true });
          const items = await fs.promises.readdir(src);
          for (const item of items) {
            await copyRecursive(path.join(src, item), path.join(dest, item));
          }
        } else {
          await fs.promises.copyFile(src, dest);
        }
      }

      await copyRecursive(srcDir, destDir);
      await fs.promises.rm(srcDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * 递归查找指定目录（优先根目录，再查一层子目录）
 * @param {string} rootDir
 * @param {string} dirName
 * @returns {Promise<string|null>}
 */
async function findDir(rootDir, dirName) {
  const directDir = path.join(rootDir, dirName);
  if (fs.existsSync(directDir) && (await fs.promises.lstat(directDir)).isDirectory()) {
    return directDir;
  }

  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name, dirName);
    if (fs.existsSync(candidate) && (await fs.promises.lstat(candidate)).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

/**
 * 下载 URL 到本地文件
 * @param {string} url
 * @param {string} destinationPath
 * @param {string} logId
 */
async function downloadUrlToFile(url, destinationPath, logId) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new FileError(`Failed to download skill zip from url: ${url}`, {
      url,
      reason: error.message,
    });
  }

  if (!response.ok) {
    throw new FileError(`Failed to download skill zip from url: ${url}`, {
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const contentType = response.headers.get("content-type") || "";
  if (
    contentType &&
    !contentType.includes("zip") &&
    !contentType.includes("octet-stream")
  ) {
    log(logId, "WARN", "Downloaded skill url content-type is not typical zip", {
      url,
      contentType,
    });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(destinationPath, buffer);
}

/**
 * 推送技能到项目工作空间
 * @param {string|number} projectId
 * @param {Object|null} file multer 文件对象（zip）
 * @param {string[]|string|undefined} skillUrls 技能 zip 下载地址数组
 * @returns {Promise<{message:string, projectPath:string, updatedSkills:string[]}>}
 */
async function pushSkillsToWorkspace(
  projectId,
  file,
  skillUrls,
  isolationContext = {}
) {
  const logId = String(projectId);
  const startTime = Date.now();
  const normalizedSkillUrls = normalizeSkillUrls(skillUrls);
  const downloadedZipPaths = [];
  const extractRoots = [];

  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  if (!file && normalizedSkillUrls.length === 0) {
    throw new ValidationError("file or skillUrls cannot both be empty", {
      field: "file|skillUrls",
    });
  }
  if (file) {
    if (!file.path) {
      throw new ValidationError("Uploaded file has no valid path", { field: "file.path" });
    }
    const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
    if (ext !== ".zip") {
      throw new ValidationError("Only zip files are supported", {
        field: "file",
        originalName: file?.originalname,
      });
    }
  }

  const projectPath = resolveProjectPath(String(projectId), isolationContext);
  if (!fs.existsSync(projectPath)) {
    throw new ValidationError("Project does not exist", { field: "projectId" });
  }

  const { skillsDir: targetSkillsDir, agentTypes: normalizedAgentTypes } =
    await ensurePrimaryAgentDirs(projectPath);
  const tempRoot = path.join(config.UPLOAD_PROJECT_DIR, "temp");

  try {
    await fs.promises.mkdir(targetSkillsDir, { recursive: true });
    await fs.promises.mkdir(tempRoot, { recursive: true });

    const updatedSkillSet = new Set();

    // 处理上传 zip（与 computerRoutes 行为对齐：期望存在 skills 目录）
    if (file) {
      const extractRoot = path.join(
        tempRoot,
        `project_skill_push_${Date.now()}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(extractRoot);
      await fs.promises.mkdir(extractRoot, { recursive: true });
      await extractZip(file.path, extractRoot);

      const skillsDir = await findDir(extractRoot, "skills");
      if (!skillsDir) {
        log(logId, "WARN", "skills directory not found in uploaded zip", {
          projectId,
          extractRoot,
        });
      } else {
        const skillEntries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
        const skillDirs = skillEntries.filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith(".")
        );
        for (const skillDir of skillDirs) {
          const srcSkillPath = path.join(skillsDir, skillDir.name);
          const destSkillPath = path.join(targetSkillsDir, skillDir.name);
          if (fs.existsSync(destSkillPath)) {
            await removeDirIfExists(destSkillPath);
          }
          await moveDirectory(srcSkillPath, destSkillPath);
          updatedSkillSet.add(skillDir.name);
        }
      }
    }

    // 处理技能 URL（结构兼容 skills/<skillName> 或直接 <skillName>）
    for (let i = 0; i < normalizedSkillUrls.length; i += 1) {
      const skillUrl = normalizedSkillUrls[i];
      const downloadedZipPath = path.join(
        tempRoot,
        `project_skill_url_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}.zip`
      );
      downloadedZipPaths.push(downloadedZipPath);
      const extractRoot = path.join(
        tempRoot,
        `project_skill_url_extract_${Date.now()}_${i}_${Math.round(Math.random() * 1e6)}`
      );
      extractRoots.push(extractRoot);

      await fs.promises.mkdir(extractRoot, { recursive: true });
      await downloadUrlToFile(skillUrl, downloadedZipPath, logId);
      await extractZip(downloadedZipPath, extractRoot);

      const rootEntries = await fs.promises.readdir(extractRoot, { withFileTypes: true });
      const rootDirs = rootEntries.filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith(".")
      );
      const skillsRootDir = rootDirs.find((entry) => entry.name === "skills");
      const skillCandidates = skillsRootDir
        ? (await fs.promises.readdir(path.join(extractRoot, "skills"), {
            withFileTypes: true,
          }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => ({
              name: entry.name,
              sourcePath: path.join(extractRoot, "skills", entry.name),
            }))
        : rootDirs.map((entry) => ({
            name: entry.name,
            sourcePath: path.join(extractRoot, entry.name),
          }));

      if (skillCandidates.length === 0) {
        log(logId, "WARN", "No skill directory found after extracting skill url zip", {
          projectId,
          skillUrl,
          extractRoot,
        });
        continue;
      }

      for (const skillDir of skillCandidates) {
        const destSkillPath = path.join(targetSkillsDir, skillDir.name);
        if (fs.existsSync(destSkillPath)) {
          await removeDirIfExists(destSkillPath);
        }
        await moveDirectory(skillDir.sourcePath, destSkillPath);
        updatedSkillSet.add(skillDir.name);
      }
    }

    const updatedSkills = Array.from(updatedSkillSet);
    const message =
      updatedSkills.length > 0
        ? `Pushed ${updatedSkills.length} skills: ${updatedSkills.join(", ")}`
        : "No valid skill directories found in file or skillUrls";

    log(logId, "INFO", "Push skills to project workspace completed", {
      projectId,
      updatedSkills,
      skillUrlsCount: normalizedSkillUrls.length,
      hasFile: !!file,
      agentTypes: normalizedAgentTypes,
      elapsedMs: Date.now() - startTime,
    });
    await syncAgents(projectPath);

    return {
      message,
      projectPath,
      updatedSkills,
    };
  } catch (error) {
    log(logId, "ERROR", "Push skills to project workspace failed", {
      projectId,
      error: error.message,
      elapsedMs: Date.now() - startTime,
    });

    if (
      error instanceof ValidationError ||
      error instanceof FileError ||
      error instanceof BusinessError ||
      error instanceof SystemError
    ) {
      throw error;
    }

    throw new SystemError(`Failed to push skills to project workspace: ${error.message}`, {
      projectId,
    });
  } finally {
    for (const extractRoot of extractRoots) {
      try {
        if (fs.existsSync(extractRoot)) {
          await fs.promises.rm(extractRoot, { recursive: true, force: true });
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean extracted skill temp dir", {
          extractRoot,
          error: e.message,
        });
      }
    }

    for (const zipPath of downloadedZipPaths) {
      try {
        if (fs.existsSync(zipPath)) {
          await fs.promises.unlink(zipPath);
        }
      } catch (e) {
        log(logId, "WARN", "Failed to clean downloaded skill zip", {
          zipPath,
          error: e.message,
        });
      }
    }

    try {
      if (file?.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path);
      }
    } catch (e) {
      log(logId, "WARN", "Failed to clean uploaded skill zip", {
        tempZipPath: file?.path,
        error: e.message,
      });
    }
  }
}

/**
 * 删除项目
 * @param {string} projectId - 项目ID
 * @param {string|number} pid - 进程ID（可选）
 * @returns {Promise<Object>} 删除结果
 */
async function deleteProject(projectId, pid, req, isolationContext = {}) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }

  // 使用特殊的日志标识符，避免日志输出到项目目录
  const logId = null;

  try {
    // 1. 如果有pid，先停止开发服务器
    if (pid && !isNaN(Number(pid))) {
      const pidNum = Number(pid);
      log(
        logId,
        "INFO",
        `[delete-project] Stopping development server, PID: ${pidNum}`,
        {
          projectId,
          pid: pidNum,
        }
      );

      try {
        await stopDevServer(req, projectId, pidNum, { strict: true });
        log(logId, "INFO", `[delete-project] Development server stopped`, { projectId });
      } catch (stopError) {
        log(
          logId,
          "WARN",
          `[delete-project] Failed to stop development server: ${stopError.message}`,
          {
            projectId,
            pid: pidNum,
          }
        );
        // 停止失败不影响后续删除流程，继续执行
      }
    }

    // 2. 删除项目相关目录
    const directoriesToDelete = [
      path.join(config.UPLOAD_PROJECT_DIR, projectId),
      resolveProjectPath(projectId, isolationContext),
      path.join(config.DIST_TARGET_DIR, projectId),
      path.join(config.LOG_BASE_DIR, projectId),
    ];

    const deletedDirs = [];
    const failedDirs = [];

    for (const dirPath of directoriesToDelete) {
      if (fs.existsSync(dirPath)) {
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          deletedDirs.push(dirPath);
          log(logId, "INFO", `[delete-project] Directory deleted successfully: ${dirPath}`, {
            projectId,
          });
        } catch (error) {
          failedDirs.push({ path: dirPath, error: error.message });
          log(logId, "ERROR", `[delete-project] Directory deleted failed: ${dirPath}`, {
            projectId,
            error: error.message,
          });
        }
      } else {
        log(
          logId,
          "INFO",
          `[delete-project] Directory does not exist, skipping deletion: ${dirPath}`,
          {
            projectId,
          }
        );
      }
    }

    // 3. 返回删除结果
    const result = {
      success: true,
      message: `Project ${projectId} deleted successfully`,
      projectId,
      deletedDirectories: deletedDirs,
      failedDirectories: failedDirs,
    };

    if (failedDirs.length > 0) {
      result.message += `, but ${failedDirs.length} directories deleted failed`;
      log(logId, "WARN", "[delete-project] Some directories deleted failed", {
        projectId,
        failedDirs,
      });
    }

    log(logId, "INFO", `[delete-project] Project deleted successfully: ${projectId}`, {
      projectId,
      elapsedMs: Date.now() - startTime,
    });
    return result;
  } catch (error) {
    log(logId, "ERROR", `[delete-project] Failed to delete project: ${error.message}`, {
      projectId,
      originalError: error.message,
      elapsedMs: Date.now() - startTime,
    });

    // 如果错误不是自定义的错误类型，包装为系统错误
    if (!error.isOperational) {
      throw new SystemError(`Failed to delete project: ${error.message}`, {
        projectId,
        originalError: error.message,
      });
    }

    throw error;
  }
}

/**
 * 导出当前项目为zip包
 * @param {string} projectId 项目ID
 * @param {number|string} codeVersion 导出版本号
 * @param {string} exportType 导出类型(LATEST,PUBLISHED)
 * @param {Object} configParam 配置数据
 * @returns {Promise<{success:boolean, projectId:string, zipPath:string}>}
 */
async function exportProject(
  projectId,
  codeVersion,
  exportType,
  configParam,
  isolationContext = {}
) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion cannot be empty", {
      field: "codeVersion",
    });
  }
  const versionNum = Number(codeVersion);
  if (!Number.isFinite(versionNum)) {
    throw new ValidationError("codeVersion must be a number", {
      field: "codeVersion",
    });
  }

  const projectPath = resolveProjectPath(projectId, isolationContext);
  if (!fs.existsSync(projectPath)) {
    throw new ResourceError("Project does not exist", { projectId });
  }

  const backupDir = path.join(config.UPLOAD_PROJECT_DIR, projectId);
  const zipName = `${projectId}-v${versionNum}.zip`;
  const zipPath = path.join(backupDir, zipName);

  // 如果导出类型不是LATEST，直接查找现成的zip包返回
  if (exportType !== "LATEST") {
    if (fs.existsSync(zipPath)) {
      log(projectId, "INFO", `Using existing export file: ${zipPath}`, {
        projectId,
        zipPath,
      });
      return { success: true, projectId, zipPath };
    } else {
      throw new ResourceError(`Specified version zip file does not exist: ${zipPath}`, {
        projectId,
        zipPath,
      });
    }
  }

  // 导出类型是LATEST，直接打zip包
  const configFilePath = path.join(projectPath, "cpage_config.json");
  let configFileCreated = false;

  try {
    // 如果提供了config参数，先写入项目根目录
    if (configParam) {
      try {
        const configJson = JSON.stringify(configParam, null, 2);
        await fs.promises.writeFile(configFilePath, configJson, "utf8");
        configFileCreated = true;
        log(projectId, "INFO", `Configuration file created successfully: ${configFilePath}`, {
          projectId,
          configFilePath,
        });
      } catch (configErr) {
        log(projectId, "ERROR", `Failed to create configuration file: ${configErr.message}`, {
          projectId,
          error: configErr.message,
        });
        throw new FileError("Failed to create configuration file", {
          projectId,
          configFilePath,
          originalError: configErr.message,
        });
      }
    }

    // 执行导出（不管有没有现成的zip包，都直接打zip包）
    log(projectId, "DEBUG", "Start executing export and packaging", { projectId, codeVersion });
    const outZipPath = await backupProjectOfVersion(
      projectId,
      codeVersion,
      isolationContext
    );
    log(projectId, "INFO", `Project exported successfully: ${outZipPath}`, {
      projectId,
      zipPath: outZipPath,
      elapsedMs: Date.now() - startTime,
    });
    return { success: true, projectId, zipPath: outZipPath };
  } catch (e) {
    log(projectId, "ERROR", `Failed to export project: ${e?.message}`, {
      projectId,
      elapsedMs: Date.now() - startTime,
    });
    if (!e.isOperational) {
      throw new SystemError("Failed to export project", {
        projectId,
        originalError:
          e && e.message ? sanitizeSensitivePaths(e.message) : e && e.message,
      });
    }
    throw e;
  } finally {
    // 如果有创建配置文件，导出完成后删除
    if (configFileCreated && fs.existsSync(configFilePath)) {
      try {
        await fs.promises.unlink(configFilePath);
        log(projectId, "INFO", `Temporary configuration file deleted successfully: ${configFilePath}`, {
          projectId,
          configFilePath,
        });
      } catch (deleteErr) {
        log(projectId, "WARN", `Failed to delete temporary configuration file: ${deleteErr.message}`, {
          projectId,
          error: deleteErr.message,
        });
        // 删除失败不影响导出结果
      }
    }
  }
}

/**
 * 备份当前项目为指定版本zip
 */
async function backupCurrentVersion(projectId, codeVersion, isolationContext = {}) {
  const startTime = Date.now();
  if (!projectId) {
    throw new ValidationError("Project ID cannot be empty", { field: "projectId" });
  }
  if (codeVersion === undefined || codeVersion === null) {
    throw new ValidationError("codeVersion cannot be empty", {
      field: "codeVersion",
    });
  }

  try {
    const zipPath = await backupProjectOfVersion(
      projectId,
      codeVersion,
      isolationContext
    );
    log(projectId, "INFO", `Current version backed up successfully: ${zipPath}`, {
      projectId,
      zipPath,
      elapsedMs: Date.now() - startTime,
    });
    return { success: true, projectId, zipPath };
  } catch (e) {
    log(projectId, "ERROR", `Failed to backup current version: ${e?.message}`, {
      projectId,
      elapsedMs: Date.now() - startTime,
    });
    if (!e.isOperational) {
      throw new SystemError("Failed to backup current version", {
        projectId,
        originalError:
          e && e.message ? sanitizeSensitivePaths(e.message) : e && e.message,
      });
    }
    throw e;
  }
}

export {
  createProject,
  uploadProject,
  backupCurrentVersion,
  exportProject,
  backupProjectOfVersion,
  cleanupProjectDirectory,
  handleFileUpload,
  pushSkillsToWorkspace,
  deleteProject,
};
export default {
  createProject,
  uploadProject,
  backupCurrentVersion,
  exportProject,
  backupProjectOfVersion,
  cleanupProjectDirectory,
  handleFileUpload,
  pushSkillsToWorkspace,
  deleteProject,
};
