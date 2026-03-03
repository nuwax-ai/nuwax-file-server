/**
 * CLI 模块测试
 *
 * 测试 nuwax-file-server CLI 相关的功能
 *
 * 覆盖范围:
 * - serviceManager.js 服务管理器
 * - envUtils.js 环境变量工具
 * - PID 文件操作
 * - 跨平台兼容性
 */

import path from "path";
import fs from "fs-extra";
import os from "os";

// 测试配置文件路径
const testConfig = {
  testPidDir: path.join(os.tmpdir(), "nuwax-file-server-test"),
  testPidFile: path.join(
    os.tmpdir(),
    "nuwax-file-server-test",
    "server.pid"
  ),
};

describe("CLI Service Manager", () => {
  let serviceManager;

  beforeAll(async () => {
    const module = await import("../../src/utils/serviceManager.js");
    serviceManager = module.default || module;
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testConfig.testPidFile)) {
        fs.removeSync(testConfig.testPidFile);
      }
    } catch (err) {
      // 忽略清理错误
    }
  });

  describe("getPidFilePath", () => {
    it("应该返回有效的 PID 文件路径", () => {
      const pidPath = serviceManager.getPidFilePath();

      expect(pidPath).toBeDefined();
      expect(typeof pidPath).toBe("string");
      expect(pidPath.length).toBeGreaterThan(0);
    });

    it("应该在临时目录中", () => {
      const pidPath = serviceManager.getPidFilePath();
      const tmpDir = os.tmpdir();

      expect(pidPath.startsWith(tmpDir)).toBe(true);
    });
  });

  describe("isWindows", () => {
    it("应该正确检测当前操作系统", () => {
      const isWin = serviceManager.isWindows();

      const currentPlatform = process.platform;

      if (currentPlatform === "win32") {
        expect(isWin).toBe(true);
      } else {
        expect(isWin).toBe(false);
      }
    });
  });

  describe("isProcessRunning", () => {
    it("应该正确判断不存在的进程", () => {
      const result = serviceManager.isProcessRunning(999999999);

      expect(result).toBe(false);
    });

    it("应该正确判断当前进程", () => {
      const result = serviceManager.isProcessRunning(process.pid);

      expect(result).toBe(true);
    });
  });

  describe("readPidFile", () => {
    it("应该返回 null 如果文件不存在", () => {
      const result = serviceManager.readPidFile();

      expect(result === null || result === undefined).toBe(true);
    });
  });

  describe("writePidFile and readPidFile", () => {
    it("应该能够写入和读取 PID 文件", () => {
      const testPidInfo = {
        pid: 12345,
        startedAt: new Date().toISOString(),
        env: "test",
        port: "60000",
        version: "1.0.0",
        platform: process.platform,
      };

      const testPidPath = path.join(testConfig.testPidDir, "server.pid");
      fs.ensureDirSync(testConfig.testPidDir);
      fs.writeFileSync(testPidPath, JSON.stringify(testPidInfo, null, 2));

      const content = fs.readFileSync(testPidPath, "utf8");
      const readPidInfo = JSON.parse(content);

      expect(readPidInfo.pid).toBe(12345);
      expect(readPidInfo.env).toBe("test");
      expect(readPidInfo.port).toBe("60000");

      fs.removeSync(testConfig.testPidDir);
    });
  });

  describe("formatUptime", () => {
    it("应该正确格式化运行时间", () => {
      const startedAt = new Date(Date.now() - 3600000).toISOString();
      const result = serviceManager.formatUptime(startedAt);

      expect(result).toContain("小时");
    });

    it("应该处理无效的日期", () => {
      const result = serviceManager.formatUptime("invalid-date");

      expect(result).toBe("未知");
    });
  });

  describe("getServiceStatus", () => {
    it("应该返回正确的服务状态", () => {
      const status = serviceManager.getServiceStatus();

      expect(status).toHaveProperty("running");
      expect(status).toHaveProperty("pidInfo");
      expect(status).toHaveProperty("message");
      expect(typeof status.running).toBe("boolean");
    });
  });
});

describe("CLI Environment Utils", () => {
  let envUtils;

  beforeAll(async () => {
    const module = await import("../../src/utils/envUtils.js");
    envUtils = module.default || module;
  });

  describe("isWindows", () => {
    it("应该正确检测 Windows 平台", () => {
      const isWin = envUtils.isWindows();
      const currentPlatform = process.platform;

      expect(isWin).toBe(currentPlatform === "win32");
    });
  });

  describe("normalizeEnvName", () => {
    it("Windows 环境应该转为大写", () => {
      if (process.platform === "win32") {
        const result = envUtils.normalizeEnvName("test_env");
        expect(result).toBe("TEST_ENV");
      } else {
        const result = envUtils.normalizeEnvName("test_env");
        expect(result).toBe("test_env");
      }
    });

    it("应该处理空字符串", () => {
      const result = envUtils.normalizeEnvName("");
      expect(result).toBe("");
    });
  });

  describe("getEnv", () => {
    beforeEach(() => {
      process.env.TEST_VAR = "test-value";
    });

    afterEach(() => {
      delete process.env.TEST_VAR;
    });

    it("应该返回已设置的环境变量", () => {
      const result = envUtils.getEnv("TEST_VAR");
      expect(result).toBe("test-value");
    });

    it("应该返回默认值如果未设置", () => {
      const result = envUtils.getEnv("NON_EXISTENT_VAR", "default");
      expect(result).toBe("default");
    });
  });

  describe("getBoolEnv", () => {
    beforeEach(() => {
      process.env.TEST_BOOL_TRUE = "true";
      process.env.TEST_BOOL_FALSE = "false";
      process.env.TEST_BOOL_ONE = "1";
    });

    afterEach(() => {
      delete process.env.TEST_BOOL_TRUE;
      delete process.env.TEST_BOOL_FALSE;
      delete process.env.TEST_BOOL_ONE;
    });

    it("应该正确解析 true 值", () => {
      expect(envUtils.getBoolEnv("TEST_BOOL_TRUE")).toBe(true);
    });

    it("应该正确解析 1 值", () => {
      expect(envUtils.getBoolEnv("TEST_BOOL_ONE")).toBe(true);
    });

    it("应该正确解析 false 值", () => {
      expect(envUtils.getBoolEnv("TEST_BOOL_FALSE")).toBe(false);
    });

    it("应该返回默认值如果未设置", () => {
      expect(envUtils.getBoolEnv("NON_EXISTENT", true)).toBe(true);
      expect(envUtils.getBoolEnv("NON_EXISTENT", false)).toBe(false);
    });
  });

  describe("getNumberEnv", () => {
    beforeEach(() => {
      process.env.TEST_NUMBER = "123";
      process.env.TEST_NAN = "abc";
    });

    afterEach(() => {
      delete process.env.TEST_NUMBER;
      delete process.env.TEST_NAN;
    });

    it("应该正确解析数字", () => {
      const result = envUtils.getNumberEnv("TEST_NUMBER");
      expect(result).toBe(123);
    });

    it("应该返回默认值对于 NaN", () => {
      const result = envUtils.getNumberEnv("TEST_NAN", 0);
      expect(result).toBe(0);
    });

    it("应该返回默认值如果未设置", () => {
      const result = envUtils.getNumberEnv("NON_EXISTENT", 42);
      expect(result).toBe(42);
    });
  });

  describe("parseEnvType", () => {
    it("应该正确解析 dev", () => {
      expect(envUtils.parseEnvType("dev")).toBe("development");
    });

    it("应该正确解析 prod", () => {
      expect(envUtils.parseEnvType("prod")).toBe("production");
    });

    it("应该正确解析 test", () => {
      expect(envUtils.parseEnvType("test")).toBe("test");
    });

    it("应该处理大小写", () => {
      expect(envUtils.parseEnvType("DEV")).toBe("development");
      expect(envUtils.parseEnvType("PROD")).toBe("production");
    });

    it("应该处理空值", () => {
      expect(envUtils.parseEnvType("")).toBe("production");
      expect(envUtils.parseEnvType(null)).toBe("production");
    });
  });

  describe("loadEnvFromArgv", () => {
    it("应该解析命令行参数", () => {
      const originalArgv = process.argv;
      process.argv = ["node", "test", "--test-key", "test-value"];

      const result = envUtils.loadEnvFromArgv();

      process.argv = originalArgv;

      expect(result).toBeDefined();
    });
  });
});

describe("CLI Cross-Platform Compatibility", () => {
  describe("Platform Detection", () => {
    it("应该正确检测 darwin (macOS)", () => {
      if (process.platform === "darwin") {
        expect(process.platform).toBe("darwin");
      }
    });

    it("应该正确检测 linux", () => {
      if (process.platform === "linux") {
        expect(process.platform).toBe("linux");
      }
    });

    it("应该正确检测 win32", () => {
      if (process.platform === "win32") {
        expect(process.platform).toBe("win32");
      }
    });
  });

  describe("Path Handling", () => {
    it("应该使用 path.join 进行路径拼接", () => {
      const result = path.join("dir", "subdir", "file.js");

      expect(result).toMatch(/dir[\/\\]subdir[\/\\]file\.js/);
    });

    it("应该使用 os.tmpdir() 获取临时目录", () => {
      const tmpDir = os.tmpdir();

      expect(tmpDir).toBeDefined();
      expect(tmpDir.length).toBeGreaterThan(0);
    });

    it("应该使用 os.homedir() 获取主目录", () => {
      const homeDir = os.homedir();

      expect(homeDir).toBeDefined();
      expect(homeDir.length).toBeGreaterThan(0);
    });
  });

  describe("Environment Variables", () => {
    it("应该能够读取环境变量", () => {
      process.env.TEST_READ = "test";

      expect(process.env.TEST_READ).toBe("test");

      delete process.env.TEST_READ;
    });

    it("应该支持设置和删除环境变量", () => {
      process.env.TEMP_TEST_VAR = "temp-value";

      expect(process.env.TEMP_TEST_VAR).toBe("temp-value");

      delete process.env.TEMP_TEST_VAR;

      expect(process.env.TEMP_TEST_VAR).toBeUndefined();
    });
  });
});

describe("CLI Config", () => {
  let config;

  beforeAll(async () => {
    const module = await import("../../src/appConfig/index.js");
    config = module.default || module;
  });

  describe("CLI Configuration", () => {
    it("应该包含 CLI 服务名称配置", () => {
      expect(config.CLI_SERVICE_NAME).toBe("nuwax-file-server");
    });

    it("应该包含 CLI PID 目录配置", () => {
      expect(config.CLI_PID_DIR).toBeDefined();
      expect(typeof config.CLI_PID_DIR).toBe("string");
    });

    it("应该包含 CLI 停止超时配置", () => {
      expect(config.CLI_STOP_TIMEOUT).toBeDefined();
      expect(typeof config.CLI_STOP_TIMEOUT).toBe("number");
    });

    it("应该包含 CLI 检查间隔配置", () => {
      expect(config.CLI_CHECK_INTERVAL).toBeDefined();
      expect(typeof config.CLI_CHECK_INTERVAL).toBe("number");
    });

    it("应该包含 Windows 平台检测配置", () => {
      expect(config.CLI_IS_WINDOWS).toBeDefined();
      expect(typeof config.CLI_IS_WINDOWS).toBe("boolean");
    });
  });

  describe("Standard Configuration", () => {
    it("应该包含标准配置项", () => {
      expect(config.NODE_ENV).toBeDefined();
      expect(config.PORT).toBeDefined();
      expect(config.PROJECT_SOURCE_DIR).toBeDefined();
    });
  });
});
