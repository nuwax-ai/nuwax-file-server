import { buildPortArgsForScript } from "./portUtils.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";
import portPool from "./portPool.js";

/**
 * 额外参数工具类
 * 封装端口参数、basePath 参数和环境变量的处理逻辑
 */
class ExtraArgsUtils {
  /**
   * 处理启动参数和环境变量
   * @param {Object} options 配置选项
   * @param {string} options.devScript dev脚本内容
   * @param {string} options.projectId 项目ID
   * @param {Object} options.req 请求对象（用于读取basePath）
   * @returns {Promise<Object>} { extraArgs, envExtra, port }
   */
  static async processExtraArgs({ devScript, projectId, req }) {
    const extraArgs = [];
    const envExtra = {};
    const lower = (devScript || "").toLowerCase();

    const isVite = lower.includes("vite");
    const isNext = lower.includes("next");

    // 仅支持 vite 和 next.js，其余直接返回空
    if (!isVite && !isNext) {
      return { extraArgs, envExtra };
    }

    // -- basePath --
    if (req) {
      let basePath = "";
      // 从请求中读取 basePath
      if (req.body && req.body.basePath) {
        // 支持字符串类型或通过 express 解析的其他类型
        basePath = String(req.body.basePath);
      } else if (req.query && req.query.basePath) {
        // 支持字符串类型或通过 express 解析的其他类型
        basePath = String(req.query.basePath);
      }
      
      // 获取 projectId 用于日志（从 query 或 body 中）
      const projectId = (req.query && req.query.projectId) || (req.body && req.body.projectId) || "unknown";
      if (basePath) {
        log(projectId, "INFO", "读取到 basePath", { 
          basePath: basePath,
          source: req.body && req.body.basePath ? "body" : "query"
        });
      }
      
      // 规范化 basePath：以 / 开头和结尾
      if (basePath && basePath.trim()) {
        basePath = basePath.trim();
        if (!basePath.startsWith("/")) {
          basePath = "/" + basePath;
        }
        if (!basePath.endsWith("/")) {
          basePath = basePath + "/";
        }

        if (isVite) {
          // Vite 使用 --base 参数
          extraArgs.push("--base", basePath);
        } else if (isNext) {
          // Next 不支持 --base，改为通过环境变量传递
          envExtra.NEXT_PUBLIC_BASE_PATH = basePath;
          envExtra.BASE_PATH = basePath; // 兼容项目自定义读取
        }
      }
    }

    // -- port --
    // 从端口池分配端口（如果已分配会自动复用）
    const port = portPool.allocate(String(projectId));
    
    const portArgs = buildPortArgsForScript(devScript, port);
    if (portArgs.length > 0) {
      extraArgs.push(...portArgs);
    }

    // -- host --
    if (isVite) {
      const host = "0.0.0.0";
      extraArgs.push("--host", host);
    }

    return { extraArgs, envExtra, port };
  }

}

export default ExtraArgsUtils;