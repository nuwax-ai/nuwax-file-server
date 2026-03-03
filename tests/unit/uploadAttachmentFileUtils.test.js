import {
  uploadAttachmentFile,
} from "../../src/utils/project/uploadAttachmentFileUtils.js";
import {
  ValidationError,
} from "../../src/utils/error/errorHandler.js";

describe("uploadAttachmentFileUtils", () => {
  describe("参数验证测试", () => {
    test("项目ID为空应该抛出 ValidationError", async () => {
      const mockFile = {
        originalname: "test.txt",
        path: "/tmp/test.txt",
        size: 4,
      };

      await expect(uploadAttachmentFile("", mockFile)).rejects.toThrow(ValidationError);
    });

    test("文件对象为空应该抛出 ValidationError", async () => {
      await expect(uploadAttachmentFile("test-project", null)).rejects.toThrow(ValidationError);
    });

    test("文件路径为空应该抛出 ValidationError", async () => {
      const mockFile = {
        originalname: "test.txt",
        path: "",
        size: 4,
      };

      await expect(uploadAttachmentFile("test-project", mockFile)).rejects.toThrow(ValidationError);
    });
  });
});
