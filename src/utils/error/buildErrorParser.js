import { log } from "../log/logUtils.js";
import path from "path";
import { sanitizeSensitivePaths } from "../common/sensitiveUtils.js";

/**
 * 构建错误解析器
 * 用于解析构建错误并提供用户友好的错误信息和修复建议
 */
class BuildErrorParser {
  constructor() {
    // 常见错误类型和对应的修复建议
    this.errorPatterns = [
      {
        name: "正则表达式HTML标签转义错误",
        pattern: /html\.match\(\/<title>\(\.\*\?\)<\/title>\/i\)/,
        suggestion:
          "在正则表达式中，HTML标签的尖括号需要转义。请将 `</title>` 修改为 `</title>`",
        example: {
          wrong: "html.match(/<title>(.*?)</title>/i)",
          correct: "html.match(/<title>(.*?)<\\/title>/i)",
        },
      },
      {
        name: "JavaScript语法错误",
        pattern: /Parse error|SyntaxError|Unexpected token/,
        suggestion: "检查代码语法，确保括号、引号、分号等符号正确配对",
        example: null,
      },
      {
        name: "模块导入错误",
        pattern: /Cannot resolve module|Module not found/,
        suggestion: "检查导入路径是否正确，确保模块文件存在",
        example: null,
      },
      {
        name: "TypeScript类型错误",
        pattern: /Type error|Type '.*' is not assignable/,
        suggestion: "检查变量类型定义，确保类型匹配",
        example: null,
      },
      {
        name: "依赖缺失错误",
        pattern: /Cannot find module|Module not found/,
        suggestion: "运行 `pnpm install` 安装缺失的依赖包",
        example: null,
      },
    ];
  }

  /**
   * 解析构建错误信息并生成用户友好的指导信息
   * @param {string} errorMessage - 构建错误消息
   * @param {string} projectId - 项目ID
   * @returns {string} 用户友好的错误指导信息
   */
  parseBuildError(errorMessage, projectId) {
    try {
      log(projectId, "INFO", "开始解析构建错误", { errorMessage });

      // 提取文件路径和位置信息
      const fileInfo = this.extractFileInfo(errorMessage);

      // 提取错误类型和描述
      const errorDetails = this.extractErrorDetails(errorMessage);

      // 匹配错误模式并提供建议
      const suggestions = this.getErrorSuggestions(errorMessage);

      // 生成用户友好的错误指导信息
      const userFriendlyMessage = this.generateUserFriendlyMessage(
        errorDetails,
        fileInfo,
        suggestions,
        errorMessage
      );

      log(projectId, "INFO", "构建错误解析完成", {
        errorType: errorDetails.type,
        fileName: fileInfo?.path ? path.basename(fileInfo.path) : null,
        suggestionsCount: suggestions.length,
      });

      return userFriendlyMessage;
    } catch (error) {
      log(projectId, "ERROR", "解析构建错误时发生异常", {
        error: error.message,
        stack: error.stack,
      });

      return "构建失败，请检查构建日志中的详细错误信息，或联系技术支持。";
    }
  }

  /**
   * 提取文件信息
   * @param {string} errorMessage - 错误消息
   * @returns {Object|null} 文件信息
   */
  extractFileInfo(errorMessage) {
    // 匹配文件路径和行号
    const fileMatch = errorMessage.match(/file:\s*([^\n]+):(\d+):(\d+)/);
    if (!fileMatch) {
      return null;
    }

    const [, filePath, lineNumber, columnNumber] = fileMatch;

    return {
      path: filePath.trim(),
      line: parseInt(lineNumber),
      column: parseInt(columnNumber),
      relativePath: this.getRelativePath(filePath.trim()),
    };
  }

  /**
   * 提取错误详情
   * @param {string} errorMessage - 错误消息
   * @returns {Object} 错误详情
   */
  extractErrorDetails(errorMessage) {
    // 匹配错误类型
    const errorTypeMatch = errorMessage.match(
      /(Parse error|SyntaxError|TypeError|ReferenceError|Unexpected token)/
    );
    const errorType = errorTypeMatch ? errorTypeMatch[1] : "构建错误";

    // 提取错误描述
    let errorMessage_clean = errorMessage;

    // 尝试提取更具体的错误描述
    const descriptionMatch = errorMessage.match(
      /(?:Parse error|SyntaxError|TypeError|ReferenceError)[^:]*:\s*([^\n]+)/
    );
    if (descriptionMatch) {
      errorMessage_clean = descriptionMatch[1].trim();
    } else {
      // 提取第一行有意义的错误信息
      const lines = errorMessage.split("\n");
      for (const line of lines) {
        if (line.trim() && !line.includes("file:") && !line.includes("at ")) {
          errorMessage_clean = line.trim();
          break;
        }
      }
    }

    return {
      type: errorType,
      message: errorMessage_clean,
    };
  }

  /**
   * 获取错误修复建议
   * @param {string} errorMessage - 错误消息
   * @returns {Array} 建议列表
   */
  getErrorSuggestions(errorMessage) {
    const suggestions = [];

    // 匹配预定义的错误模式
    for (const pattern of this.errorPatterns) {
      if (pattern.pattern.test(errorMessage)) {
        suggestions.push({
          type: pattern.name,
          message: pattern.suggestion,
          priority: "high",
          example: pattern.example,
        });
      }
    }

    // 如果没有匹配到特定模式，提供通用建议
    if (suggestions.length === 0) {
      suggestions.push({
        type: "通用建议",
        message: "请仔细检查错误信息中提到的文件和行号，确保代码语法正确",
        priority: "medium",
      });
    }

    // 添加文件检查建议
    const fileInfo = this.extractFileInfo(errorMessage);
    if (fileInfo) {
      const fileName = path.basename(fileInfo.path);
      suggestions.push({
        type: "文件检查",
        message: `请检查文件 ${fileName} 第 ${fileInfo.line} 行第 ${fileInfo.column} 列附近的代码`,
        priority: "high",
      });
    }

    return suggestions;
  }

  /**
   * 提取代码上下文
   * @param {string} errorMessage - 错误消息
   * @returns {Object|null} 代码上下文
   */
  extractCodeContext(errorMessage) {
    const lines = errorMessage.split("\n");
    const context = {
      before: [],
      error: null,
      after: [],
    };

    let foundErrorLine = false;
    let lineNumber = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 匹配行号格式: "82:   const titleMatch = html.match(/<title>(.*?)</title>/i)"
      const lineMatch = line.match(/^\s*(\d+):\s*(.*)$/);
      if (lineMatch) {
        const [, num, content] = lineMatch;
        lineNumber = parseInt(num);

        if (!foundErrorLine) {
          context.before.push({ line: lineNumber, content: content.trim() });
        } else {
          context.after.push({ line: lineNumber, content: content.trim() });
        }
      }

      // 查找错误标记行 "^"
      if (line.includes("^") && !foundErrorLine) {
        foundErrorLine = true;
        // 错误行是上一行
        if (context.before.length > 0) {
          const errorLine = context.before.pop();
          context.error = errorLine;
        }
      }
    }

    // 限制上下文行数
    context.before = context.before.slice(-3); // 最多3行
    context.after = context.after.slice(0, 3); // 最多3行

    return context.before.length > 0 ||
      context.error ||
      context.after.length > 0
      ? context
      : null;
  }

  /**
   * 获取相对路径
   * @param {string} absolutePath - 绝对路径
   * @returns {string} 相对路径
   */
  getRelativePath(absolutePath) {
    // 脱敏处理：移除敏感路径信息
    const sanitizedPath = this.sanitizePath(absolutePath);

    // 尝试提取项目相关的相对路径
    const projectMatch = sanitizedPath.match(
      /project_workspace\/[^\/]+\/(.+)$/
    );
    if (projectMatch) {
      return projectMatch[1];
    }

    // 如果无法提取，返回文件名
    const pathParts = sanitizedPath.split("/");
    return pathParts[pathParts.length - 1];
  }

  /**
   * 脱敏路径信息
   * @param {string} path - 原始路径
   * @returns {string} 脱敏后的路径
   */
  sanitizePath(path) {
    return sanitizeSensitivePaths(path);
  }

  /**
   * 生成用户友好的错误指导信息
   * @param {Object} errorDetails - 错误详情
   * @param {Object} fileInfo - 文件信息
   * @param {Array} suggestions - 修复建议
   * @param {string} originalError - 原始错误信息
   * @returns {string} 用户友好的错误指导信息
   */
  generateUserFriendlyMessage(
    errorDetails,
    fileInfo,
    suggestions,
    originalError
  ) {
    let message = "构建失败！\n\n";

    // 添加错误类型和基本描述
    message += `错误类型: ${errorDetails.type}\n`;
    message += `错误描述: ${errorDetails.message}\n\n`;

    // 添加文件位置信息
    if (fileInfo) {
      const fileName = path.basename(fileInfo.path);
      message += `📍 错误位置:\n`;
      message += `   文件: ${fileName}\n`;
      message += `   行号: 第 ${fileInfo.line} 行，第 ${fileInfo.column} 列\n\n`;
    }

    // 添加修复建议
    if (suggestions.length > 0) {
      message += `🔧 修复建议:\n`;
      suggestions.forEach((suggestion, index) => {
        message += `   ${index + 1}. ${suggestion.message}\n`;

        // 如果有代码示例，添加到建议中
        if (suggestion.example) {
          message += `      错误写法: ${suggestion.example.wrong}\n`;
          message += `      正确写法: ${suggestion.example.correct}\n`;
        }
      });
      message += "\n";
    }

    // 添加通用指导
    message += `💡 操作步骤:\n`;
    message += `   1. 请根据上述建议修改代码\n`;
    message += `   2. 保存文件后重新构建项目\n`;
    message += `   3. 如果问题仍然存在，请检查其他相关文件\n\n`;

    // 添加联系信息
    message += `📞 需要帮助？\n`;
    message += `   如果无法解决此问题，请联系技术支持并提供完整的错误信息。`;

    return message;
  }
}

export default BuildErrorParser;
