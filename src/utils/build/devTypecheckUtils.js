import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "../log/logUtils.js";
import { BusinessError } from "../error/errorHandler.js";
import ERROR_CODES from "../error/errorCodes.js";
import BuildErrorParser from "../error/buildErrorParser.js";

// tsc 输出截断上限：错误明细要透传给调用方（agent/用户），但避免异常超大输出撑爆响应体
const MAX_OUTPUT_LENGTH = 6000;
// 超时视为环境问题放行，不能让闸门卡死 dev 启动
const TYPECHECK_TIMEOUT_MS = 180 * 1000;

function truncateOutput(text) {
  const str = String(text || "");
  if (str.length <= MAX_OUTPUT_LENGTH) {
    return str;
  }
  return str.slice(0, MAX_OUTPUT_LENGTH) + `\n... (output truncated, total ${str.length} chars)`;
}

function execCommand(command, projectPath) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: projectPath,
        env: process.env,
        timeout: TYPECHECK_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB，与 build 脚本一致
      },
      (error, stdout, stderr) => {
        resolve({
          // exec 超时时 error.killed=true 且 signal=SIGTERM
          timedOut: Boolean(error && error.killed && error.signal),
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

/**
 * dev 启动前类型检查闸门：与 build 同一标准（turbo typecheck 任务 / tsc --noEmit），
 * 让类型错误在开发阶段启动 dev 时即暴露，不留到 build/publish 才发现。
 *
 * 检查命令优先级：
 *   1. package.json 定义了 scripts.typecheck → pnpm run typecheck（模板可自带定制命令）
 *   2. turbo monorepo（根有 turbo.json 且本地装有 turbo）→ pnpm exec turbo run typecheck
 *      （typecheck 任务在子包中定义，如 v2:typecheck；与 build 管线同一入口，根目录
 *      直接 tsc 只能覆盖根 tsconfig，查不到子包）
 *   3. 根有 tsconfig.json 且本地装有 vue-tsc / tsc → pnpm exec <tsc|vue-tsc> --noEmit
 *   4. 都不满足 → 跳过（非 TS 项目不阻塞）
 *
 * 仅当退出码非 0 且输出中含 TS 诊断（error TSxxxx）时才拦截（抛 BusinessError → 4xx）；
 * 工具缺失/超时/任务名不存在/配置异常等环境问题只记日志放行，避免误伤 dev 启动。
 *
 * @param {Object} params
 * @param {string} params.projectId 项目ID
 * @param {string} params.projectPath 项目路径
 * @param {Function} params.writeLog 输出写入 dev 日志的回调（主日志+临时日志）
 * @returns {Promise<{checked: boolean, passed?: boolean, reason?: string}>}
 */
async function runDevTypecheckGate({ projectId, projectPath, writeLog }) {
  const result = { checked: false };

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
  } catch (e) {
    log(projectId, "WARN", "Typecheck gate skipped: package.json unreadable", {
      projectPath,
      error: e.message,
    });
    result.reason = "package-json-unreadable";
    return result;
  }

  const typecheckScript = packageJson.scripts && packageJson.scripts.typecheck;
  const hasTsconfig = fs.existsSync(path.join(projectPath, "tsconfig.json"));
  const hasLocalBin = (name) =>
    fs.existsSync(path.join(projectPath, "node_modules", ".bin", name));
  // vue3 项目优先 vue-tsc（能检查 .vue SFC），否则 tsc
  const localTscBin = hasLocalBin("vue-tsc") ? "vue-tsc" : hasLocalBin("tsc") ? "tsc" : null;

  let command = null;
  if (typecheckScript) {
    command = "pnpm run typecheck";
  } else if (fs.existsSync(path.join(projectPath, "turbo.json")) && hasLocalBin("turbo")) {
    command = "pnpm exec turbo run typecheck";
  } else if (hasTsconfig && localTscBin) {
    command = `pnpm exec ${localTscBin} --noEmit`;
  } else {
    log(projectId, "INFO", "Typecheck gate skipped: no typecheck script / turbo / tsconfig / local tsc", {
      projectId,
      hasTypecheckScript: Boolean(typecheckScript),
      hasTurbo: fs.existsSync(path.join(projectPath, "turbo.json")) && hasLocalBin("turbo"),
      hasTsconfig,
      localTscBin,
    });
    result.reason = "no-typescript-project";
    return result;
  }

  const startedAt = Date.now();
  log(projectId, "INFO", "Typecheck gate start before dev", { projectId, command });
  if (writeLog) {
    writeLog(`> dev 启动前类型检查（与 build 同一标准）: ${command}\n`);
  }

  const { timedOut, code, stdout, stderr } = await execCommand(command, projectPath);
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  const elapsedMs = Date.now() - startedAt;

  log(projectId, "INFO", "Typecheck gate finished", {
    projectId,
    command,
    code,
    timedOut,
    elapsedMs,
  });

  if (code === 0) {
    if (writeLog) {
      writeLog("> 类型检查通过\n");
    }
    result.checked = true;
    result.passed = true;
    return result;
  }

  if (writeLog) {
    writeLog(`> 类型检查未通过（exit ${code}）:\n${output}\n`);
  }

  // 环境性问题（超时/工具或配置问题，输出中无 TS 诊断）放行，仅记录日志
  const hasTsDiagnostics = /error TS\d+:/.test(output);
  if (timedOut || !hasTsDiagnostics) {
    log(projectId, "WARN", "Typecheck gate passed through: environment issue, not TS diagnostics", {
      projectId,
      command,
      code,
      timedOut,
      output: truncateOutput(output),
    });
    result.checked = true;
    result.passed = true;
    result.reason = timedOut ? "timeout-passed-through" : "non-ts-error-passed-through";
    return result;
  }

  // 真实类型错误：拦截 dev 启动，错误明细完整透传给调用方
  const errorParser = new BuildErrorParser();
  const userFriendlyMessage = errorParser.parseBuildError(output, projectId);
  const truncated = truncateOutput(output);
  throw new BusinessError(
    `开发服务器启动前 TypeScript 类型检查未通过（与 build 同一标准），请修复后重试：\n${truncated}`,
    {
      code: ERROR_CODES.TYPECHECK_FAILED,
      command,
      suggestion: userFriendlyMessage,
    }
  );
}

export { runDevTypecheckGate };
