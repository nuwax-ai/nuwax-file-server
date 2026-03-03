export default {
  testEnvironment: "node",

  // 测试文件匹配模式
  testMatch: ["**/tests/**/*.test.js", "**/__tests__/**/*.test.js"],

  // 覆盖率收集
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/server.js",
    "!src/config/**",
    "!**/node_modules/**",
  ],

  // 覆盖率阈值
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50,
    },
  },

  // 覆盖率报告格式
  coverageReporters: ["text", "lcov", "html"],

  // 测试超时时间（毫秒）
  testTimeout: 10000,

  // 显示详细信息
  verbose: true,

  // 清除模拟
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // 设置测试环境变量
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
};
