import fs from "fs";
import path from "path";
import { log } from "../log/logUtils.js";

/**
 * 检测前端框架
 * @param {string} projectPath 项目路径
 * @returns {string} "react" | "vue" | "other"
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
        return "vue";
      }
    }

    return "other";
  } catch (error) {
    log(null, "WARN", `检测前端框架失败: ${error.message}`, {
      projectPath,
      error: error.message,
    });
    return "other";
  }
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
    log(null, "WARN", `检测开发框架失败: ${error.message}`, {
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


