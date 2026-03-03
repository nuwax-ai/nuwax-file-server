/**
 * 环境变量工具模块
 *
 * 功能:
 * - 从命令行参数加载环境变量
 * - 支持通过命令行参数覆盖环境变量
 * - 支持 --env-file 指定自定义配置文件
 * - 处理 Windows 环境变量大小写不敏感问题
 *
 * 优先级:
 * 1. 命令行参数 (最高)
 * 2. 环境变量文件 (.env.production 等)
 * 3. 系统环境变量
 * 4. 默认值 (最低)
 */

import path from "path";
import fs from "fs-extra";
import dotenv from "dotenv";

/**
 * 检测当前操作系统是否为 Windows
 * 
 * @returns {boolean} 是否为 Windows 系统
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * 规范化环境变量名
 * 
 * Windows 环境变量不区分大小写，统一转为大写
 * 
 * @param {string} name - 环境变量名
 * @returns {string} 规范化后的变量名
 */
function normalizeEnvName(name) {
  // Windows 环境变量不区分大小写，统一转为大写
  if (isWindows()) {
    return name.toUpperCase();
  }
  return name;
}

/**
 * 获取环境变量值
 * 
 * 支持 Windows 环境变量大小写不敏感
 * 
 * @param {string} name - 环境变量名
 * @param {*} defaultValue - 默认值
 * @returns {*} 环境变量值或默认值
 */
function getEnv(name, defaultValue = undefined) {
  const normalizedName = normalizeEnvName(name);
  
  // 优先从 process.env 获取
  if (process.env[normalizedName] !== undefined) {
    return process.env[normalizedName];
  }
  
  // 回退到原始名称（兼容某些库）
  if (name !== normalizedName && process.env[name] !== undefined) {
    return process.env[name];
  }
  
  return defaultValue;
}

/**
 * 获取布尔类型的环境变量值
 * 
 * @param {string} name - 环境变量名
 * @param {boolean} defaultValue - 默认值
 * @returns {boolean} 布尔值
 */
function getBoolEnv(name, defaultValue = false) {
  const value = getEnv(name);
  
  if (value === undefined) {
    return defaultValue;
  }
  
  // 转换为小写后比较
  const lowerValue = String(value).toLowerCase();
  
  return lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';
}

/**
 * 获取数字类型的环境变量值
 * 
 * @param {string} name - 环境变量名
 * @param {number} defaultValue - 默认值
 * @returns {number|null} 数字值或 null（如果解析失败）
 */
function getNumberEnv(name, defaultValue = undefined) {
  const value = getEnv(name);
  
  if (value === undefined) {
    return defaultValue;
  }
  
  const parsed = Number(value);
  
  if (Number.isNaN(parsed)) {
    console.warn(`环境变量 ${name} 值 "${value}" 不是有效的数字`);
    return defaultValue;
  }
  
  return parsed;
}

/**
 * 解析环境类型
 * 
 * @param {string} env - 环境名称
 * @returns {string} 标准化的环境名称
 */
function parseEnvType(env) {
  if (!env) {
    return 'production';
  }
  
  const normalizedEnv = env.toLowerCase().trim();
  
  // 标准化环境名称
  const envMap = {
    'dev': 'development',
    'test': 'test',
    'prod': 'production',
    'production': 'production',
    'development': 'development',
    'staging': 'staging',
  };
  
  return envMap[normalizedEnv] || 'production';
}

/**
 * 加载环境文件
 * 
 * 根据环境类型加载对应的 .env 文件
 * 
 * @param {string} env - 环境类型
 * @param {Object} options - 选项
 * @param {string} [options.basePath] - 基础路径（默认当前工作目录）
 * @returns {Object} 加载结果
 */
function loadEnvFile(env, options = {}) {
  const basePath = options.basePath || process.cwd();
  const envType = parseEnvType(env);
  
  // 环境文件名映射
  const envFileNames = [
    `.env.${envType}`,      // .env.production
    `.env.${envType}.local`, // .env.production.local（优先）
    '.env.local',
    '.env',
  ];
  
  const loadedFiles = [];
  const result = {
    loaded: false,
    files: loadedFiles,
    env: envType,
  };
  
  for (const fileName of envFileNames) {
    const filePath = path.join(basePath, fileName);
    
    if (fs.existsSync(filePath)) {
      try {
        // 使用 dotenv 解析环境文件
        const parsed = dotenv.config({
          path: filePath,
          override: false, // 不覆盖已存在的环境变量
        });
        
        if (parsed.error) {
          console.warn(`加载环境文件 ${fileName} 失败: ${parsed.error.message}`);
        } else {
          loadedFiles.push(filePath);
          result.loaded = true;
        }
      } catch (err) {
        console.warn(`加载环境文件 ${fileName} 出错: ${err.message}`);
      }
    }
  }
  
  if (loadedFiles.length > 0) {
    console.log(`已加载环境文件: ${loadedFiles.join(', ')}`);
  }
  
  return result;
}

/**
 * 加载自定义配置文件
 * 
 * 支持 JSON 和 .env 格式的配置文件
 * 
 * @param {string} configPath - 配置文件路径
 * @returns {Object} 加载结果
 */
function loadCustomConfigFile(configPath) {
  const result = {
    loaded: false,
    path: configPath,
    data: {},
  };
  
  if (!configPath) {
    return result;
  }
  
  if (!fs.existsSync(configPath)) {
    console.warn(`配置文件不存在: ${configPath}`);
    return result;
  }
  
  try {
    const ext = path.extname(configPath).toLowerCase();
    
    if (ext === '.json') {
      // JSON 格式
      const content = fs.readFileSync(configPath, 'utf8');
      result.data = JSON.parse(content);
      result.loaded = true;
    } else if (ext === '.env' || ext === '') {
      // .env 格式
      const dotenvResult = dotenv.config({
        path: configPath,
        override: true,
      });
      
      if (!dotenvResult.error) {
        result.loaded = true;
        // 从 process.env 提取加载的值
        Object.keys(dotenvResult.parsed || {}).forEach(key => {
          result.data[key] = process.env[key];
        });
      }
    } else {
      console.warn(`不支持的配置文件格式: ${ext}`);
    }
    
    console.log(`已加载配置文件: ${configPath}`);
  } catch (err) {
    console.error(`加载配置文件失败: ${err.message}`);
  }
  
  return result;
}

/**
 * 从命令行参数加载环境变量
 * 
 * 解析 process.argv，提取环境变量设置
 * 
 * @returns {Object} 提取的环境变量对象
 */
function loadEnvFromArgv() {
  const result = {};
  
  // 命令行参数模式: --<name>=<value> 或 --<name> <value>
  const argv = process.argv.slice(2);
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    
    // 检查是否以 -- 开头
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value = null;
      
      // 检查是否有 = 分隔符
      if (key.includes('=')) {
        const parts = key.split('=');
        key = parts[0];
        value = parts.slice(1).join('=');
      } else {
        // 检查下一个参数是否是值（非以 -- 开头的参数）
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          value = argv[i + 1];
          i++; // 跳过下一个参数
        } else {
          value = 'true'; // 布尔标志
        }
      }
      
      // 排除已知的 CLI 选项
      const cliOptions = ['env', 'port', 'config', 'force', 'help', 'version'];
      if (!cliOptions.includes(key)) {
        result[normalizeEnvName(key)] = value;
      }
    }
  }
  
  return result;
}

/**
 * 应用环境变量到 process.env
 * 
 * 优先级: CLI 参数 > 自定义配置 > 环境文件 > 系统环境变量
 * 
 * @param {Object} options - 选项
 * @param {string} [options.env] - 环境类型
 * @param {string} [options.config] - 自定义配置文件路径
 * @param {string} [options.port] - 端口号
 * @param {string} [options.basePath] - 基础路径
 * @returns {Object} 最终环境配置
 */
function applyEnv(options = {}) {
  const { env, config, port, basePath } = options;
  
  // 1. 加载环境文件
  const envResult = loadEnvFile(env, { basePath });
  
  // 2. 加载自定义配置文件
  const configResult = loadCustomConfigFile(config);
  
  // 3. 设置环境类型
  const envType = envResult.env;
  process.env.NODE_ENV = envType;
  
  // 4. 应用端口
  if (port) {
    process.env.PORT = String(port);
  }
  
  // 5. 应用自定义配置文件的值
  if (configResult.loaded) {
    Object.entries(configResult.data).forEach(([key, value]) => {
      const normalizedKey = normalizeEnvName(key);
      // CLI 参数优先级最高，不覆盖
      if (process.env[normalizedKey] === undefined) {
        process.env[normalizedKey] = value;
      }
    });
  }
  
  // 6. 应用命令行参数
  const argvEnv = loadEnvFromArgv();
  Object.entries(argvEnv).forEach(([key, value]) => {
    process.env[key] = value;
  });
  
  // 返回最终配置
  return {
    env: envType,
    port: process.env.PORT,
    config: configResult.loaded ? configResult.path : null,
    files: envResult.files,
  };
}

/**
 * 创建环境配置摘要
 * 
 * 用于日志输出
 * 
 * @returns {string} 配置摘要字符串
 */
function createEnvSummary() {
  const summary = {
    env: process.env.NODE_ENV || 'unknown',
    port: process.env.PORT || 'default',
    platform: process.platform,
    nodeVersion: process.version,
  };
  
  return JSON.stringify(summary, null, 2);
}

// ESM 导出
export {
  isWindows,
  normalizeEnvName,
  getEnv,
  getBoolEnv,
  getNumberEnv,
  parseEnvType,
  loadEnvFile,
  loadCustomConfigFile,
  loadEnvFromArgv,
  applyEnv,
  createEnvSummary,
};

// 如果直接运行此文件，显示当前环境配置
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^.*[\/\\]/, ""))) {
  console.log('\n当前环境配置:\n');
  console.log(createEnvSummary());
  console.log('\n详细环境变量:\n');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('PORT:', process.env.PORT);
  console.log('CONFIG_FILE:', process.env.CONFIG_FILE);
  console.log('');
}
