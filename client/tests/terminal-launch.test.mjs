import assert from "node:assert/strict";
import test from "node:test";

import {
  agentConfig,
  launchCommand,
  launchHermesPowerShellCommand,
  launchPowerShellCommand,
  launchResumeCommand,
  launchResumePowerShellCommand,
  terminalLaunch,
} from "../dist-electron/terminal-launch.js";
import { quoteShell } from "../dist-electron/platform.js";

// quoteShell wraps a value in single quotes and escapes embedded single quotes
// as '\'' . A dangerous payload must therefore never appear unescaped.
const INJECTION = "'; rm -rf ~; echo '";

test("terminalLaunch uses the platform launch shell", () => {
  const launch = terminalLaunch("codex", "/home/dev/project", "/tmp/prompt.md");
  if (process.platform === "win32") {
    assert.equal(launch.command, "powershell.exe");
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
  assert.match(command, /NPM_CONFIG_PREFIX/);
  assert.match(command, /unset npm_config_prefix NPM_CONFIG_PREFIX npm_config_globalconfig NPM_CONFIG_GLOBALCONFIG/);
  assert.match(command, /unset NPM_CONFIG_PREFIX; exec bash -l/);
  assert.match(command, /command -v 'codex'/);
  assert.match(command, /codex -c shell_environment_policy.inherit=all --cd '\/home\/dev\/project' -- "\$\(cat '\/tmp\/prompt.md'\)"/);
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
  assert.match(codex, /NPM_CONFIG_PREFIX/);
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
});

test("PowerShell builders pass values through quotePowerShell, not raw interpolation", () => {
  const command = launchPowerShellCommand("codex", "C:\\Users\\dev\\proj", "C:\\tmp\\p.md", null);
  assert.match(command, /\$workspace = 'C:\\Users\\dev\\proj'/);
  assert.match(command, /\$env:NPM_CONFIG_PREFIX/);
  assert.match(command, /Set-Location -LiteralPath \$workspace/);
  // Codex prompt is splatted as an array element ($prompt), never string-built.
  assert.match(command, /@\('-c', 'shell_environment_policy.inherit=all'\) \+ \$mcpConfigArgs \+ \$modelArgs \+ @\('--cd', \$workspace, '--', \$prompt\)/);
  // With no MCP wiring the spliced array is empty.
  assert.match(command, /\$mcpConfigArgs = @\(\)/);
  // With no explicit model the spliced model array is empty too.
  assert.match(command, /\$modelArgs = @\(\)/);
});

test("PowerShell codex builder splats MCP -c overrides through a quoted array", () => {
  const command = launchPowerShellCommand("codex", "C:\\ws", "C:\\tmp\\p.md", {
    codexConfigArgs: [`mcp_servers.context_workspace.command="python3"`],
  });
  // quotePowerShell wraps in single quotes; embedded double quotes stay literal.
  assert.match(command, /\$mcpConfigArgs = @\('-c', 'mcp_servers.context_workspace.command="python3"'\)/);
});

test("PowerShell builder escapes embedded double-quotes in the prompt for the native arg hop", () => {
  // Windows PowerShell 5.1 does not escape embedded double-quotes when building a native
  // command line, so npm agent shims (codex.ps1 / claude) that re-forward $args to node would
  // otherwise shatter a quote-containing prompt into multiple argv tokens (e.g. a stray
  // "hermes" subcommand). The prompt must be read with embedded `"` pre-escaped as `\"`.
  for (const kind of ["codex", "claude", "opencode"]) {
    const command = launchPowerShellCommand(kind, "C:\\ws", "C:\\tmp\\p.md", null);
    assert.match(command, /\$prompt = \(Get-Content -LiteralPath \$promptPath -Raw\)\.Replace\('"', '\\"'\)/);
  }
});

test("PowerShell resume builder quotes the session id", () => {
  const command = launchResumePowerShellCommand("claude", "C:\\ws", "sess'9", null);
  // quotePowerShell doubles single quotes: ' -> ''
  assert.match(command, /\$sessionId = 'sess''9'/);
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
