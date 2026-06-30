import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../log/logUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Vendored opencode-hooks-plugin (npm: opencode-hooks-plugin@0.1.0) */
const OPENCODE_HOOKS_PLUGIN_ASSETS = path.join(
  __dirname,
  "../../assets/opencode-hooks-plugin"
);

/** OpenCode 平台变量注入插件（直改 tool.execute.before，与用户 PreToolUse hook 解耦） */
const OPENCODE_PLATFORM_ENV_PLUGIN_ASSETS = path.join(
  __dirname,
  "../../assets/opencode-platform-env-plugin"
);

/** Codex 官方文档支持的生命周期事件 */
const CODEX_HOOK_EVENTS = new Set([
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "Stop",
]);

const OPENCODE_PLUGIN_ENTRY = "opencode-hooks-plugin.js";
const OPENCODE_PLUGIN_DIR = "opencode-hooks-plugin";
const OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY = "opencode-platform-env-plugin.js";
const PLATFORM_ENV_SCRIPT_PATH = "hooks/platform-env.sh";

/**
 * @param {unknown} value
 * @param {number} defaultSec
 * @returns {number}
 */
function parseTimeoutSeconds(value, defaultSec = 30) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultSec;
}

/**
 * @param {unknown} value
 * @returns {object|null}
 */
function parseHookHandlerObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 规范化 hooks 配置：确保 hooks 数组内为对象而非 JSON 字符串
 * @param {Record<string, unknown>|null|undefined} hooksMap
 * @returns {Record<string, unknown[]>|null}
 */
function normalizeHooksMap(hooksMap) {
  if (!hooksMap || typeof hooksMap !== "object" || Array.isArray(hooksMap)) {
    return null;
  }

  const normalized = {};
  for (const [eventName, matcherGroups] of Object.entries(hooksMap)) {
    if (!Array.isArray(matcherGroups)) continue;

    const groups = [];
    for (const group of matcherGroups) {
      if (!group || typeof group !== "object") continue;
      const handlers = [];
      const rawHandlers = Array.isArray(group.hooks) ? group.hooks : [];
      for (const rawHandler of rawHandlers) {
        const handler = parseHookHandlerObject(rawHandler);
        if (handler) handlers.push(handler);
      }
      if (handlers.length === 0) continue;
      groups.push({
        ...group,
        hooks: handlers,
      });
    }

    if (groups.length > 0) {
      normalized[eventName] = groups;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * @param {string|undefined|null} hooksConfig
 * @returns {Record<string, unknown[]>|null}
 */
function parseHooksConfigString(hooksConfig) {
  return parseHooksConfigWithStatus(hooksConfig).hooksMap;
}

/**
 * @param {string|undefined|null} hooksConfig
 * @returns {{ attempted: boolean, hooksMap: Record<string, unknown[]>|null, error: string|null }}
 */
function parseHooksConfigWithStatus(hooksConfig) {
  if (hooksConfig == null || !String(hooksConfig).trim()) {
    return { attempted: false, hooksMap: null, error: null };
  }

  try {
    const parsed = JSON.parse(hooksConfig);
    return {
      attempted: true,
      hooksMap: normalizeHooksMap(parsed),
      error: null,
    };
  } catch (e) {
    return {
      attempted: true,
      hooksMap: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Shell 单引号转义
 * @param {string} value
 */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 将 header 值中的 $ENV_VAR 转为 bash 运行时展开形式（与 Claude http hook 语义对齐）
 * @param {string} value
 */
function toBashEnvExpandable(value) {
  return String(value).replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, "${$1}");
}

const CODEX_GIT_ROOT_RESOLVER = /git rev-parse --show-toplevel/;

/**
 * 判断 command 是否为需基于 git 根目录解析的脚本路径（而非完整 shell 命令）
 * @param {string} command
 */
function isLikelyScriptPath(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (CODEX_GIT_ROOT_RESOLVER.test(trimmed)) return false;
  if (/[|;&`<>$()]/.test(trimmed)) return false;
  if (/^(bash|sh|zsh|dash|python3?|node|npm|npx|curl|wget|echo|env|cd|export|test|\[)\s+/i.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("/")) return true;
  if (trimmed.includes("/") || /\.(sh|bash|py|js|mjs|cjs|ts|pl|rb)$/i.test(trimmed)) {
    return true;
  }
  if (/^[\w.-]+\.sh$/i.test(trimmed)) return true;
  return false;
}

/**
 * 将相对脚本路径规范为基于 git 根目录的 bash 调用，避免 Codex 从子目录启动时找不到脚本
 * @param {string} command
 */
function normalizeCodexCommand(command) {
  const trimmed = command.trim();
  if (!isLikelyScriptPath(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `bash "${escaped}"`;
  }

  const relativePath = trimmed.replace(/^\.\//, "");
  const codexHooksPrefix = ".codex/hooks/";
  if (relativePath.startsWith(codexHooksPrefix)) {
    const scriptName = relativePath.slice(codexHooksPrefix.length);
    if (scriptName && !scriptName.includes("/")) {
      return buildCodexHookCommand(scriptName);
    }
  }

  if (/^[\w.-]+\.sh$/i.test(relativePath)) {
    return buildCodexHookCommand(relativePath);
  }

  const escapedRelative = relativePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/${escapedRelative}"`;
}

/**
 * @param {Record<string, string>|undefined|null} headers
 * @returns {string[]}
 */
function buildCurlHeaderArgs(headers) {
  if (!headers || typeof headers !== "object") {
    return ['-H "Content-Type: application/json"'];
  }

  const args = [];
  const entries = Object.entries(headers);
  const hasContentType = entries.some(([key]) => key.toLowerCase() === "content-type");

  if (!hasContentType) {
    args.push('-H "Content-Type: application/json"');
  }

  for (const [key, value] of entries) {
    if (value == null) continue;
    const headerKey = String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const headerValue = toBashEnvExpandable(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    args.push(`-H "${headerKey}: ${headerValue}"`);
  }

  return args;
}

/**
 * @param {string} url
 * @param {number} timeoutSec
 * @param {Record<string, string>|undefined|null} headers
 */
function buildHttpWrapperScript(url, timeoutSec, headers) {
  const headerArgs = buildCurlHeaderArgs(headers).join(" ");
  return `#!/usr/bin/env bash
set -euo pipefail
curl -fsS -X POST ${headerArgs} --data-binary @- --max-time ${timeoutSec} ${shellSingleQuote(url)}
`;
}

/**
 * Codex 推荐基于 git 根目录解析 hook 脚本路径
 * @param {string} scriptName
 */
function buildCodexHookCommand(scriptName) {
  return `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/hooks/${scriptName}"`;
}

/**
 * 原子写入文本文件（先写 tmp 再 rename）
 * @param {string} targetPath
 * @param {string} content
 * @param {{ mode?: number }} [options]
 */
async function writeFileAtomic(targetPath, content, options = {}) {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  if (options.mode != null) {
    await fs.promises.chmod(tmpPath, options.mode);
  }
  await fs.promises.rename(tmpPath, targetPath);
}

/**
 * @param {string} targetPath
 * @param {unknown} data
 */
async function writeJsonFileAtomic(targetPath, data) {
  await writeFileAtomic(targetPath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 将 Claude 格式 hooks 转为 Codex hooks.json（仅保留 command；http 生成 wrapper 脚本）
 * @param {Record<string, unknown[]>} hooksMap
 * @param {string} codexHooksDir `.codex/hooks` 绝对路径
 * @param {string} logId
 * @returns {Promise<Record<string, unknown[]>|null>}
 */
async function transformHooksForCodex(hooksMap, codexHooksDir, logId) {
  const codexHooks = {};
  let wrapperIndex = 0;

  for (const [eventName, matcherGroups] of Object.entries(hooksMap)) {
    if (!CODEX_HOOK_EVENTS.has(eventName)) {
      log(logId, "WARN", "Skipping unsupported Codex hook event", { eventName });
      continue;
    }

    const transformedGroups = [];
    for (const group of matcherGroups) {
      if (!group || typeof group !== "object") continue;

      const transformedHandlers = [];
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];

      for (const handler of handlers) {
        if (!handler || typeof handler !== "object") continue;
        const type = handler.type;

        if (type === "command" && typeof handler.command === "string" && handler.command.trim()) {
          transformedHandlers.push({
            ...handler,
            type: "command",
            command: normalizeCodexCommand(handler.command),
          });
          continue;
        }

        if (type === "http" && typeof handler.url === "string" && handler.url.trim()) {
          const timeout = parseTimeoutSeconds(handler.timeout, 30);
          const scriptName = `http-hook-${wrapperIndex++}.sh`;
          const scriptPath = path.join(codexHooksDir, scriptName);
          const headers =
            handler.headers && typeof handler.headers === "object" && !Array.isArray(handler.headers)
              ? handler.headers
              : undefined;

          await fs.promises.mkdir(codexHooksDir, { recursive: true });
          await writeFileAtomic(
            scriptPath,
            buildHttpWrapperScript(handler.url.trim(), timeout, headers),
            { mode: 0o755 }
          );

          transformedHandlers.push({
            type: "command",
            command: buildCodexHookCommand(scriptName),
            timeout,
            ...(handler.statusMessage ? { statusMessage: handler.statusMessage } : {}),
          });
          continue;
        }

        if (type === "prompt" || type === "agent") {
          log(logId, "WARN", "Codex skips non-command hook handler", { eventName, type });
          continue;
        }

        log(logId, "WARN", "Codex skips unknown hook handler", { eventName, type });
      }

      if (transformedHandlers.length > 0) {
        transformedGroups.push({
          ...group,
          hooks: transformedHandlers,
        });
      }
    }

    if (transformedGroups.length > 0) {
      codexHooks[eventName] = transformedGroups;
    }
  }

  return Object.keys(codexHooks).length > 0 ? codexHooks : null;
}

/**
 * 复制 vendored opencode-hooks-plugin 到 `.opencode/plugins/`
 * @param {string} opencodePluginsDir
 * @param {string} logId
 */
async function installOpencodeHooksPlugin(opencodePluginsDir, logId) {
  const sourceDistDir = path.join(OPENCODE_HOOKS_PLUGIN_ASSETS, "dist");
  if (!fs.existsSync(sourceDistDir)) {
    log(logId, "WARN", "opencode-hooks-plugin assets missing, skipping OpenCode plugin install", {
      sourceDistDir,
    });
    return false;
  }

  await fs.promises.mkdir(opencodePluginsDir, { recursive: true });

  const targetPluginRoot = path.join(opencodePluginsDir, OPENCODE_PLUGIN_DIR, "dist");
  await fs.promises.mkdir(targetPluginRoot, { recursive: true });

  const entries = await fs.promises.readdir(sourceDistDir);
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    await fs.promises.copyFile(
      path.join(sourceDistDir, entry),
      path.join(targetPluginRoot, entry)
    );
  }

  const entryFile = path.join(opencodePluginsDir, OPENCODE_PLUGIN_ENTRY);
  const entryContent = `export { default } from "./${OPENCODE_PLUGIN_DIR}/dist/index.js";\n`;
  await writeFileAtomic(entryFile, entryContent);

  log(logId, "INFO", "Installed opencode-hooks-plugin into .opencode/plugins", {
    entryFile: OPENCODE_PLUGIN_ENTRY,
  });
  return true;
}

/**
 * @param {Array<{path: string, content: string}>|undefined} hookScripts
 */
function hasPlatformEnvScript(hookScripts) {
  if (!Array.isArray(hookScripts)) {
    return false;
  }
  return hookScripts.some(
    (script) => script && script.path === PLATFORM_ENV_SCRIPT_PATH
  );
}

/**
 * 安装 OpenCode platform-env 插件到 `.opencode/plugins/`
 * @param {string} opencodePluginsDir
 * @param {string} logId
 */
async function installOpencodePlatformEnvPlugin(opencodePluginsDir, logId) {
  const sourceFile = path.join(OPENCODE_PLATFORM_ENV_PLUGIN_ASSETS, "platform-env-plugin.js");
  if (!fs.existsSync(sourceFile)) {
    log(logId, "WARN", "opencode-platform-env-plugin assets missing, skipping install", {
      sourceFile,
    });
    return false;
  }

  await fs.promises.mkdir(opencodePluginsDir, { recursive: true });
  await fs.promises.copyFile(
    sourceFile,
    path.join(opencodePluginsDir, OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY)
  );

  log(logId, "INFO", "Installed opencode-platform-env-plugin into .opencode/plugins", {
    entryFile: OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY,
  });
  return true;
}

/**
 * @param {string} settingsPath
 * @returns {Promise<{ settings: Record<string, unknown>, corrupt: boolean }>}
 */
async function readClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, corrupt: false };
  }
  try {
    const content = await fs.promises.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { settings: parsed, corrupt: false };
    }
    return { settings: {}, corrupt: true };
  } catch {
    return { settings: {}, corrupt: true };
  }
}

/**
 * 写入 hook 外挂脚本（相对 .claude 目录）
 * @param {string} claudeDir
 * @param {Array<{path: string, content: string}>|undefined} hookScripts
 * @param {string} logId
 */
async function writeHookScripts(claudeDir, hookScripts, logId) {
  if (!Array.isArray(hookScripts) || hookScripts.length === 0) return;

  const hooksDir = path.join(claudeDir, "hooks");
  await fs.promises.mkdir(hooksDir, { recursive: true });

  for (const script of hookScripts) {
    if (!script || !script.path || script.content == null) continue;

    const normalizedScriptPath = path.normalize(script.path);
    if (normalizedScriptPath.startsWith("..") || path.isAbsolute(normalizedScriptPath)) {
      log(logId, "WARN", "Hook script path contains traversal, skipping", { path: script.path });
      continue;
    }

    const scriptFilePath = path.join(claudeDir, normalizedScriptPath);
    const scriptDir = path.dirname(scriptFilePath);
    await fs.promises.mkdir(scriptDir, { recursive: true });

    await writeFileAtomic(scriptFilePath, script.content, { mode: 0o755 });
    log(logId, "INFO", "Written hook script", { path: script.path });
  }
}

/**
 * 清除 hook 相关产物（不含 permissions 等其他 settings 字段）
 * @param {string} userWorkspaceRoot
 */
async function clearHookArtifacts(userWorkspaceRoot) {
  const targets = [
    path.join(userWorkspaceRoot, ".codex", "hooks.json"),
    path.join(userWorkspaceRoot, ".codex", "hooks"),
    path.join(userWorkspaceRoot, ".opencode", "plugins", OPENCODE_PLUGIN_ENTRY),
    path.join(userWorkspaceRoot, ".opencode", "plugins", OPENCODE_PLUGIN_DIR),
    path.join(userWorkspaceRoot, ".opencode", "plugins", OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY),
    path.join(userWorkspaceRoot, ".claude", "hooks"),
  ];

  for (const target of targets) {
    if (fs.existsSync(target)) {
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  }
}

/**
 * 清除工作空间内旧的 agent hook 相关配置（全量，供测试或显式重置使用）
 * @param {string} userWorkspaceRoot
 */
async function clearAgentHookConfigs(userWorkspaceRoot) {
  const targets = [
    path.join(userWorkspaceRoot, ".mcp.json"),
    path.join(userWorkspaceRoot, ".claude", "settings.json"),
  ];

  for (const target of targets) {
    if (fs.existsSync(target)) {
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  }

  await clearHookArtifacts(userWorkspaceRoot);
}

/**
 * 在 staging 目录预生成 Codex/OpenCode 产物，成功后再替换工作区，减少半更新窗口
 * @param {string} userWorkspaceRoot
 * @param {Record<string, unknown[]>} hooksMap
 * @param {string} logId
 */
async function stageRuntimeHookArtifacts(userWorkspaceRoot, hooksMap, logId, installPlatformEnvPlugin = false) {
  const stagingRoot = path.join(
    userWorkspaceRoot,
    ".tmp",
    `hook-staging-${Date.now()}-${process.pid}`
  );
  const codexStagingRoot = path.join(stagingRoot, "codex");
  const codexHooksDir = path.join(codexStagingRoot, "hooks");
  const opencodePluginsStaging = path.join(stagingRoot, "opencode", "plugins");

  await fs.promises.mkdir(codexHooksDir, { recursive: true });

  const codexHooks = await transformHooksForCodex(hooksMap, codexHooksDir, logId);
  const pluginInstalled = await installOpencodeHooksPlugin(opencodePluginsStaging, logId);
  const platformEnvPluginInstalled = installPlatformEnvPlugin
    ? await installOpencodePlatformEnvPlugin(opencodePluginsStaging, logId)
    : false;

  return {
    stagingRoot,
    codexStagingRoot,
    codexHooks,
    pluginInstalled,
    platformEnvPluginInstalled,
  };
}

/**
 * 将 staging 中的 Codex/OpenCode 产物应用到工作区
 * @param {string} userWorkspaceRoot
 * @param {{ stagingRoot: string, codexStagingRoot: string, codexHooks: Record<string, unknown[]>|null, pluginInstalled: boolean, platformEnvPluginInstalled?: boolean }} staged
 * @param {string} logId
 */
async function applyStagedRuntimeHookArtifacts(userWorkspaceRoot, staged, logId) {
  const codexRoot = path.join(userWorkspaceRoot, ".codex");
  const codexHooksTarget = path.join(codexRoot, "hooks");
  const opencodePluginsTarget = path.join(userWorkspaceRoot, ".opencode", "plugins");

  await clearHookArtifacts(userWorkspaceRoot);
  await fs.promises.mkdir(codexRoot, { recursive: true });

  const stagedCodexHooksDir = path.join(staged.codexStagingRoot, "hooks");
  if (fs.existsSync(stagedCodexHooksDir)) {
    await fs.promises.rename(stagedCodexHooksDir, codexHooksTarget);
  }

  if (staged.codexHooks) {
    await writeJsonFileAtomic(
      path.join(codexRoot, "hooks.json"),
      { hooks: staged.codexHooks }
    );
    log(logId, "INFO", "Written .codex/hooks.json", {
      events: Object.keys(staged.codexHooks),
    });
  }

  if (staged.pluginInstalled) {
    await fs.promises.mkdir(opencodePluginsTarget, { recursive: true });
    const stagedPluginEntry = path.join(staged.stagingRoot, "opencode", "plugins", OPENCODE_PLUGIN_ENTRY);
    const stagedPluginDir = path.join(staged.stagingRoot, "opencode", "plugins", OPENCODE_PLUGIN_DIR);
    if (fs.existsSync(stagedPluginEntry)) {
      await fs.promises.copyFile(
        stagedPluginEntry,
        path.join(opencodePluginsTarget, OPENCODE_PLUGIN_ENTRY)
      );
    }
    if (fs.existsSync(stagedPluginDir)) {
      await fs.promises.cp(stagedPluginDir, path.join(opencodePluginsTarget, OPENCODE_PLUGIN_DIR), {
        recursive: true,
        force: true,
      });
    }
  }

  if (staged.platformEnvPluginInstalled) {
    await fs.promises.mkdir(opencodePluginsTarget, { recursive: true });
    const stagedPlatformEnvPlugin = path.join(
      staged.stagingRoot,
      "opencode",
      "plugins",
      OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY
    );
    if (fs.existsSync(stagedPlatformEnvPlugin)) {
      await fs.promises.copyFile(
        stagedPlatformEnvPlugin,
        path.join(opencodePluginsTarget, OPENCODE_PLATFORM_ENV_PLUGIN_ENTRY)
      );
    }
  }
}

/**
 * 写入 Claude Code / Codex / OpenCode 三套 Hook 相关配置
 *
 * - Claude Code: `.claude/settings.json` + `.mcp.json` + hook scripts
 * - Codex: `.codex/hooks.json`（http 转为 command wrapper）
 * - OpenCode: `.claude/settings.json`（桥接插件读取）+ `.opencode/plugins/opencode-hooks-plugin`
 *
 * 仅在对应配置解析成功后才会清除并重写，避免无效 payload 误删旧配置。
 *
 * @param {string} userWorkspaceRoot
 * @param {object} options
 * @param {string|undefined} options.mcpServersConfig
 * @param {string|undefined} options.hooksConfig
 * @param {string|undefined} options.permissionsConfig
 * @param {Array|undefined} options.hookScripts
 * @param {string} logId
 */
async function writeAgentHookConfigs(
  userWorkspaceRoot,
  { mcpServersConfig, hooksConfig, permissionsConfig, hookScripts },
  logId
) {
  const hasMcpInput = !!(mcpServersConfig && mcpServersConfig.trim());
  const hooksStatus = parseHooksConfigWithStatus(hooksConfig);
  const hasPermsInput = !!(permissionsConfig && permissionsConfig.trim());
  const hasScripts = Array.isArray(hookScripts) && hookScripts.length > 0;

  if (hooksStatus.attempted && hooksStatus.error) {
    log(logId, "ERROR", "Invalid hooksConfig, keeping existing hook configs", {
      error: hooksStatus.error,
    });
  }

  let mcpServers = null;
  let shouldUpdateMcp = false;
  if (hasMcpInput) {
    try {
      mcpServers = JSON.parse(mcpServersConfig);
      shouldUpdateMcp = true;
    } catch (e) {
      log(logId, "WARN", "Failed to parse mcpServersConfig, keeping existing .mcp.json", {
        error: e.message,
      });
    }
  }

  let permissions = null;
  let shouldUpdatePermissions = false;
  if (hasPermsInput) {
    try {
      permissions = JSON.parse(permissionsConfig);
      shouldUpdatePermissions = true;
    } catch (e) {
      log(logId, "WARN", "Failed to parse permissionsConfig, keeping existing permissions", {
        error: e.message,
      });
    }
  }

  const shouldUpdateHooks = hooksStatus.attempted && !hooksStatus.error;
  const shouldUpdateHookScripts = hasScripts;
  const installPlatformEnvPlugin = hasPlatformEnvScript(hookScripts);

  if (!shouldUpdateMcp && !shouldUpdateHooks && !shouldUpdatePermissions && !shouldUpdateHookScripts) {
    return;
  }

  const claudeDir = path.join(userWorkspaceRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  let stagedRuntime = null;

  try {
    await fs.promises.mkdir(claudeDir, { recursive: true });

    if (shouldUpdateHooks && hooksStatus.hooksMap) {
      stagedRuntime = await stageRuntimeHookArtifacts(
        userWorkspaceRoot,
        hooksStatus.hooksMap,
        logId,
        installPlatformEnvPlugin
      );
    }

    if (shouldUpdateMcp) {
      await writeJsonFileAtomic(path.join(userWorkspaceRoot, ".mcp.json"), { mcpServers });
      log(logId, "INFO", "Written .mcp.json to workspace root");
    }

    if (shouldUpdateHooks && hooksStatus.hooksMap && stagedRuntime) {
      await applyStagedRuntimeHookArtifacts(userWorkspaceRoot, stagedRuntime, logId);
    } else if (shouldUpdateHooks && !hooksStatus.hooksMap) {
      await clearHookArtifacts(userWorkspaceRoot);
    }

    if (shouldUpdateHooks || shouldUpdatePermissions) {
      const { settings, corrupt } = await readClaudeSettings(settingsPath);

      if (corrupt && !shouldUpdateHooks) {
        log(logId, "WARN", "Corrupt .claude/settings.json, skipping settings update", {
          settingsPath,
        });
      } else {
        if (shouldUpdatePermissions && corrupt) {
          log(logId, "WARN", "Corrupt .claude/settings.json, rewriting hooks without preserving old fields", {
            settingsPath,
          });
        }

        const nextSettings = corrupt ? {} : { ...settings };

        if (shouldUpdateHooks) {
          if (hooksStatus.hooksMap) {
            nextSettings.hooks = hooksStatus.hooksMap;
          } else {
            delete nextSettings.hooks;
          }
        }

        if (shouldUpdatePermissions && !corrupt) {
          nextSettings.permissions = permissions;
        }

        if (Object.keys(nextSettings).length > 0) {
          await writeJsonFileAtomic(settingsPath, nextSettings);
          log(logId, "INFO", "Written .claude/settings.json", { keys: Object.keys(nextSettings) });
        } else if (fs.existsSync(settingsPath)) {
          await fs.promises.rm(settingsPath, { force: true });
        }
      }
    }

    if (shouldUpdateHookScripts) {
      const claudeHooksDir = path.join(claudeDir, "hooks");
      if (fs.existsSync(claudeHooksDir)) {
        await fs.promises.rm(claudeHooksDir, { recursive: true, force: true });
      }
      await writeHookScripts(claudeDir, hookScripts, logId);

      const opencodePluginsDir = path.join(userWorkspaceRoot, ".opencode", "plugins");
      if (installPlatformEnvPlugin) {
        await installOpencodePlatformEnvPlugin(opencodePluginsDir, logId);
      }
    }
  } catch (e) {
    log(logId, "ERROR", "Failed to write agent hook configs, keeping previous files when possible", {
      error: e.message,
    });
  } finally {
    if (stagedRuntime?.stagingRoot && fs.existsSync(stagedRuntime.stagingRoot)) {
      await fs.promises.rm(stagedRuntime.stagingRoot, { recursive: true, force: true });
    }
  }
}

export {
  parseHooksConfigString,
  parseHooksConfigWithStatus,
  normalizeHooksMap,
  transformHooksForCodex,
  buildHttpWrapperScript,
  buildCodexHookCommand,
  normalizeCodexCommand,
  isLikelyScriptPath,
  toBashEnvExpandable,
  parseTimeoutSeconds,
  writeFileAtomic,
  writeJsonFileAtomic,
  installOpencodeHooksPlugin,
  installOpencodePlatformEnvPlugin,
  hasPlatformEnvScript,
  clearAgentHookConfigs,
  clearHookArtifacts,
  writeAgentHookConfigs,
  CODEX_HOOK_EVENTS,
};
