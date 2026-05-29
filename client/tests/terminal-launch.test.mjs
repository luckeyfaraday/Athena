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

test("terminalLaunch uses bash -lc on non-Windows platforms", () => {
  const launch = terminalLaunch("codex", "/home/dev/project", "/tmp/prompt.md");
  // On the Linux test runner this is the bash branch.
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
  assert.match(command, /command -v 'codex'/);
  assert.match(command, /codex --cd '\/home\/dev\/project' -- "\$\(cat '\/tmp\/prompt.md'\)"/);
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
  assert.match(codex, /codex resume --cd '\/home\/dev\/project' 'abc-1'/);
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
  assert.equal(codex.args("/ws", "/tmp/p.md", "bash"), `--cd '/ws' -- "$(cat '/tmp/p.md')"`);
  assert.equal(codex.args("/ws", null, "bash"), `--cd '/ws'`);
});

test("agentConfig claude args include the mcp config flag and quote the prompt path", () => {
  const claude = agentConfig("claude");
  assert.equal(
    claude.args("/ws", "/tmp/p.md", "bash", "/tmp/mcp.json"),
    `--mcp-config '/tmp/mcp.json' "$(cat '/tmp/p.md')"`,
  );
  assert.equal(claude.resumeArgs("/ws", "s1", "bash", "/tmp/mcp.json"), `claude --mcp-config '/tmp/mcp.json' --resume 's1'`);
});

test("agentConfig opencode collapses prompt whitespace and quotes the path", () => {
  const opencode = agentConfig("opencode");
  assert.equal(
    opencode.args("/ws", "/tmp/p.md", "bash"),
    `--prompt "$(tr '\\r\\n' '  ' < '/tmp/p.md')" '/ws'`,
  );
});

test("PowerShell builders pass values through quotePowerShell, not raw interpolation", () => {
  const command = launchPowerShellCommand("codex", "C:\\Users\\dev\\proj", "C:\\tmp\\p.md", null);
  assert.match(command, /\$workspace = 'C:\\Users\\dev\\proj'/);
  assert.match(command, /Set-Location -LiteralPath \$workspace/);
  // Codex prompt is splatted as an array element ($prompt), never string-built.
  assert.match(command, /@\('--cd', \$workspace, '--', \$prompt\)/);
});

test("PowerShell resume builder quotes the session id", () => {
  const command = launchResumePowerShellCommand("claude", "C:\\ws", "sess'9", null);
  // quotePowerShell doubles single quotes: ' -> ''
  assert.match(command, /\$sessionId = 'sess''9'/);
});

test("Hermes PowerShell builder prefers wsl then native hermes", () => {
  const command = launchHermesPowerShellCommand("C:\\ws", "h-1");
  assert.match(command, /Get-Command wsl\.exe/);
  assert.match(command, /hermes --resume \$sessionId/);
  assert.match(command, /\$sessionId = 'h-1'/);
});
