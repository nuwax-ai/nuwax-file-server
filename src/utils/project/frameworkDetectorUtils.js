import fs from "fs";
import path from "path";
import { log } from "../log/logUtils.js";

/**
 * 检测前端框架
 * @param {string} projectPath 项目路径
 * @returns {string} "react" | "vue{major}" | "vue" | "other"
 */
function detectFrontendFramework(projectPath) {
  try {
    // 检查 package.json 是否存在
    const packageJsonPath = path.join(projectPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8")
      );
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // 检查是否有 react 依赖
      if (dependencies.react || dependencies["react-dom"]) {
        return "react";
      }

      // 检查是否有 vue 依赖
      if (dependencies.vue || dependencies["vue-router"] || dependencies["@vue/cli-service"]) {
        // 尝试从多个 Vue 相关依赖中识别主版本，优先返回 vue2/vue3
        const versionCandidates = [
          dependencies.vue,
          dependencies["vue-router"],
          dependencies["@vue/cli-service"],
        ];
        for (const versionRaw of versionCandidates) {
          if (typeof versionRaw !== "string") {
            continue;
          }
          const majorVersion = parseVueMajorVersion(versionRaw);
          if (Number.isFinite(majorVersion)) {
            return `vue${majorVersion}`;
          }
        }
        // 兜底：识别到 Vue 但无法判断版本
        return "vue";
      }
    }

    return "other";
  } catch (error) {
    log(null, "WARN", `Detect frontend framework failed: ${error.message}`, {
      projectPath,
      error: error.message,
    });
    return "other";
  }
}

/**
 * 解析 Vue 主版本号
 * @param {string} versionString Vue 版本字符串
 * @returns {number|null}
 */
function parseVueMajorVersion(versionString) {
  if (!versionString) {
    return null;
  }

  let normalized = String(versionString).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  // npm alias 形式：npm:vue@^3.4.0
  if (normalized.startsWith("npm:")) {
    const aliasMatched = normalized.match(/^npm:[^@]+@(.+)$/);
    if (aliasMatched && aliasMatched[1]) {
      normalized = aliasMatched[1];
    }
  }

  // semver 常见形式：3.4.0 / ^3.4.0 / ~2.7.16 / >=3 / <=2 / 2.x / v3.2.0 / 3
  // 取第一个独立数字段，避免误取诸如 github 分支名中的数字片段
  const semverMatched = normalized.match(/(?:^|[^\d])v?(\d+)(?:\.|x|\b)/);
  if (semverMatched) {
    const major = Number(semverMatched[1]);
    return Number.isFinite(major) ? major : null;
  }

  // 其余非标准格式（workspace/file/link/git/url）不强判
  return null;
}

/**
 * 检测开发框架
 * @param {string} projectPath 项目路径
 * @returns {string} "vite" | "nextjs" | "other"
 */
function detectDevFramework(projectPath) {
  try {
    // 检查是否有 next.config 文件（优先级高于 vite）
    const nextConfigPatterns = [
      "next.config.js",
      "next.config.ts",
      "next.config.mjs",
      "next.config.cjs",
    ];

    for (const configFile of nextConfigPatterns) {
      const configPath = path.join(projectPath, configFile);
      if (fs.existsSync(configPath)) {
        return "nextjs";
      }
    }

    // 检查是否有 vite.config 文件
    const viteConfigPatterns = [
      "vite.config.js",
      "vite.config.ts",
      "vite.config.mjs",
      "vite.config.cjs",
    ];

    for (const configFile of viteConfigPatterns) {
      const configPath = path.join(projectPath, configFile);
      if (fs.existsSync(configPath)) {
        return "vite";
      }
    }

    return "other";
  } catch (error) {
    log(null, "WARN", `Detect development framework failed: ${error.message}`, {
      projectPath,
      error: error.message,
    });
    return "other";
  }
}

/**
 * 获取项目框架信息
 * @param {string} projectPath 项目路径
 * @returns {Object} { frontendFramework: string, devFramework: string }
 */
function getFrameworkInfo(projectPath) {
  const frontendFramework = detectFrontendFramework(projectPath);
  const devFramework = detectDevFramework(projectPath);

  return {
    frontendFramework,
    devFramework,
  };
}

export { detectFrontendFramework, detectDevFramework, getFrameworkInfo };


