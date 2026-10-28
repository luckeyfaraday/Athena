import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentConfig,
  launchCommand,
  launchHermesPowerShellCommand,
  launchPowerShellCommand,
  launchResumeCommand,
  launchResumePowerShellCommand,
  repairClaudeBinaryPowerShell,
  terminalLaunch,
} from "../dist-electron/terminal-launch.js";
import { quoteShell } from "../dist-electron/platform.js";

// quoteShell wraps a value in single quotes and escapes embedded single quotes
// as '\'' . A dangerous payload must therefore never appear unescaped.
const INJECTION = "'; rm -rf ~; echo '";

test("terminalLaunch uses the platform launch shell", () => {
  const launch = terminalLaunch("codex", "/home/dev/project", "/tmp/prompt.md");
  if (process.platform === "win32") {
    assert.equal(["pwsh.exe", "powershell.exe"].includes(launch.command), true);
    assert.equal(launch.args[0], "-NoLogo");
    assert.equal(launch.args[4], "-Command");
    assert.equal(typeof launch.args[5], "string");
    return;
  }
  assert.equal(launch.command, "bash");
  assert.equal(launch.args[0], "-lc");
  assert.equal(typeof launch.args[1], "string");
});

test("launchCommand cd's into the workspace and execs a login shell for plain shells", () => {
  const command = launchCommand("shell", "/home/dev/project", null);
  assert.match(command, /^cd '\/home\/dev\/project'/);
  assert.match(command, /exec bash -l$/);
});

test("launchCommand for an agent guards on command availability before launching", () => {
  const command = launchCommand("codex", "/home/dev/project", "/tmp/prompt.md");
  // Codex runs from npm's machine-wide install: no private prefix of Athena's own (see terminal-env.ts)
  assert.doesNotMatch(command, /NPM_CONFIG_PREFIX|\.npm-global/);
  assert.match(command, /command -v 'codex'/);
  // a missing CLI says how to install it
  assert.match(command, /npm install -g @openai\/codex@latest/);
  assert.match(command, /codex -c shell_environment_policy.inherit=all --cd '\/home\/dev\/project' -- "\$\(cat '\/tmp\/prompt.md'\)"/);
});

test("launchCommand loads nvm before the command-availability guard", () => {
  // Agents installed via nvm (codex/claude/...) live under a node version bin
  // that only lands on PATH when ~/.bashrc runs. `bash -lc` is login but NOT
  // interactive, so ~/.bashrc returns early and nvm never loads. We must source
  // nvm ourselves, and crucially BEFORE the `command -v` check, or the guard
  // false-negatives and the pane dies with "not installed or not on PATH".
  const command = launchCommand("codex", "/home/dev/project", null);
  const nvmIndex = command.indexOf('$NVM_DIR/nvm.sh');
  const guardIndex = command.indexOf("command -v 'codex'");
  assert.ok(nvmIndex >= 0, "expected nvm load in the launch command");
  assert.ok(guardIndex >= 0, "expected the command -v guard");
  assert.ok(nvmIndex < guardIndex, "nvm must load before the command -v guard");
});

test("launchResumeCommand loads nvm before the command-availability guard", () => {
  const command = launchResumeCommand("codex", "/home/dev/project", "abc-123");
  const nvmIndex = command.indexOf('$NVM_DIR/nvm.sh');
  const guardIndex = command.indexOf("command -v 'codex'");
  assert.ok(nvmIndex >= 0 && guardIndex >= 0 && nvmIndex < guardIndex);
});

test("launchCommand treats Athena Code as a PATH-installed agent like the others", () => {
  const command = launchCommand("athena", "/home/dev/project", null);
  assert.match(command, /command -v 'athena-code'/);
  assert.match(command, /athena-code '\/home\/dev\/project'/);
});

test("launchCommand single-quote-escapes a malicious workspace path", () => {
  const command = launchCommand("codex", INJECTION, null);
  // The payload appears only in fully quoteShell-escaped form, so the embedded
  // "; rm -rf ~" stays inert inside single quotes and cannot break out.
  assert.ok(command.includes(`cd ${quoteShell(INJECTION)}`));
});

test("launchResumeCommand wires the provider resume invocation with quoted ids", () => {
  const command = launchResumeCommand("claude", "/home/dev/project", "sess-123");
  assert.match(command, /claude .*--resume 'sess-123'/);
  const codex = launchResumeCommand("codex", "/home/dev/project", "abc-1");
  assert.doesNotMatch(codex, /NPM_CONFIG_PREFIX|\.npm-global/);
  assert.match(codex, /codex -c shell_environment_policy.inherit=all resume --cd '\/home\/dev\/project' 'abc-1'/);
});

test("launchResumeCommand escapes a malicious session id", () => {
  const command = launchResumeCommand("codex", "/home/dev/project", INJECTION);
  // The session id is only ever present as its quoteShell-escaped form.
  assert.ok(command.includes(quoteShell(INJECTION)));
});

test("agentConfig codex args inline the prompt via double-quoted command substitution", () => {
  const codex = agentConfig("codex");
  assert.equal(codex.executable, "codex");
  // Double-quoted $(...) is safe: bash does not re-evaluate the substituted text.
  assert.equal(codex.args("/ws", "/tmp/p.md", "bash"), `-c shell_environment_policy.inherit=all --cd '/ws' -- "$(cat '/tmp/p.md')"`);
  assert.equal(codex.args("/ws", null, "bash"), `-c shell_environment_policy.inherit=all --cd '/ws'`);
});

test("agentConfig claude args include the mcp config flag and quote the prompt path", () => {
  const claude = agentConfig("claude");
  assert.equal(
    claude.args("/ws", "/tmp/p.md", "bash", { configPath: "/tmp/mcp.json" }),
    `--mcp-config '/tmp/mcp.json' -- "$(cat '/tmp/p.md')"`,
  );
  assert.equal(claude.resumeArgs("/ws", "s1", "bash", { configPath: "/tmp/mcp.json" }), `claude --mcp-config '/tmp/mcp.json' --resume 's1'`);
});

test("agentConfig claude args pin a pre-assigned session id ahead of the other flags", () => {
  const claude = agentConfig("claude");
  assert.equal(
    claude.args("/ws", "/tmp/p.md", "bash", { configPath: "/tmp/mcp.json" }, "11111111-2222-3333-4444-555555555555"),
    `--session-id '11111111-2222-3333-4444-555555555555' --mcp-config '/tmp/mcp.json' -- "$(cat '/tmp/p.md')"`,
  );
  assert.equal(
    claude.args("/ws", null, "bash", null, "11111111-2222-3333-4444-555555555555"),
    `--session-id '11111111-2222-3333-4444-555555555555'`,
  );
});

test("launchCommand for claude threads the new session id through fully quoted", () => {
  const command = launchCommand("claude", "/home/dev/project", null, null, "abc-123");
  assert.match(command, /claude --session-id 'abc-123'/);
  // A malicious session id must only ever appear quoteShell-escaped.
  const hostile = launchCommand("claude", "/home/dev/project", null, null, INJECTION);
  assert.ok(hostile.includes(`--session-id ${quoteShell(INJECTION)}`));
});

test("launchCommand without a new session id matches the legacy claude launch", () => {
  const command = launchCommand("claude", "/home/dev/project", null, { configPath: "/tmp/mcp.json" });
  assert.doesNotMatch(command, /--session-id/);
  assert.match(command, /claude --mcp-config '\/tmp\/mcp.json'/);
});

test("PowerShell builder splats the new claude session id without string interpolation", () => {
  const command = launchPowerShellCommand("claude", "C:\\ws", null, null, "sess'9");
  // quotePowerShell doubles single quotes: ' -> ''
  assert.match(command, /\$newSessionId = 'sess''9'/);
  assert.match(command, /if \(\$newSessionId\) \{ \$agentArgs \+= @\('--session-id', \$newSessionId\) \}/);

  const withoutId = launchPowerShellCommand("claude", "C:\\ws", null, null);
  assert.doesNotMatch(withoutId, /\$newSessionId = /);
});

test("PowerShell claude builder separates variadic mcp config from the prompt", () => {
  const command = launchPowerShellCommand("claude", "C:\\ws", "C:\\tmp\\p.md", { configPath: "C:\\tmp\\mcp.json" });
  assert.match(command, /\$mcpConfigPath = 'C:\\tmp\\mcp\.json'/);
  assert.match(command, /\$agentArgs \+= @\('--mcp-config', \$mcpConfigPath, '--'\)/);
});

test("agentConfig codex injects MCP servers as quoted -c overrides", () => {
  const codex = agentConfig("codex");
  const mcp = {
    codexConfigArgs: [
      `mcp_servers.context_workspace.command="python3"`,
      `mcp_servers.context_workspace.args=["/opt/app/mcp_server/server.py"]`,
    ],
  };
  assert.equal(
    codex.args("/ws", "/tmp/p.md", "bash", mcp),
    `-c shell_environment_policy.inherit=all -c 'mcp_servers.context_workspace.command="python3"' -c 'mcp_servers.context_workspace.args=["/opt/app/mcp_server/server.py"]' --cd '/ws' -- "$(cat '/tmp/p.md')"`,
  );
  assert.equal(
    codex.resumeArgs("/ws", "s1", "bash", mcp),
    `codex -c shell_environment_policy.inherit=all -c 'mcp_servers.context_workspace.command="python3"' -c 'mcp_servers.context_workspace.args=["/opt/app/mcp_server/server.py"]' resume --cd '/ws' 's1'`,
  );
  // Without MCP wiring the codex command is byte-for-byte the legacy launch.
  assert.equal(codex.args("/ws", "/tmp/p.md", "bash"), `-c shell_environment_policy.inherit=all --cd '/ws' -- "$(cat '/tmp/p.md')"`);
});

test("PowerShell claude builders restore claude.exe after an interrupted auto-update", () => {
  // The npm shim (claude.ps1/.cmd) still resolves via Get-Command even when the
  // auto-updater left bin/ with only claude.exe.old.<ts>, so the launch must
  // restore the newest backup before invoking the shim. Both fresh and resume
  // paths need the repair; the other agents must not get it.
  for (const command of [
    launchPowerShellCommand("claude", "C:\\ws", null, null, "abc-123"),
    launchResumePowerShellCommand("claude", "C:\\ws", "sess-1", null),
  ]) {
    assert.match(command, /node_modules\\@anthropic-ai\\claude-code\\bin/);
    assert.match(command, /Get-ChildItem -LiteralPath \$claudeBinDir -Filter 'claude\.exe\.old\.\*'/);
    assert.match(command, /Copy-Item -LiteralPath \$claudeBackup\.FullName -Destination \$claudeExe -Force/);
  }

  // Repair is claude-only: codex/opencode launches never reference the backup.
  const codex = launchPowerShellCommand("codex", "C:\\ws", null, null);
  assert.doesNotMatch(codex, /claude\.exe\.old/);
});

test("repairClaudeBinaryPowerShell only restores when the exe is missing but a backup exists", () => {
  const snippet = repairClaudeBinaryPowerShell();
  // Guarded on a missing exe so a healthy install is left untouched.
  assert.match(snippet, /-not \(Test-Path -LiteralPath \$claudeExe\)/);
  // Picks the newest backup deterministically.
  assert.match(snippet, /Sort-Object LastWriteTime -Descending \| Select-Object -First 1/);
  // Verify the restored/current shim and fall back to another runnable install.
  assert.match(snippet, /\& \$agentCommand --version/);
  assert.match(snippet, /Get-Command claude -All/);
  assert.match(snippet, /Claude Code is installed but not runnable/);
});

test("repairClaudeBinaryPowerShell only reruns the --version probe when the install changed", () => {
  const snippet = repairClaudeBinaryPowerShell();
  // The probe result is cached per resolved command and install write times.
  assert.match(snippet, /\$claudeProbeParts = @\(\$resolvedAgent\.Path, .*LastWriteTimeUtc\.Ticks\)/);
  assert.match(snippet, /claude-launch-probe\.txt/);
  const cacheCheck = snippet.indexOf("-eq $claudeProbeKey");
  const probe = snippet.indexOf("& $agentCommand --version");
  const cacheWrite = snippet.indexOf("Set-Content -LiteralPath $claudeProbeCache");
  assert.ok(cacheCheck > 0 && cacheCheck < probe, "cache is consulted before probing");
  assert.ok(probe < cacheWrite, "only a successful probe is cached");
  assert.match(snippet, /if \(\$claudeLaunchReady -and \$claudeProbeKey\)/);
});

test("agentConfig opencode collapses prompt whitespace and quotes the path", () => {
  const opencode = agentConfig("opencode");
  assert.equal(
    opencode.args("/ws", "/tmp/p.md", "bash"),
    `--prompt "$(tr '\\r\\n' '  ' < '/tmp/p.md')" '/ws'`,
  );
});

test("agentConfig athena mirrors opencode's argument shape with the athena-code executable", () => {
  const athena = agentConfig("athena");
  assert.equal(athena.executable, "athena-code");
  assert.equal(
    athena.args("/ws", "/tmp/p.md", "bash"),
    `--prompt "$(tr '\\r\\n' '  ' < '/tmp/p.md')" '/ws'`,
  );
  assert.equal(athena.resumeArgs("/ws", "s1", "bash"), `athena-code --session 's1' '/ws'`);
});

test("agentConfig grok passes the workspace via --cwd and resumes with -r", () => {
  const grok = agentConfig("grok");
  assert.equal(grok.executable, "grok");
  assert.equal(
    grok.args("/ws", "/tmp/p.md", "bash"),
    `--cwd '/ws' "$(tr '\\r\\n' '  ' < '/tmp/p.md')"`,
  );
  assert.equal(grok.args("/ws", null, "bash"), `--cwd '/ws'`);
  assert.equal(grok.args("/ws", "/tmp/p.md", "bash", null, null, "grok-4"), `--model 'grok-4' --cwd '/ws' "$(tr '\\r\\n' '  ' < '/tmp/p.md')"`);
  assert.equal(grok.resumeArgs("/ws", "s1", "bash"), `grok --cwd '/ws' -r 's1'`);
});

test("launchCommand treats Grok as a PATH-installed agent", () => {
  const command = launchCommand("grok", "/home/dev/project", null);
  assert.match(command, /command -v 'grok'/);
  assert.match(command, /grok --cwd '\/home\/dev\/project'/);
  assert.match(command, /https:\/\/docs\.x\.ai\/build\/overview/);
});

test("missing Athena Code guidance links both platform installers", () => {
  const bash = launchCommand("athena", "/home/dev/project", null);
  const powershell = launchPowerShellCommand("athena", "C:\\ws", null);
  assert.match(bash, /athena-code\/main\/scripts\/install\.sh/);
  assert.match(powershell, /athena-code\/main\/scripts\/install\.ps1/);
});

test("PowerShell builders pass values through quotePowerShell, not raw interpolation", () => {
  const command = launchPowerShellCommand("codex", "C:\\Users\\dev\\proj", "C:\\tmp\\p.md", null);
  assert.match(command, /\$workspace = 'C:\\Users\\dev\\proj'/);
  assert.match(command, /Set-Location -LiteralPath \$workspace/);
  // Codex prompt is splatted as an array element ($prompt), never string-built.
  assert.match(command, /@\('-c', 'shell_environment_policy.inherit=all'\) \+ \$mcpConfigArgs \+ \$modelArgs \+ @\('--cd', \$workspace, '--', \$prompt\)/);
  // With no MCP wiring the spliced array is empty.
  assert.match(command, /\$mcpConfigArgs = @\(\)/);
  // With no explicit model the spliced model array is empty too.
  assert.match(command, /\$modelArgs = @\(\)/);
});

test("Windows PowerShell codex builder preserves TOML quotes through the npm shim", () => {
  const command = launchPowerShellCommand("codex", "C:\\ws", "C:\\tmp\\p.md", {
    codexConfigArgs: [`mcp_servers.context_workspace.command="python3"`],
  }, null, null, "powershell.exe");
  assert.match(command, /\$mcpConfigArgs = @\('-c', 'mcp_servers\.context_workspace\.command=\\"python3\\"'\)/);
});

test("PowerShell 7 codex builder relies on standard native argument forwarding", () => {
  const command = launchPowerShellCommand("codex", "C:\\ws", null, {
    codexConfigArgs: [`mcp_servers.context_workspace.args=["C:\\\\app\\\\server.py"]`],
  }, null, null, "pwsh.exe");
  assert.match(command, /mcp_servers\.context_workspace\.args=\["C:\\\\app\\\\server\.py"\]/);
  assert.doesNotMatch(command, /args=\[\\"/);
});

test("PowerShell builder escapes embedded double-quotes in the prompt for the native arg hop", () => {
  // Windows PowerShell 5.1 does not escape embedded double-quotes when building a native
  // command line, so npm agent shims (codex.ps1 / claude) that re-forward $args to node would
  // otherwise shatter a quote-containing prompt into multiple argv tokens (e.g. a stray
  // "hermes" subcommand). The prompt must be read with embedded `"` pre-escaped as `\"` there,
  // but not on pwsh 7.3+, which escapes them itself and would pass the agent a literal `\"`.
  for (const kind of ["codex", "claude", "opencode"]) {
    const command = launchPowerShellCommand(kind, "C:\\ws", "C:\\tmp\\p.md", null);
    assert.match(command, /\$prompt = Get-Content -LiteralPath \$promptPath -Raw -Encoding UTF8/);
    assert.match(command, /-notin @\('Standard', 'Windows'\)\) \{ \$prompt = \$prompt\.Replace\('"', '\\"'\) \}/);
  }
});

test("PowerShell builders never hand launch arguments to a batch shim when another candidate exists", () => {
  // cmd.exe cuts `%*` at the first newline, so a Scoop shims\claude.cmd ahead of npm's
  // claude.ps1 on PATH delivered only "# Athena Task".
  for (const command of [
    launchPowerShellCommand("claude", "C:\\ws", "C:\\tmp\\p.md", null),
    launchPowerShellCommand("codex", "C:\\ws", "C:\\tmp\\p.md", null),
    launchResumePowerShellCommand("claude", "C:\\ws", "sess-1", null),
  ]) {
    assert.match(command, /Get-Command \$agentCommand -All .*\\\.\(exe\|ps1\)\$/);
    // The batch check must run before the per-agent repair, which reads $resolvedAgent.Path.
    assert.ok(command.indexOf("$nonBatchAgent") < command.indexOf("$agentArgs"));
  }
  const claude = launchPowerShellCommand("claude", "C:\\ws", "C:\\tmp\\p.md", null);
  assert.ok(claude.indexOf("$nonBatchAgent") < claude.indexOf("$claudeBinDirs"));
  // Only a batch shim left: pass the prompt file path, never the multi-line prompt.
  assert.match(claude, /Read the Athena task file at \$promptPath and follow it\./);
  assert.ok(claude.indexOf("Read the Athena task file") < claude.indexOf("$prompt.Replace"));
  assert.doesNotMatch(launchPowerShellCommand("claude", "C:\\ws", null, null), /Read the Athena task file/);
});

const windowsShells = process.platform === "win32" ? resolveWindowsShells() : [];

function resolveWindowsShells() {
  return ["pwsh.exe", "powershell.exe"].flatMap((name) => {
    try {
      const found = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();
      return found ? [{ name, path: found }] : [];
    } catch {
      return [];
    }
  });
}

// Runs the real Windows launch script against fake agent shims and returns the argv each
// agent invocation received. `shims` maps a PATH directory name to the shim files in it.
function runWindowsAgentLaunch(shell, kind, prompt, shims) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-launch-"));
  try {
    const log = path.join(root, "argv.jsonl");
    const agent = path.join(root, "agent.cjs");
    fs.writeFileSync(agent, [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('1.0.0'); process.exit(0); }",
      "fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ shim: process.env.FAKE_AGENT_SHIM, args }) + '\\n');",
    ].join("\n"));
    const pathDirs = [];
    for (const [dirName, files] of Object.entries(shims)) {
      const dir = path.join(root, dirName);
      fs.mkdirSync(dir);
      pathDirs.push(dir);
      for (const file of files) {
        const shimName = `${dirName}/${path.extname(file).slice(1)}`;
        const body = file.endsWith(".ps1")
          // npm's .ps1 shim shape: re-forward $args to a native executable.
          ? `$env:FAKE_AGENT_SHIM = '${shimName}'\r\n& "${process.execPath}" "${agent}" $args\r\nexit $LASTEXITCODE\r\n`
          : `@echo off\r\nset FAKE_AGENT_SHIM=${shimName}\r\n"${process.execPath}" "${agent}" %*\r\n`;
        fs.writeFileSync(path.join(dir, file), body);
      }
    }
    const promptPath = path.join(root, "prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const output = execFileSync(shell.path, [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      launchPowerShellCommand(kind, workspace, promptPath, { configPath: path.join(root, "mcp.json") }, kind === "claude" ? "sess-1" : null, null, shell.name),
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
      env: {
        ...process.env,
        // Only the fake shims resolve; USERPROFILE moves $HOME so Claude's launch probe cache stays in the sandbox.
        PATH: [...pathDirs, path.join(systemRoot, "System32"), systemRoot].join(";"),
        USERPROFILE: root,
        FAKE_AGENT_LOG: log,
      },
    });
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { calls, output, promptPath };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NASTY_PROMPT = [
  "# Athena Task",
  "Workspace: C:\\Users\\dev\\project",
  'Task: fix "quoted" bugs & keep 100% of %PATH% ^ intact | <ok> café — naïve',
  'JSON: `{ "project_dir": "<workspace>", "question": "<question>" }`',
  "",
  "Last line.",
].join("\n");

for (const shell of windowsShells) {
  test(`${shell.name} launch delivers the full multi-line task past a batch shim ahead on PATH`, { timeout: 120000 }, () => {
    // Scoop's shims\claude.cmd sits ahead of npm's claude.ps1 + claude.cmd.
    const { calls } = runWindowsAgentLaunch(shell, "claude", NASTY_PROMPT, {
      scoop: ["claude.cmd"],
      npm: ["claude.ps1", "claude.cmd"],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].shim, "npm/ps1");
    const [sessionFlag, sessionId, mcpFlag, mcpPath, separator, prompt, ...extra] = calls[0].args;
    assert.deepEqual([sessionFlag, sessionId, mcpFlag, separator], ["--session-id", "sess-1", "--mcp-config", "--"]);
    assert.match(mcpPath, /mcp\.json$/);
    assert.equal(prompt, NASTY_PROMPT);
    assert.deepEqual(extra, []);

    const codex = runWindowsAgentLaunch(shell, "codex", NASTY_PROMPT, { scoop: ["codex.cmd"], npm: ["codex.ps1", "codex.cmd"] });
    assert.equal(codex.calls.length, 1);
    assert.equal(codex.calls[0].shim, "npm/ps1");
    assert.equal(codex.calls[0].args.at(-1), NASTY_PROMPT);
  });

  test(`${shell.name} launch passes the task file path when only a batch shim can run the agent`, { timeout: 120000 }, () => {
    const { calls, promptPath } = runWindowsAgentLaunch(shell, "claude", NASTY_PROMPT, { scoop: ["claude.cmd"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].shim, "scoop/cmd");
    assert.equal(calls[0].args.at(-1), `Read the Athena task file at ${promptPath} and follow it.`);
  });
}

test("PowerShell resume builder quotes the session id", () => {
  const command = launchResumePowerShellCommand("claude", "C:\\ws", "sess'9", null);
  // quotePowerShell doubles single quotes: ' -> ''
  assert.match(command, /\$sessionId = 'sess''9'/);
});

test("PowerShell codex panes use npm's machine-wide install, never a private prefix", () => {
  // Setting NPM_CONFIG_PREFIX in Codex panes sent Codex's self-updates (npm install -g) to ~/.npm-global, so the
  // copy Athena ran and the one every other terminal ran drifted apart.
  for (const command of [
    launchPowerShellCommand("codex", "C:\\ws", null, null),
    launchResumePowerShellCommand("codex", "C:\\ws", "abc123"),
  ]) {
    assert.doesNotMatch(command, /NPM_CONFIG_PREFIX|\.npm-global/);
  }
});

test("PowerShell missing-agent guidance gives the Windows install command for every agent", () => {
  assert.match(launchPowerShellCommand("claude", "C:\\ws", null, null), /npm install -g @anthropic-ai\/claude-code@latest/);
  assert.match(launchPowerShellCommand("opencode", "C:\\ws", null, null), /npm install -g opencode-ai@latest/);
  assert.match(launchHermesPowerShellCommand("C:\\ws"), /hermes-agent\.nousresearch\.com\/install\.ps1/);
});

test("agentConfig args omit --model unless a model is explicitly requested", () => {
  // The default (no model) launch must be byte-for-byte the legacy command so
  // unspecified spawns keep using each agent CLI's own default model.
  assert.equal(agentConfig("codex").args("/ws", null, "bash"), `-c shell_environment_policy.inherit=all --cd '/ws'`);
  assert.equal(agentConfig("claude").args("/ws", null, "bash"), "");
  assert.equal(agentConfig("opencode").args("/ws", "/tmp/p.md", "bash"), `--prompt "$(tr '\\r\\n' '  ' < '/tmp/p.md')" '/ws'`);
});

test("agentConfig threads an explicit model through as a quoted --model flag", () => {
  // claude/codex take a bare model id; opencode/athena take provider/model.
  assert.equal(
    agentConfig("claude").args("/ws", "/tmp/p.md", "bash", null, null, "opus"),
    `--model 'opus' "$(cat '/tmp/p.md')"`,
  );
  assert.equal(
    agentConfig("codex").args("/ws", null, "bash", null, null, "gpt-5-codex"),
    `-c shell_environment_policy.inherit=all --model 'gpt-5-codex' --cd '/ws'`,
  );
  assert.equal(
    agentConfig("opencode").args("/ws", "/tmp/p.md", "bash", null, null, "anthropic/claude-opus-4-8"),
    `--model 'anthropic/claude-opus-4-8' --prompt "$(tr '\\r\\n' '  ' < '/tmp/p.md')" '/ws'`,
  );
  assert.equal(
    agentConfig("athena").args("/ws", null, "bash", null, null, "anthropic/claude-opus-4-8"),
    `--model 'anthropic/claude-opus-4-8' '/ws'`,
  );
});

test("launchCommand quote-escapes a hostile model value", () => {
  const command = launchCommand("claude", "/home/dev/project", null, null, null, INJECTION);
  assert.ok(command.includes(`--model ${quoteShell(INJECTION)}`));
});

test("PowerShell builders splice an explicit model array, empty by default", () => {
  const codex = launchPowerShellCommand("codex", "C:\\ws", "C:\\tmp\\p.md", null, null, "gpt-5-codex");
  assert.match(codex, /\$modelArgs = @\('--model', 'gpt-5-codex'\)/);
  assert.match(codex, /\$mcpConfigArgs \+ \$modelArgs \+ @\('--cd', \$workspace, '--', \$prompt\)/);

  const claude = launchPowerShellCommand("claude", "C:\\ws", null, null, null, "opus");
  assert.match(claude, /\$modelArgs = @\('--model', 'opus'\)/);
  assert.match(claude, /\$agentArgs = @\(\) \+ \$modelArgs/);

  const opencode = launchPowerShellCommand("opencode", "C:\\ws", null);
  assert.match(opencode, /\$modelArgs = @\(\)/);
  assert.match(opencode, /\$agentArgs = \$modelArgs \+ @\(\$workspace\)/);
});

test("Hermes PowerShell builder launches native hermes without WSL", () => {
  const resume = launchHermesPowerShellCommand("C:\\ws", "h-1");
  // The native Windows Hermes build is invoked directly; no WSL bridge remains.
  assert.doesNotMatch(resume, /wsl/i);
  assert.match(resume, /\$workspace = 'C:\\ws'/);
  assert.match(resume, /Set-Location -LiteralPath \$workspace/);
  assert.match(resume, /Get-Command hermes -ErrorAction SilentlyContinue/);
  assert.match(resume, /& hermes --resume \$sessionId/);
  assert.match(resume, /\$sessionId = 'h-1'/);

  const fresh = launchHermesPowerShellCommand("C:\\ws");
  assert.doesNotMatch(fresh, /wsl/i);
  assert.doesNotMatch(fresh, /--resume/);
  assert.match(fresh, /& hermes$/);
});
