import {
  shouldRestartForSingleFile,
  shouldRestartDevServer,
} from "../../src/utils/buildJudge/restartJudgeUtils.js";

describe("重启判断工具测试", () => {
  describe("shouldRestartForSingleFile", () => {
    test("package.json 应该需要重启", () => {
      expect(shouldRestartForSingleFile("package.json")).toBe(true);
    });

    test("vite.config.js 应该需要重启", () => {
      expect(shouldRestartForSingleFile("vite.config.js")).toBe(true);
      expect(shouldRestartForSingleFile("vite.config.ts")).toBe(true);
    });

    test("webpack.config.js 应该需要重启", () => {
      expect(shouldRestartForSingleFile("webpack.config.js")).toBe(true);
    });

    test(".env 文件应该需要重启", () => {
      expect(shouldRestartForSingleFile(".env")).toBe(true);
      expect(shouldRestartForSingleFile(".env.development")).toBe(true);
    });

    test("index.html 应该需要重启", () => {
      expect(shouldRestartForSingleFile("index.html")).toBe(true);
    });

    test("入口文件应该需要重启", () => {
      expect(shouldRestartForSingleFile("src/main.js")).toBe(true);
      expect(shouldRestartForSingleFile("src/index.ts")).toBe(true);
      expect(shouldRestartForSingleFile("main.jsx")).toBe(true);
      expect(shouldRestartForSingleFile("App.tsx")).toBe(true);
    });

    test("lock 文件应该需要重启", () => {
      expect(shouldRestartForSingleFile("package-lock.json")).toBe(true);
      expect(shouldRestartForSingleFile("yarn.lock")).toBe(true);
      expect(shouldRestartForSingleFile("pnpm-lock.yaml")).toBe(true);
    });

    test("普通组件文件不需要重启", () => {
      expect(shouldRestartForSingleFile("src/components/Button.tsx")).toBe(
        false
      );
      expect(shouldRestartForSingleFile("src/utils/helper.js")).toBe(false);
      expect(shouldRestartForSingleFile("src/styles/main.css")).toBe(false);
    });

    test("空字符串不需要重启", () => {
      expect(shouldRestartForSingleFile("")).toBe(false);
    });

    test("非字符串参数不需要重启", () => {
      expect(shouldRestartForSingleFile(null)).toBe(false);
      expect(shouldRestartForSingleFile(undefined)).toBe(false);
      expect(shouldRestartForSingleFile(123)).toBe(false);
    });
  });

  describe("shouldRestartDevServer", () => {
    test("包含需要重启的文件应该返回true", () => {
      const files = [
        { name: "src/components/Button.tsx" },
        { name: "package.json" },
        { name: "src/App.tsx" },
      ];
      expect(shouldRestartDevServer(files)).toBe(true);
    });

    test("都是普通文件应该返回false", () => {
      const files = [
        { name: "src/components/Button.tsx" },
        { name: "src/utils/helper.js" },
        { name: "src/styles/main.css" },
      ];
      expect(shouldRestartDevServer(files)).toBe(false);
    });

    test("空数组应该返回false", () => {
      expect(shouldRestartDevServer([])).toBe(false);
    });

    test("非数组参数应该返回false", () => {
      expect(shouldRestartDevServer(null)).toBe(false);
      expect(shouldRestartDevServer(undefined)).toBe(false);
      expect(shouldRestartDevServer("test")).toBe(false);
    });

    test("文件对象缺少name属性应该被忽略", () => {
      const files = [{ contents: "test" }, { name: "package.json" }];
      expect(shouldRestartDevServer(files)).toBe(true);
    });
  });
});
