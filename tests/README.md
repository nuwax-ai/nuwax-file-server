# 测试文档

## 测试框架

本项目使用 **Jest** 作为测试框架，配合 **Supertest** 进行 API 集成测试。

## 测试目录结构

```
tests/
├── setup.js                    # 测试环境配置
├── unit/                       # 单元测试
│   ├── errorHandler.test.js
│   ├── restartJudgeUtils.test.js
│   └── dependencyManager.test.js
└── integration/                # 集成测试（待添加）
    └── api.test.js
```

## 运行测试

### 运行所有测试

```bash
npm test
```

### 运行测试并监听文件变化

```bash
npm run test:watch
```

### 只运行单元测试

```bash
npm run test:unit
```

### 只运行集成测试

```bash
npm run test:integration
```

### 查看测试覆盖率

测试覆盖率报告会自动生成在 `coverage/` 目录下。

```bash
# 运行测试后查看覆盖率
npm test

# 在浏览器中查看详细报告
open coverage/lcov-report/index.html
```

## 测试覆盖率目标

当前设置的覆盖率阈值：

- **分支覆盖率**: 50%
- **函数覆盖率**: 50%
- **行覆盖率**: 50%
- **语句覆盖率**: 50%

## 编写测试

### 单元测试示例

```javascript
// tests/unit/myModule.test.js
const { myFunction } = require("../../src/utils/myModule");

describe("我的模块测试", () => {
  test("应该返回正确的结果", () => {
    const result = myFunction("input");
    expect(result).toBe("expected output");
  });

  test("应该处理错误情况", () => {
    expect(() => {
      myFunction(null);
    }).toThrow("错误信息");
  });
});
```

### 集成测试示例

```javascript
// tests/integration/api.test.js
const request = require("supertest");
const app = require("../../src/server");

describe("API 集成测试", () => {
  test("GET /api/build/list-dev 应该返回进程列表", async () => {
    const response = await request(app).get("/api/build/list-dev").expect(200);

    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.list)).toBe(true);
  });
});
```

## 测试工具函数

在 `tests/setup.js` 中提供了全局测试工具：

```javascript
// 生成测试用的 projectId
const projectId = global.testUtils.generateProjectId();

// 生成测试用的版本号
const version = global.testUtils.generateVersion();

// 等待函数
await global.testUtils.sleep(1000); // 等待1秒
```

## 测试最佳实践

### 1. 测试命名

- 使用清晰的描述性名称
- 使用 `describe` 分组相关测试
- 使用 `test` 或 `it` 描述单个测试用例

### 2. 测试隔离

- 每个测试应该独立运行
- 使用 `beforeEach` 和 `afterEach` 清理状态
- 避免测试之间的依赖关系

### 3. 测试覆盖

- 测试正常情况
- 测试边界条件
- 测试错误情况
- 测试异常输入

### 4. Mock 和 Stub

```javascript
// Mock 外部依赖
jest.mock("../../src/utils/externalService");

// Mock 函数
const mockFn = jest.fn().mockReturnValue("mocked value");

// 验证调用
expect(mockFn).toHaveBeenCalledWith("expected argument");
expect(mockFn).toHaveBeenCalledTimes(1);
```

### 5. 异步测试

```javascript
// 使用 async/await
test("异步操作", async () => {
  const result = await asyncFunction();
  expect(result).toBe("expected");
});

// 使用 Promise
test("Promise 操作", () => {
  return promiseFunction().then((result) => {
    expect(result).toBe("expected");
  });
});
```

## 常用断言

```javascript
// 相等性
expect(value).toBe(expected); // ===
expect(value).toEqual(expected); // 深度相等

// 真值
expect(value).toBeTruthy();
expect(value).toBeFalsy();
expect(value).toBeNull();
expect(value).toBeUndefined();
expect(value).toBeDefined();

// 数字
expect(value).toBeGreaterThan(3);
expect(value).toBeGreaterThanOrEqual(3.5);
expect(value).toBeLessThan(5);
expect(value).toBeLessThanOrEqual(4.5);

// 字符串
expect(string).toMatch(/pattern/);
expect(string).toContain("substring");

// 数组
expect(array).toContain(item);
expect(array).toHaveLength(3);

// 对象
expect(object).toHaveProperty("key");
expect(object).toHaveProperty("key", "value");

// 异常
expect(() => {
  throw new Error("error");
}).toThrow("error");
```

## 调试测试

### 1. 运行单个测试文件

```bash
npm test -- tests/unit/errorHandler.test.js
```

### 2. 运行匹配的测试

```bash
npm test -- --testNamePattern="应该正确创建"
```

### 3. 使用 Node 调试器

```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

## 持续集成

测试应该在每次提交前运行：

```bash
# 提交前运行测试
npm test

# 如果测试通过，再提交代码
git add .
git commit -m "feat: 添加新功能"
```

## 测试环境配置

测试环境使用独立的配置：

- 端口: 10003
- 日志: 禁用控制台输出
- 超时: 10 秒

这些配置在 `tests/setup.js` 中设置。

## 注意事项

1. **不要提交失败的测试** - 确保所有测试通过后再提交
2. **保持测试快速** - 单元测试应该在毫秒级完成
3. **定期更新测试** - 代码变更时同步更新测试
4. **编写有意义的测试** - 测试应该验证真实的业务逻辑
5. **避免测试实现细节** - 测试行为，而非实现

## 贡献测试

欢迎为项目添加更多测试！优先添加：

1. 核心业务逻辑的单元测试
2. API 端点的集成测试
3. 边界条件和错误处理测试
4. 工具函数的测试

## 相关资源

- [Jest 文档](https://jestjs.io/docs/getting-started)
- [Supertest 文档](https://github.com/visionmedia/supertest)
- [测试最佳实践](https://github.com/goldbergyoni/javascript-testing-best-practices)
