// Jest 测试环境设置

// 设置测试环境变量
process.env.NODE_ENV = "test";
process.env.PORT = "10003";
process.env.LOG_CONSOLE_ENABLED = "false";

// 增加测试超时时间（ESM 兼容写法）
if (typeof jest !== "undefined") {
  jest.setTimeout(10000);
}

// 全局测试工具
globalThis.testUtils = {
  // 生成测试用的 projectId
  generateProjectId: () => `test-project-${Date.now()}`,

  // 生成测试用的版本号
  generateVersion: () => Math.floor(Math.random() * 100),

  // 等待函数
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// 测试前清理
beforeAll(() => {
  console.log("🧪 开始测试...");
});

// 测试后清理
afterAll(() => {
  console.log("✅ 测试完成!");
});
