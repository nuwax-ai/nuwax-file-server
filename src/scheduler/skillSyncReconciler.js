/**
 * 启动时 skill-sync reconciler (ESM): 对 fan-out 版本落后的 workspace 自动补 syncAgents。
 *
 * 解决: AGENT_ROOT_MAP 扩展 (加 grok/pi/cursor...) 后, 已存在的旧 workspace 缺新 agent 目录,
 * 靠手动 push-skills 逐个补齐不可行。本模块启动时后台遍历所有 workspace, 版本 marker 驱动
 * (.agents/.sync_version) 自动补齐, 已同步的 O(1) 跳过。
 *
 * 对齐 Rust crates/rcoder/src/skill_sync_reconciler.rs。
 * 复用 pnpmPruneScheduler 范式 (class + 单例 + isRunning 互斥 + 失败只 log)。
 * env SKILL_SYNC_RECONCILE_ON_STARTUP 控制 (默认 true, 因轻量)。
 */
import fs from "fs";
import path from "path";
import config from "../appConfig/index.js";
import { log } from "../utils/log/logUtils.js";
import { syncAgents, syncTargetVersion } from "../utils/common/AgentWorkspaceUtils.js";

/** env 开关名 (默认 true: 版本 O(1) 跳过, 日常启动几乎零开销)。 */
const ENV_ENABLED = "SKILL_SYNC_RECONCILE_ON_STARTUP";

/**
 * 递归找 `.agents` 的最大深度。
 * 覆盖: computer `user/cId` (2 层) + project 多租户 `tenant/space/project` (3 层) + 余量。
 */
const MAX_SCAN_DEPTH = 4;

/**
 * env 开关解析 (对齐 Rust enabled()): 未设 → 默认启用; 设了则只认 true/1/yes。
 * 比 `!== "false"` 更严谨 —— 避免 SKILL_SYNC_RECONCILE_ON_STARTUP=0 / no 被误判为启用。
 */
function envEnabled() {
  const raw = process.env[ENV_ENABLED];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * 递归扫描: 遇含 `.agents` 子目录的目录即当 workspace 处理 (不再下钻); 否则下钻子目录。
 * 超过 maxDepth 停止 (防失控 + 覆盖已知 workspace 层级即可)。
 *
 * ⚠️ 必须用裸 fs.readdir, 绝不用 traverseDirectory —— env TRAVERSE_EXCLUDE_DIRS 含 .agents,
 *    traverseDirectory 会跳过 .agents, 导致扫不到 workspace。
 *
 * @param {string} dir 当前扫描目录
 * @param {number} depth 当前深度
 * @param {number} maxDepth 最大深度
 * @param {string} current 当前版本标识 (syncTargetVersion())
 * @param {{synced:number,skipped:number,failed:number}} stats 统计计数 (可变对象, 外部读)
 */
async function scanAndReconcile(dir, depth, maxDepth, current, stats) {
  if (depth > maxDepth) return;

  const agentsDir = path.join(dir, ".agents");
  if (fs.existsSync(agentsDir)) {
    await reconcileWorkspace(dir, agentsDir, current, stats);
    return; // 命中 workspace, 不再下钻 (避免误入 .agents 内部)
  }

  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限 / 不存在 → 跳过
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scanAndReconcile(
        path.join(dir, entry.name),
        depth + 1,
        maxDepth,
        current,
        stats
      );
    }
  }
}

/**
 * 单个 workspace: 读版本 marker 决定是否补 sync。
 * - 无 `.agents/skills` → skip (空 workspace 无需 sync)
 * - `.sync_version` == 当前版本 → skip (O(1), 已同步)
 * - 否则 → syncAgents (内部写新 marker)
 *
 * @param {string} workspace workspace 根目录
 * @param {string} agentsDir workspace/.agents 绝对路径
 * @param {string} current 当前版本标识
 * @param {object} stats 统计计数
 */
async function reconcileWorkspace(workspace, agentsDir, current, stats) {
  if (!fs.existsSync(path.join(agentsDir, "skills"))) {
    // 空 workspace (无 skills) 无需 fan-out
    stats.skipped += 1;
    return;
  }

  const marker = path.join(agentsDir, ".sync_version");
  let existing = "";
  try {
    existing = fs.readFileSync(marker, "utf8");
  } catch {
    // marker 不存在 / 读失败 → 视为版本落后 (老 workspace 首次 reconcile)
  }

  if (existing === current) {
    stats.skipped += 1; // O(1) 跳过
    return;
  }

  try {
    await syncAgents(workspace);
    stats.synced += 1;
    log("reconciler", "INFO", "synced workspace", {
      workspace,
      from: existing || "(none)",
      to: current,
    });
  } catch (error) {
    stats.failed += 1;
    log("reconciler", "WARN", "sync workspace failed", {
      workspace,
      error: error.message,
    });
  }
}

class SkillSyncReconciler {
  constructor() {
    this.enabled = envEnabled();
    this.isRunning = false;
    this.startTimer = null;
  }

  /** 启动后台 reconciler (不阻塞主流程)。延迟 5s 确保服务完全启动 (对齐 pnpmPrune runOnStart)。 */
  start() {
    if (!this.enabled) {
      log("reconciler", "INFO", `disabled by ${ENV_ENABLED}=false, skip`);
      return;
    }
    if (this.startTimer) return; // 已调度, 防重入 (避免重复 setTimeout)
    log("reconciler", "INFO", "starting skill-sync reconciler (background, run-once)");
    this.startTimer = setTimeout(() => {
      this.runOnce().catch((error) => {
        log("reconciler", "ERROR", "reconciler crashed", { error: error.message });
      });
    }, 5000);
  }

  /** 停止尚未触发的启动定时器 (不打断进行中的 runOnce; 进行中的让它跑完, 幂等)。 */
  stop() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  /** 执行一次全量 reconcile: 扫 computer + project 两个根。 */
  async runOnce() {
    if (this.isRunning) {
      log("reconciler", "WARN", "reconciler already running, skip");
      return;
    }
    this.isRunning = true;
    const stats = { synced: 0, skipped: 0, failed: 0 };
    try {
      const current = syncTargetVersion();
      const roots = [config.COMPUTER_WORKSPACE_DIR, config.PROJECT_SOURCE_DIR].filter(
        (r) => r && fs.existsSync(r)
      );
      if (roots.length === 0) {
        log("reconciler", "INFO", "no workspace root exists, skip", {
          computer: config.COMPUTER_WORKSPACE_DIR,
          project: config.PROJECT_SOURCE_DIR,
        });
        return;
      }
      log("reconciler", "INFO", "scanning workspaces", { roots, current });
      for (const root of roots) {
        await scanAndReconcile(root, 0, MAX_SCAN_DEPTH, current, stats);
      }
      log("reconciler", "INFO", "completed", stats);
    } catch (error) {
      log("reconciler", "ERROR", "reconciler failed", {
        error: error.message,
        ...stats,
      });
    } finally {
      this.isRunning = false;
    }
  }
}

// 单例
let instance = null;

function getReconciler() {
  if (!instance) instance = new SkillSyncReconciler();
  return instance;
}

function startReconciler() {
  getReconciler().start();
}

function stopReconciler() {
  if (instance) instance.stop();
}

export {
  SkillSyncReconciler,
  scanAndReconcile,
  reconcileWorkspace,
  MAX_SCAN_DEPTH,
  getReconciler,
  startReconciler,
  stopReconciler,
};
