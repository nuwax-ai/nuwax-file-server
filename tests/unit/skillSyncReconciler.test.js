import path from "path";
import fs from "fs";
import os from "os";
import {
  scanAndReconcile,
  MAX_SCAN_DEPTH,
} from "../../src/scheduler/skillSyncReconciler.js";
import { syncTargetVersion } from "../../src/utils/common/AgentWorkspaceUtils.js";

/**
 * skill-sync reconciler 单测 (对齐 Rust skill_sync_reconciler.rs 的 4 个用例)。
 * 直接测 scanAndReconcile (已 export), 用临时目录构造 workspace。
 */
describe("skill-sync reconciler", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const newStats = () => ({ synced: 0, skipped: 0, failed: 0 });

  test("版本落后的 workspace → synced + 写 marker + fan-out 到 .grok/.pi", async () => {
    // 构造 {tmp}/user1/cid1/.agents/skills/sk1/SKILL.md (无 marker → 版本落后)
    const ws = path.join(tmpRoot, "user1", "cid1");
    fs.mkdirSync(path.join(ws, ".agents", "skills", "sk1"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".agents", "skills", "sk1", "SKILL.md"), "x");

    const current = syncTargetVersion();
    const stats = newStats();
    await scanAndReconcile(tmpRoot, 0, MAX_SCAN_DEPTH, current, stats);

    expect(stats.synced).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);

    // marker 写入 = 当前版本
    const marker = fs.readFileSync(
      path.join(ws, ".agents", ".sync_version"),
      "utf8"
    );
    expect(marker).toBe(current);

    // fan-out: grok/pi (新) + claude/opencode/codex (原有) 都应拿到 sk1
    expect(
      fs.existsSync(path.join(ws, ".grok", "skills", "sk1", "SKILL.md"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(ws, ".pi", "skills", "sk1", "SKILL.md"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(ws, ".claude", "skills", "sk1", "SKILL.md"))
    ).toBe(true);
  });

  test("版本最新的 workspace → skipped (O(1), 不动文件)", async () => {
    const ws = path.join(tmpRoot, "ws");
    fs.mkdirSync(path.join(ws, ".agents", "skills"), { recursive: true });
    const current = syncTargetVersion();
    // 预置当前版本 marker → 应 skip
    fs.writeFileSync(path.join(ws, ".agents", ".sync_version"), current);

    const stats = newStats();
    await scanAndReconcile(tmpRoot, 0, MAX_SCAN_DEPTH, current, stats);

    expect(stats.synced).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);

    // skip 时不应创建任何镜像目录
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".grok"))).toBe(false);
  });

  test(".agents 无 skills 子目录 → skipped (空 workspace 无需 sync)", async () => {
    const ws = path.join(tmpRoot, "ws");
    fs.mkdirSync(path.join(ws, ".agents"), { recursive: true }); // 无 skills/

    const current = syncTargetVersion();
    const stats = newStats();
    await scanAndReconcile(tmpRoot, 0, MAX_SCAN_DEPTH, current, stats);

    expect(stats.synced).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);
  });

  test("超过 MAX_SCAN_DEPTH → 不处理 (防失控)", async () => {
    // 构造 depth 5 的 .agents (a/b/c/d/e/.agents, e 在 depth 5 > MAX_SCAN_DEPTH 4)
    const deep = path.join(tmpRoot, "a", "b", "c", "d", "e");
    fs.mkdirSync(path.join(deep, ".agents", "skills"), { recursive: true });

    const stats = newStats();
    await scanAndReconcile(tmpRoot, 0, MAX_SCAN_DEPTH, "unused", stats);

    // 超深度 → 全不处理
    expect(stats.synced + stats.skipped + stats.failed).toBe(0);
  });
});
