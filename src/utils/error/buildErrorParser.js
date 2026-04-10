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
        name: "Regular expression HTML tag escape error",
        pattern: /html\.match\(\/<title>\(\.\*\?\)<\/title>\/i\)/,
        suggestion:
          "In regular expressions, the angle brackets of HTML tags need to be escaped. Please modify `</title>` to `</title>`",
        example: {
          wrong: "html.match(/<title>(.*?)</title>/i)",
          correct: "html.match(/<title>(.*?)<\\/title>/i)",
        },
      },
      {
        name: "JavaScript syntax error",
        pattern: /Parse error|SyntaxError|Unexpected token/,
        suggestion: "Check the code syntax, ensure that the parentheses, quotes, semicolons, etc. are correctly paired",
        example: null,
      },
      {
        name: "Module import error",
        pattern: /Cannot resolve module|Module not found/,
        suggestion: "Check the import path to ensure that the module file exists",
        example: null,
      },
      {
        name: "TypeScript type error",
        pattern: /Type error|Type '.*' is not assignable/,
        suggestion: "Check the variable type definition, ensure that the type matches",
        example: null,
      },
      {
        name: "Dependency missing error",
        pattern: /Cannot find module|Module not found/,
        suggestion: "Run `pnpm install` to install the missing dependency package",
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
      log(projectId, "INFO", "Start parsing build error", { errorMessage });

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

      log(projectId, "INFO", "Build error parsing completed", {
        errorType: errorDetails.type,
        fileName: fileInfo?.path ? path.basename(fileInfo.path) : null,
        suggestionsCount: suggestions.length,
      });

      return userFriendlyMessage;
    } catch (error) {
      log(projectId, "ERROR", "Exception occurred when parsing build error", {
        error: error.message,
        stack: error.stack,
      });

      return "Build failed, please check the detailed error information in the build log, or contact technical support.";
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
    const errorType = errorTypeMatch ? errorTypeMatch[1] : "Build error";

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
        type: "General suggestion",
        message: "Please carefully check the files and line numbers mentioned in the error information, ensure that the code syntax is correct",
        priority: "medium",
      });
    }

    // 添加文件检查建议
    const fileInfo = this.extractFileInfo(errorMessage);
    if (fileInfo) {
      const fileName = path.basename(fileInfo.path);
      suggestions.push({
        type: "File check",
        message: `Please check the code near line ${fileInfo.line} column ${fileInfo.column} in file ${fileName}`,
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
    let message = "Build failed!\n\n";

    // 添加错误类型和基本描述
    message += `Error type: ${errorDetails.type}\n`;
    message += `Error description: ${errorDetails.message}\n\n`;

    // 添加文件位置信息
    if (fileInfo) {
      const fileName = path.basename(fileInfo.path);
      message += `📍 Error location:\n`;
      message += `   File: ${fileName}\n`;
      message += `   Line: ${fileInfo.line}, Column: ${fileInfo.column}\n\n`;
    }

    // 添加修复建议
    if (suggestions.length > 0) {
      message += `🔧 Repair suggestions:\n`;
      suggestions.forEach((suggestion, index) => {
        message += `   ${index + 1}. ${suggestion.message}\n`;

        // 如果有代码示例，添加到建议中
        if (suggestion.example) {
          message += `      Wrong code: ${suggestion.example.wrong}\n`;
          message += `      Correct code: ${suggestion.example.correct}\n`;
        }
      });
      message += "\n";
    }

    // 添加通用指导
    message += `💡 Operation steps:\n`;
    message += `   1. Please modify the code according to the above suggestions\n`;
    message += `   2. Save the file and rebuild the project\n`;
    message += `   3. If the problem still exists, please check other related files\n\n`;

    // 添加联系信息
    message += `📞 Need help?\n`;
    message += `   If you cannot solve this problem, please contact technical support and provide complete error information.`;

    return message;
  }
}

export default BuildErrorParser;
