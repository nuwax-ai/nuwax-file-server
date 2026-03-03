import {
  ValidationError,
  BusinessError,
  SystemError,
  ResourceError,
  FileError,
  ProcessError,
  formatErrorResponse,
  classifyError,
} from "../../src/utils/error/errorHandler.js";

describe("错误处理工具测试", () => {
  describe("自定义错误类", () => {
    test("ValidationError 应该正确创建", () => {
      const error = new ValidationError("测试错误", { field: "test" });
      expect(error.name).toBe("ValidationError");
      expect(error.message).toBe("测试错误");
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({ field: "test" });
      expect(error.isOperational).toBe(true);
    });

    test("BusinessError 应该正确创建", () => {
      const error = new BusinessError("业务错误");
      expect(error.name).toBe("BusinessError");
      expect(error.statusCode).toBe(400);
    });

    test("SystemError 应该正确创建", () => {
      const error = new SystemError("系统错误");
      expect(error.name).toBe("SystemError");
      expect(error.statusCode).toBe(500);
    });

    test("ResourceError 应该正确创建", () => {
      const error = new ResourceError("资源不存在");
      expect(error.name).toBe("ResourceError");
      expect(error.statusCode).toBe(404);
    });

    test("FileError 应该正确创建", () => {
      const error = new FileError("文件错误");
      expect(error.name).toBe("FileError");
      expect(error.statusCode).toBe(500);
    });

    test("ProcessError 应该正确创建", () => {
      const error = new ProcessError("进程错误");
      expect(error.name).toBe("ProcessError");
      expect(error.statusCode).toBe(500);
    });
  });

  describe("formatErrorResponse", () => {
    test("应该正确格式化错误响应", () => {
      const error = new ValidationError("测试错误", { field: "test" });
      const response = formatErrorResponse(error, "req-123");

      expect(response.success).toBe(false);
      expect(response.error.type).toBe("VALIDATION_ERROR");
      expect(response.error.message).toBe("测试错误");
      expect(response.error.requestId).toBe("req-123");
    });

    test("应该包含 timestamp", () => {
      const error = new BusinessError("测试");
      const response = formatErrorResponse(error);

      expect(response.error.timestamp).toBeDefined();
    });
  });

  describe("classifyError", () => {
    test("应该正确分类 ValidationError", () => {
      const error = new ValidationError("测试");
      expect(classifyError(error)).toBe("VALIDATION_ERROR");
    });

    test("应该正确分类 ENOENT 错误", () => {
      const error = new Error("文件不存在");
      error.code = "ENOENT";
      expect(classifyError(error)).toBe("RESOURCE_ERROR");
    });

    test("应该正确分类 EACCES 错误", () => {
      const error = new Error("权限不足");
      error.code = "EACCES";
      expect(classifyError(error)).toBe("PERMISSION_ERROR");
    });

    test("应该正确分类未知错误", () => {
      const error = new Error("未知错误");
      expect(classifyError(error)).toBe("UNKNOWN_ERROR");
    });
  });
});
