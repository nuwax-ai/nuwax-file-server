import fs from "fs";
import os from "os";
import path from "path";
import {
  normalizeHooksMap,
  parseHooksConfigString,
  parseHooksConfigWithStatus,
  transformHooksForCodex,
  buildHttpWrapperScript,
  buildCodexHookCommand,
  normalizeCodexCommand,
  isLikelyScriptPath,
  toBashEnvExpandable,
  parseTimeoutSeconds,
  installOpencodeHooksPlugin,
  writeAgentHookConfigs,
  clearAgentHookConfigs,
} from "../../src/utils/computer/hookConfigUtils.js";

describe("hookConfigUtils", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parseHooksConfigString normalizes stringified hook handlers", () => {
    const raw = JSON.stringify({
      UserPromptSubmit: [
        {
          hooks: [
            JSON.stringify({ type: "http", url: "https://example.com/hook", timeout: 30 }),
          ],
        },
      ],
    });

    const parsed = parseHooksConfigString(raw);
    expect(parsed.UserPromptSubmit[0].hooks[0]).toEqual({
      type: "http",
      url: "https://example.com/hook",
      timeout: 30,
    });
  });

  test("parseHooksConfigWithStatus reports parse errors", () => {
    const result = parseHooksConfigWithStatus("{invalid");
    expect(result.attempted).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.hooksMap).toBeNull();
  });

  test("parseTimeoutSeconds accepts numeric strings", () => {
    expect(parseTimeoutSeconds("15", 30)).toBe(15);
    expect(parseTimeoutSeconds("abc", 30)).toBe(30);
  });

  test("buildHttpWrapperScript supports custom headers and HTTP error fail-fast", () => {
    const script = buildHttpWrapperScript("https://example.com/hook", 20, {
      Authorization: "Bearer token",
    });
    expect(script).toContain("curl -fsS");
    expect(script).toContain('Authorization: Bearer token');
    expect(script).toContain("--max-time 20");
  });

  test("buildHttpWrapperScript expands header env vars for bash runtime", () => {
    const script = buildHttpWrapperScript("https://example.com/hook", 20, {
      Authorization: "Bearer $MY_TOKEN",
    });
    expect(script).toContain("Bearer ${MY_TOKEN}");
  });

  test("toBashEnvExpandable converts $VAR to ${VAR}", () => {
    expect(toBashEnvExpandable("Bearer $MY_TOKEN")).toBe("Bearer ${MY_TOKEN}");
    expect(toBashEnvExpandable("Bearer $my_token")).toBe("Bearer ${my_token}");
    expect(toBashEnvExpandable("plain")).toBe("plain");
  });

  test("buildHttpWrapperScript expands lowercase header env vars for bash runtime", () => {
    const script = buildHttpWrapperScript("https://example.com/hook", 20, {
      Authorization: "Bearer $my_token",
    });
    expect(script).toContain("Bearer ${my_token}");
  });

  test("normalizeCodexCommand resolves relative script paths from git root", () => {
    expect(normalizeCodexCommand("echo stop")).toBe("echo stop");
    expect(normalizeCodexCommand("bash -c 'echo hi'")).toBe("bash -c 'echo hi'");
    expect(normalizeCodexCommand("./scripts/hook.sh")).toContain("git rev-parse --show-toplevel");
    expect(normalizeCodexCommand("./scripts/hook.sh")).toContain("/scripts/hook.sh");
    expect(normalizeCodexCommand(".codex/hooks/custom.sh")).toBe(
      buildCodexHookCommand("custom.sh")
    );
    expect(normalizeCodexCommand("custom.sh")).toBe(buildCodexHookCommand("custom.sh"));
    expect(normalizeCodexCommand(buildCodexHookCommand("already.sh"))).toBe(
      buildCodexHookCommand("already.sh")
    );
  });

  test("transformHooksForCodex normalizes native command script paths", async () => {
    const hooksMap = normalizeHooksMap({
      Stop: [
        {
          hooks: [
            { type: "command", command: "echo stop" },
            { type: "command", command: "./scripts/stop.sh" },
          ],
        },
      ],
    });

    const codexHooks = await transformHooksForCodex(
      hooksMap,
      path.join(tmpDir, ".codex", "hooks"),
      "test"
    );

    expect(codexHooks.Stop[0].hooks[0].command).toBe("echo stop");
    expect(codexHooks.Stop[0].hooks[1].command).toMatch(/^bash "/);
    expect(codexHooks.Stop[0].hooks[1].command).toContain("/scripts/stop.sh");
  });

  test("buildCodexHookCommand resolves from git root via bash", () => {
    expect(buildCodexHookCommand("http-hook-0.sh")).toMatch(/^bash "/);
    expect(buildCodexHookCommand("http-hook-0.sh")).toContain("git rev-parse --show-toplevel");
    expect(buildCodexHookCommand("http-hook-0.sh")).toContain(".codex/hooks/http-hook-0.sh");
  });

  test("transformHooksForCodex converts http hook to command wrapper script", async () => {
    const hooksMap = normalizeHooksMap({
      UserPromptSubmit: [
        {
          hooks: [{ type: "http", url: "https://example.com/hook", timeout: "15" }],
        },
      ],
    });

    const codexHooksDir = path.join(tmpDir, ".codex", "hooks");
    const codexHooks = await transformHooksForCodex(hooksMap, codexHooksDir, "test");

    expect(codexHooks.UserPromptSubmit[0].hooks[0].type).toBe("command");
    expect(codexHooks.UserPromptSubmit[0].hooks[0].command).toMatch(/^bash "/);
    expect(codexHooks.UserPromptSubmit[0].hooks[0].timeout).toBe(15);

    const scriptPath = path.join(codexHooksDir, "http-hook-0.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toContain("https://example.com/hook");
    expect(script).toContain("--max-time 15");
    expect(script).toContain("curl -fsS");
  });

  test("writeAgentHookConfigs writes claude, codex and opencode plugin files", async () => {
    const hooksConfig = JSON.stringify({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo ok" }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "http", url: "https://example.com/hook", timeout: 20 }],
        },
      ],
    });

    await writeAgentHookConfigs(tmpDir, { hooksConfig }, "test");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8")
    );
    expect(claudeSettings.hooks.PreToolUse).toBeDefined();
    expect(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].type).toBe("http");

    const codexSettings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".codex", "hooks.json"), "utf-8")
    );
    expect(codexSettings.hooks.UserPromptSubmit[0].hooks[0].type).toBe("command");

    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin", "dist", "index.js"))).toBe(true);
  });

  test("empty hooksConfig clears hook artifacts", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
    }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin.js"))).toBe(true);

    await writeAgentHookConfigs(tmpDir, { hooksConfig: "{}" }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin.js"))).toBe(false);
  });

  test("permissions-only update preserves existing hooks", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
    }, "test");

    await writeAgentHookConfigs(tmpDir, {
      permissionsConfig: JSON.stringify({ allow: ["Bash"] }),
    }, "test");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8")
    );
    expect(claudeSettings.hooks.Stop).toBeDefined();
    expect(claudeSettings.permissions).toEqual({ allow: ["Bash"] });
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);
  });

  test("codex-only-unsupported events removes stale codex hooks.json", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        UserPromptSubmit: [
          { hooks: [{ type: "http", url: "https://example.com/hook", timeout: 10 }] },
        ],
      }),
    }, "test");
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);

    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        PostToolUseFailure: [
          { hooks: [{ type: "command", command: "echo failure" }] },
        ],
      }),
    }, "test");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8")
    );
    expect(claudeSettings.hooks.PostToolUseFailure).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin.js"))).toBe(true);
  });

  test("corrupt settings.json is preserved on permissions-only update", async () => {
    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(
      settingsPath,
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}',
      "utf-8"
    );

    await writeAgentHookConfigs(tmpDir, {
      permissionsConfig: JSON.stringify({ allow: ["Bash"] }),
    }, "test");

    expect(fs.readFileSync(settingsPath, "utf-8")).toContain("echo stop");
  });

  test("hookScripts-only update does not remove codex hooks.json", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
    }, "test");
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);

    await writeAgentHookConfigs(tmpDir, {
      hookScripts: [{ path: "hooks/only.sh", content: "#!/bin/bash\necho only\n" }],
    }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, ".claude", "hooks", "only.sh"), "utf-8")).toContain("echo only");
  });

  test("invalid hooksConfig does not wipe existing hook configs", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
    }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);

    await writeAgentHookConfigs(tmpDir, { hooksConfig: "{invalid" }, "test");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8")
    );
    expect(claudeSettings.hooks.Stop).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);
  });

  test("writeAgentHookConfigs clears stale .claude/hooks scripts when hookScripts provided", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
      hookScripts: [{ path: "hooks/old.sh", content: "#!/bin/bash\necho old\n" }],
    }, "test");

    expect(fs.readFileSync(path.join(tmpDir, ".claude", "hooks", "old.sh"), "utf-8")).toContain("echo old");

    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
      hookScripts: [{ path: "hooks/new.sh", content: "#!/bin/bash\necho new\n" }],
    }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".claude", "hooks", "old.sh"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, ".claude", "hooks", "new.sh"), "utf-8")).toContain("echo new");
  });

  test("installOpencodeHooksPlugin writes plugin entry re-export", async () => {
    const pluginsDir = path.join(tmpDir, ".opencode", "plugins");
    await installOpencodeHooksPlugin(pluginsDir, "test");

    const entry = fs.readFileSync(path.join(pluginsDir, "opencode-hooks-plugin.js"), "utf-8");
    expect(entry).toContain('export { default } from "./opencode-hooks-plugin/dist/index.js"');
  });

  test("clearAgentHookConfigs removes generated hook files", async () => {
    await writeAgentHookConfigs(tmpDir, {
      hooksConfig: JSON.stringify({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      }),
    }, "test");

    expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);

    await clearAgentHookConfigs(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "plugins", "opencode-hooks-plugin.js"))).toBe(false);
  });
});
