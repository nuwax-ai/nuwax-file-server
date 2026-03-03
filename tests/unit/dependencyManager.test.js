import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import {
  getFileMtime,
  shouldInstallDeps,
} from "../../src/utils/buildDependency/dependencyManager.js";

// 在 ESM 模块中获取当前文件的实际路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("依赖管理器测试", () => {
  describe("getFileMtime", () => {
    test("存在的文件应该返回时间戳", () => {
      // 使用当前测试文件作为测试对象，确保它存在且可访问
      const filePath = path.join(__dirname, "dependencyManager.test.js");
      const mtime = getFileMtime(filePath);
      expect(typeof mtime).toBe("number");
      expect(mtime).toBeGreaterThan(0);
    });

    test("不存在的文件应该返回0", () => {
      const filePath = "/path/to/nonexistent/file.txt";
      const mtime = getFileMtime(filePath);
      expect(mtime).toBe(0);
    });
  });

  describe("shouldInstallDeps", () => {
    const testProjectPath = "/tmp/test-project-deps";

    beforeEach(() => {
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
      }
      fs.mkdirSync(testProjectPath, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
      }
    });

    test("不存在 node_modules 应该返回true", () => {
      fs.writeFileSync(path.join(testProjectPath, "package.json"), "{}");
      const result = shouldInstallDeps(testProjectPath);
      expect(result).toBe(true);
    });

    test("存在 node_modules 但 package.json 更新应该返回true", async () => {
      const nodeModulesPath = path.join(testProjectPath, "node_modules");
      fs.mkdirSync(nodeModulesPath);
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(path.join(testProjectPath, "package.json"), "{}");
      const result = shouldInstallDeps(testProjectPath);
      expect(result).toBe(true);
    });

    test("package.json 和 node_modules 都存在且时间正常应该返回false", async () => {
      fs.writeFileSync(path.join(testProjectPath, "package.json"), "{}");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const nodeModulesPath = path.join(testProjectPath, "node_modules");
      fs.mkdirSync(nodeModulesPath);
      const result = shouldInstallDeps(testProjectPath);
      expect(result).toBe(false);
    });
  });
});
