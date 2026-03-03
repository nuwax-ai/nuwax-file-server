import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { log } from "../log/logUtils.js";

/**
 * 在启动开发服务器前进行语法检查
 * 根据项目配置自动选择检查方式：
 * - TypeScript 项目：运行 tsc --noEmit
 * - 纯 JavaScript 项目：使用 esbuild 进行快速语法检查
 * - HTML 文件：使用 html-validate 进行 HTML 语法检查
 * 
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {number} timeoutMs 超时时间（毫秒）
 * @returns {Promise<Object>} { passed: boolean, error?: string, method?: string }
 */
async function runSyntaxCheck(projectId, projectPath, timeoutMs = 15000) {
  try {
    // 检查项目类型
    const projectType = detectProjectType(projectPath);
    
    log(projectId, "INFO", "开始语法检查", {
      projectId,
      projectType,
      timeoutMs,
    });

    const results = [];

    // 1. 代码检查（TypeScript/JavaScript）
    if (projectType === "typescript") {
      const tsResult = await runTypeScriptCheck(projectId, projectPath, timeoutMs);
      results.push(tsResult);
      
      // 如果 TS 检查失败，立即返回
      if (!tsResult.passed) {
        return tsResult;
      }
    } else if (projectType === "javascript") {
      const jsResult = await runJavaScriptCheck(projectId, projectPath, timeoutMs);
      results.push(jsResult);
      
      // 如果 JS 检查失败，立即返回
      if (!jsResult.passed) {
        return jsResult;
      }
    }

    // 2. HTML 文件检查
    const htmlResult = await runHtmlCheck(projectId, projectPath, timeoutMs);
    results.push(htmlResult);
    
    // 如果 HTML 检查失败，返回失败
    if (!htmlResult.passed) {
      return htmlResult;
    }

    // 所有检查都通过
    if (results.length === 0) {
      log(projectId, "INFO", "跳过语法检查：未检测到源代码文件", {
        projectId,
      });
      return { passed: true, method: "skipped" };
    }

    // 返回综合结果
    const methods = results.map(r => r.method).filter(Boolean).join(", ");
    const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
    
    log(projectId, "INFO", "所有语法检查通过", {
      projectId,
      methods,
      totalDuration,
    });

    return { 
      passed: true, 
      method: methods,
      duration: totalDuration,
    };
  } catch (error) {
    log(projectId, "WARN", "语法检查执行失败", {
      projectId,
      error: error.message,
    });
    // 检查失败不阻止启动
    return { passed: true, method: "error", error: error.message };
  }
}

/**
 * 检测项目类型
 * @param {string} projectPath 项目路径
 * @returns {string} "typescript" | "javascript" | "unknown"
 */
function detectProjectType(projectPath) {
  // 检查是否有 tsconfig.json
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    // 检查是否有 .ts 或 .tsx 文件
    const hasTsFiles = hasFilesWithExtension(projectPath, [".ts", ".tsx"]);
    if (hasTsFiles) {
      return "typescript";
    }
  }

  // 检查是否有 .js 或 .jsx 文件
  const hasJsFiles = hasFilesWithExtension(projectPath, [".js", ".jsx"]);
  if (hasJsFiles) {
    return "javascript";
  }

  return "unknown";
}

/**
 * 检查目录下是否存在指定扩展名的文件
 * @param {string} dir 目录路径
 * @param {Array<string>} extensions 扩展名列表
 * @param {number} maxDepth 最大搜索深度
 * @returns {boolean}
 */
function hasFilesWithExtension(dir, extensions, maxDepth = 3) {
  try {
    // 排除的目录
    const excludeDirs = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];
    
    function searchDir(currentDir, depth) {
      if (depth > maxDepth) return false;
      
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name)) {
            if (searchDir(fullPath, depth + 1)) {
              return true;
            }
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            return true;
          }
        }
      }
      
      return false;
    }
    
    return searchDir(dir, 0);
  } catch (error) {
    return false;
  }
}

/**
 * 运行 TypeScript 类型检查
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<Object>}
 */
async function runTypeScriptCheck(projectId, projectPath, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const tsconfigPath = path.join(projectPath, "tsconfig.json");
    const checkConfigPath = path.join(projectPath, "tsconfig.check.json");
    let createdCheckConfig = false;
    let createdTempTsconfig = false;
    
    // 创建专门用于语法检查的配置
    const createCheckConfig = (hasTsconfig) => {
      const config = {
        // 明确指定要检查的所有文件模式
        "include": [
          "src/**/*.ts",
          "src/**/*.tsx",
          "src/**/*.js",
          "src/**/*.jsx",
          "*.ts",
          "*.tsx"
        ],
        "exclude": ["node_modules", "dist", "build", ".next", ".nuxt", "**/*.spec.ts", "**/*.test.ts"]
      };
      
      // 如果用户有 tsconfig.json，继承它的 compilerOptions
      if (hasTsconfig) {
        config.extends = "./tsconfig.json";
        log(projectId, "INFO", "检查配置将继承用户的 tsconfig.json", {
          projectId,
        });
      } else {
        // 如果没有 tsconfig.json，需要提供完整的 compilerOptions
        config.compilerOptions = {
          "target": "ESNext",
          "lib": ["ESNext", "DOM"],
          "jsx": "react-jsx",
          "module": "ESNext",
          "moduleResolution": "bundler",
          "esModuleInterop": true,
          "allowSyntheticDefaultImports": true,
          "strict": false,
          "skipLibCheck": true,
          "noEmit": true,
          "allowJs": true,
          "checkJs": false
        };
      }
      
      return config;
    };
    
    const hasTsconfig = fs.existsSync(tsconfigPath);
    
    // 始终创建 tsconfig.check.json 用于检查
    try {
      const checkConfig = createCheckConfig(hasTsconfig);
      fs.writeFileSync(checkConfigPath, JSON.stringify(checkConfig, null, 2), "utf8");
      createdCheckConfig = true;
      
      log(projectId, "INFO", "创建临时 tsconfig.check.json 用于语法检查", {
        projectId,
        hasTsconfig,
        extends: checkConfig.extends || "无",
        include: checkConfig.include,
      });
    } catch (error) {
      log(projectId, "WARN", "无法创建 tsconfig.check.json", {
        projectId,
        error: error.message,
      });
      
      // 降级方案：如果无法创建检查配置且没有 tsconfig.json，创建临时的
      if (!hasTsconfig) {
        try {
          fs.writeFileSync(tsconfigPath, JSON.stringify(createCheckConfig(false), null, 2), "utf8");
          createdTempTsconfig = true;
          log(projectId, "INFO", "创建临时 tsconfig.json 作为降级方案", {
            projectId,
          });
        } catch (e) {
          log(projectId, "ERROR", "无法创建任何 TypeScript 配置文件", {
            projectId,
            error: e.message,
          });
        }
      }
    }
    
    // 优先使用项目本地的 tsc，如果不存在则使用 npx
    const localTscPath = path.join(projectPath, "node_modules", ".bin", "tsc");
    const usesLocalTsc = fs.existsSync(localTscPath);
    
    const command = usesLocalTsc ? localTscPath : "npx";
    // 使用 --project 参数指定检查配置文件
    const configToUse = createdCheckConfig ? "tsconfig.check.json" : "tsconfig.json";
    const args = usesLocalTsc 
      ? ["--project", configToUse, "--noEmit", "--skipLibCheck"] 
      : ["--yes", "tsc", "--project", configToUse, "--noEmit", "--skipLibCheck"];
    
    log(projectId, "INFO", "运行 TypeScript 类型检查", {
      projectId,
      command,
      args: args.join(" "),
      usesLocalTsc,
      configFile: configToUse,
    });
    
    const child = spawn(command, args, {
      cwd: projectPath,
      shell: true,
      timeout: timeoutMs,
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    
    // 清理临时文件的辅助函数
    const cleanupTempConfig = () => {
      // 清理检查配置文件
      if (createdCheckConfig) {
        try {
          if (fs.existsSync(checkConfigPath)) {
            fs.unlinkSync(checkConfigPath);
            log(projectId, "INFO", "已清理临时 tsconfig.check.json", {
              projectId,
            });
          }
        } catch (error) {
          log(projectId, "WARN", "清理 tsconfig.check.json 失败", {
            projectId,
            error: error.message,
          });
        }
      }
      
      // 清理临时创建的 tsconfig.json（降级方案）
      if (createdTempTsconfig) {
        try {
          if (fs.existsSync(tsconfigPath)) {
            fs.unlinkSync(tsconfigPath);
            log(projectId, "INFO", "已清理临时 tsconfig.json", {
              projectId,
            });
          }
        } catch (error) {
          log(projectId, "WARN", "清理 tsconfig.json 失败", {
            projectId,
            error: error.message,
          });
        }
      }
    };
    
    child.on("close", (code) => {
      const duration = Date.now() - startTime;
      
      // 清理临时配置
      cleanupTempConfig();
      
      if (code === 0) {
        log(projectId, "INFO", "TypeScript 类型检查通过", {
          projectId,
          duration,
        });
        resolve({ passed: true, method: "typescript", duration });
      } else {
        // 提取错误信息
        const errorOutput = stderr || stdout;
        const errorSummary = extractTypeScriptErrors(errorOutput);
        
        log(projectId, "ERROR", "TypeScript 类型检查失败", {
          projectId,
          code,
          duration,
          errorSummary,
        });
        
        resolve({
          passed: false,
          method: "typescript",
          error: errorSummary,
          fullOutput: errorOutput.substring(0, 2000), // 限制长度
          duration,
        });
      }
    });
    
    child.on("error", (error) => {
      // 清理临时配置
      cleanupTempConfig();
      
      log(projectId, "WARN", "TypeScript 检查执行失败", {
        projectId,
        error: error.message,
      });
      // 执行失败不阻止启动
      resolve({ passed: true, method: "typescript-error", error: error.message });
    });
    
    // 超时处理
    setTimeout(() => {
      try {
        child.kill();
        // 清理临时配置
        cleanupTempConfig();
        
        log(projectId, "WARN", "TypeScript 检查超时", {
          projectId,
          timeoutMs,
        });
        resolve({ passed: true, method: "typescript-timeout" });
      } catch (e) {
        cleanupTempConfig();
        resolve({ passed: true, method: "typescript-timeout-error" });
      }
    }, timeoutMs);
  });
}

/**
 * 运行 JavaScript 语法检查（使用 esbuild）
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<Object>}
 */
async function runJavaScriptCheck(projectId, projectPath, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    // 查找入口文件
    const entryFiles = findEntryFiles(projectPath);
    
    if (entryFiles.length === 0) {
      log(projectId, "INFO", "跳过 JavaScript 语法检查：未找到入口文件", {
        projectId,
      });
      resolve({ passed: true, method: "javascript-skipped" });
      return;
    }
    
    // 使用 esbuild 进行快速语法检查（不输出文件）
    const args = [
      "--yes",
      "esbuild",
      ...entryFiles,
      "--bundle",
      "--write=false",
      "--outdir=/tmp",
      "--format=esm",
    ];
    
    log(projectId, "INFO", "运行 JavaScript 语法检查", {
      projectId,
      entryFiles,
    });
    
    const child = spawn("npx", args, {
      cwd: projectPath,
      shell: true,
      timeout: timeoutMs,
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    
    child.on("close", (code) => {
      const duration = Date.now() - startTime;
      
      if (code === 0) {
        log(projectId, "INFO", "JavaScript 语法检查通过", {
          projectId,
          duration,
        });
        resolve({ passed: true, method: "javascript", duration });
      } else {
        const errorOutput = stderr || stdout;
        const errorSummary = errorOutput.substring(0, 1000);
        
        log(projectId, "ERROR", "JavaScript 语法检查失败", {
          projectId,
          code,
          duration,
          errorSummary,
        });
        
        resolve({
          passed: false,
          method: "javascript",
          error: errorSummary,
          fullOutput: errorOutput.substring(0, 2000),
          duration,
        });
      }
    });
    
    child.on("error", (error) => {
      log(projectId, "WARN", "JavaScript 检查执行失败", {
        projectId,
        error: error.message,
      });
      resolve({ passed: true, method: "javascript-error", error: error.message });
    });
    
    // 超时处理
    setTimeout(() => {
      try {
        child.kill();
        log(projectId, "WARN", "JavaScript 检查超时", {
          projectId,
          timeoutMs,
        });
        resolve({ passed: true, method: "javascript-timeout" });
      } catch (e) {
        resolve({ passed: true, method: "javascript-timeout-error" });
      }
    }, timeoutMs);
  });
}

/**
 * 查找入口文件
 * @param {string} projectPath 项目路径
 * @returns {Array<string>} 入口文件路径列表
 */
function findEntryFiles(projectPath) {
  const possibleEntries = [
    "src/main.js",
    "src/main.jsx",
    "src/main.ts",
    "src/main.tsx",
    "src/index.js",
    "src/index.jsx",
    "src/index.ts",
    "src/index.tsx",
    "src/app.js",
    "src/app.jsx",
    "src/App.js",
    "src/App.jsx",
    "index.js",
    "index.jsx",
    "index.ts",
    "index.tsx",
  ];
  
  const entries = [];
  for (const entry of possibleEntries) {
    const fullPath = path.join(projectPath, entry);
    if (fs.existsSync(fullPath)) {
      entries.push(entry);
    }
  }
  
  return entries;
}

/**
 * 确保项目有 HTML 验证配置文件（如果不存在则创建宽松配置）
 * @param {string} projectPath 项目路径
 * @returns {boolean} 是否创建了新配置
 */
function ensureHtmlValidateConfig(projectPath) {
  const configPath = path.join(projectPath, ".htmlvalidate.json");
  
  // 如果已经存在配置文件，不覆盖
  if (fs.existsSync(configPath)) {
    return false;
  }
  
  // 创建宽松的默认配置
  const defaultConfig = {
    "extends": ["html-validate:recommended"],
    "rules": {
      // 允许 void elements 不自闭合（HTML5 标准）
      "void-style": "off",
      // 允许不需要 SRI
      "require-sri": "off",
      // 允许尾部空白
      "no-trailing-whitespace": "off",
      // 允许内联样式（开发时常用）
      "no-inline-style": "off",
      // 允许重复的 ID（某些框架会动态处理）
      "no-dup-id": "warn",
      // 允许未使用的 disable 指令
      "no-unused-disable": "off"
    }
  };
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf8");
    return true;
  } catch (error) {
    // 创建失败不影响检查，使用默认规则
    return false;
  }
}

/**
 * 运行 HTML 语法检查
 * @param {string} projectId 项目ID
 * @param {string} projectPath 项目路径
 * @param {number} timeoutMs 超时时间
 * @returns {Promise<Object>}
 */
async function runHtmlCheck(projectId, projectPath, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    // 查找 HTML 文件
    const htmlFiles = findHtmlFiles(projectPath);
    
    if (htmlFiles.length === 0) {
      log(projectId, "INFO", "跳过 HTML 语法检查：未找到 HTML 文件", {
        projectId,
      });
      resolve({ passed: true, method: "html-skipped" });
      return;
    }
    
    // 确保有宽松的验证配置
    const configCreated = ensureHtmlValidateConfig(projectPath);
    if (configCreated) {
      log(projectId, "INFO", "自动创建宽松的 HTML 验证配置", {
        projectId,
        configPath: ".htmlvalidate.json",
      });
    }
    
    // 使用 html-validate 进行 HTML 语法检查
    const args = [
      "--yes",
      "html-validate",
      ...htmlFiles,
      "--formatter=text",
    ];
    
    log(projectId, "INFO", "运行 HTML 语法检查", {
      projectId,
      htmlFiles,
      fileCount: htmlFiles.length,
    });
    
    const child = spawn("npx", args, {
      cwd: projectPath,
      shell: true,
      timeout: timeoutMs,
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    
    child.on("close", (code) => {
      const duration = Date.now() - startTime;
      
      if (code === 0) {
        log(projectId, "INFO", "HTML 语法检查通过", {
          projectId,
          duration,
          fileCount: htmlFiles.length,
        });
        resolve({ passed: true, method: "html", duration });
      } else {
        const errorOutput = stdout || stderr;
        const errorSummary = extractHtmlErrors(errorOutput);
        
        log(projectId, "ERROR", "HTML 语法检查失败", {
          projectId,
          code,
          duration,
          errorSummary,
        });
        
        resolve({
          passed: false,
          method: "html",
          error: errorSummary,
          fullOutput: errorOutput.substring(0, 2000),
          duration,
        });
      }
    });
    
    child.on("error", (error) => {
      log(projectId, "WARN", "HTML 检查执行失败", {
        projectId,
        error: error.message,
      });
      // 执行失败不阻止启动
      resolve({ passed: true, method: "html-error", error: error.message });
    });
    
    // 超时处理
    setTimeout(() => {
      try {
        child.kill();
        log(projectId, "WARN", "HTML 检查超时", {
          projectId,
          timeoutMs,
        });
        resolve({ passed: true, method: "html-timeout" });
      } catch (e) {
        resolve({ passed: true, method: "html-timeout-error" });
      }
    }, timeoutMs);
  });
}

/**
 * 查找 HTML 文件
 * @param {string} projectPath 项目路径
 * @returns {Array<string>} HTML 文件相对路径列表
 */
function findHtmlFiles(projectPath) {
  const htmlFiles = [];
  
  // 常见的 HTML 文件位置
  const possibleLocations = [
    "index.html",
    "public/index.html",
    "src/index.html",
    "dist/index.html",
  ];
  
  // 检查常见位置
  for (const location of possibleLocations) {
    const fullPath = path.join(projectPath, location);
    if (fs.existsSync(fullPath)) {
      htmlFiles.push(location);
    }
  }
  
  // 如果没找到，递归搜索 public 和 src 目录
  if (htmlFiles.length === 0) {
    const dirsToSearch = ["public", "src", "."];
    
    for (const dir of dirsToSearch) {
      const dirPath = path.join(projectPath, dir);
      if (fs.existsSync(dirPath)) {
        const found = searchHtmlFilesInDir(dirPath, projectPath, 2);
        htmlFiles.push(...found);
      }
    }
  }
  
  // 去重
  return [...new Set(htmlFiles)];
}

/**
 * 递归搜索目录中的 HTML 文件
 * @param {string} dir 要搜索的目录
 * @param {string} basePath 基础路径（用于生成相对路径）
 * @param {number} maxDepth 最大搜索深度
 * @returns {Array<string>} HTML 文件相对路径列表
 */
function searchHtmlFilesInDir(dir, basePath, maxDepth = 2) {
  const htmlFiles = [];
  const excludeDirs = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];
  
  function search(currentDir, depth) {
    if (depth > maxDepth) return;
    
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name)) {
            search(fullPath, depth + 1);
          }
        } else if (entry.isFile() && entry.name.endsWith(".html")) {
          // 生成相对路径
          const relativePath = path.relative(basePath, fullPath);
          htmlFiles.push(relativePath);
        }
      }
    } catch (error) {
      // 忽略读取错误
    }
  }
  
  search(dir, 0);
  return htmlFiles;
}

/**
 * 从 HTML 错误输出中提取关键错误信息
 * @param {string} output 错误输出
 * @returns {string} 错误摘要
 */
function extractHtmlErrors(output) {
  if (!output) return "未知错误";
  
  const lines = output.split("\n");
  const errorLines = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // 提取 html-validate 的错误行
    // 格式: "error: ..." 或 "✖ ..." 或包含文件路径和行号
    if (
      trimmed.includes("error:") ||
      trimmed.includes("✖") ||
      /\.html:\d+:\d+/.test(trimmed) ||
      trimmed.includes("Element") ||
      trimmed.includes("Attribute")
    ) {
      errorLines.push(trimmed);
      if (errorLines.length >= 10) break; // 保留前10个错误
    }
  }
  
  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }
  
  // 如果没有找到特定格式的错误，返回前几行
  return lines.slice(0, 15).join("\n").trim().substring(0, 800);
}

/**
 * 从 TypeScript 错误输出中提取关键错误信息
 * @param {string} output 错误输出
 * @returns {string} 错误摘要
 */
function extractTypeScriptErrors(output) {
  if (!output) return "未知错误";
  
  const lines = output.split("\n");
  const errorLines = [];
  
  for (const line of lines) {
    // 提取错误行（包含文件路径和错误信息）
    if (line.includes("error TS") || line.includes("): error")) {
      errorLines.push(line.trim());
      if (errorLines.length >= 5) break; // 只保留前5个错误
    }
  }
  
  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }
  
  // 如果没有找到特定格式的错误，返回前几行
  return lines.slice(0, 10).join("\n").trim().substring(0, 500);
}

module.exports = {
  runSyntaxCheck,
  detectProjectType,
  findHtmlFiles,
  ensureHtmlValidateConfig,
};

