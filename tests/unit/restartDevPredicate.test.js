import { shouldUseFastRestart } from "../../src/utils/build/restartDevPredicate.js";

describe("shouldUseFastRestart", () => {
  test("flag 开 + node_modules 存在 → 快路径", () => {
    expect(
      shouldUseFastRestart({ fastRestartEnabled: true, nodeModulesExists: true })
    ).toBe(true);
  });

  test("flag 关 → 全路径(无论 node_modules 是否存在)", () => {
    expect(
      shouldUseFastRestart({ fastRestartEnabled: false, nodeModulesExists: true })
    ).toBe(false);
    expect(
      shouldUseFastRestart({ fastRestartEnabled: false, nodeModulesExists: false })
    ).toBe(false);
  });

  test("flag 开 + node_modules 不存在 → 全路径(保留 copyNodeModulesFromCache 缓存收益)", () => {
    expect(
      shouldUseFastRestart({ fastRestartEnabled: true, nodeModulesExists: false })
    ).toBe(false);
  });

  test("undefined 入参 falsy-safe", () => {
    expect(
      shouldUseFastRestart({ fastRestartEnabled: undefined, nodeModulesExists: true })
    ).toBe(false);
    expect(
      shouldUseFastRestart({ fastRestartEnabled: true, nodeModulesExists: undefined })
    ).toBe(false);
    expect(shouldUseFastRestart({})).toBe(false);
  });
});
