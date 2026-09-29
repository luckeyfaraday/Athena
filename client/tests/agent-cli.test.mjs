import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_CLIS,
  agentCliStatus,
  agentCommand,
  agentSetupLaunch,
  agentUpdateCommand,
  isAgentCliKind,
  missingAgentMessage,
  privateAgentCopies,
  resolveExecutable,
  setupScriptLaunch,
} from "../dist-electron/agent-cli.js";

const isWindows = process.platform === "win32";

// A folder with fake commands, and an environment whose PATH is only that folder plus the system tools.
function fakeBin(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-agent-bin-"));
  for (const name of names) {
    if (isWindows) fs.writeFileSync(path.join(dir, `${name}.cmd`), "@echo off\r\n");
    else fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  const system = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
  return { dir, env: { ...process.env, PATH: [dir, system].join(path.delimiter), Path: undefined } };
}

test("every agent Athena launches has install and update commands for both platforms", () => {
  for (const kind of ["claude", "codex", "opencode", "hermes", "grok", "athena"]) {
    assert.ok(isAgentCliKind(kind), kind);
    for (const platform of ["win32", "linux"]) {
      assert.ok(agentCommand(kind, "install", platform).length > 0);
      assert.ok(agentCommand(kind, "update", platform).length > 0);
    }
  }
  assert.equal(isAgentCliKind("shell"), false);
  assert.equal(isAgentCliKind("toString"), false);
});

test("npm agents install and update machine-wide with npm install -g", () => {
  assert.equal(agentCommand("claude", "install", "win32"), "npm install -g @anthropic-ai/claude-code@latest");
  assert.equal(agentCommand("codex", "update", "linux"), "npm install -g @openai/codex@latest");
  assert.equal(agentCommand("opencode", "install", "darwin"), "npm install -g opencode-ai@latest");
  for (const spec of Object.values(AGENT_CLIS)) {
    for (const platform of ["win32", "linux"]) {
      assert.doesNotMatch(agentCommand(spec.kind, "install", platform), /--prefix|\.npm-global/);
    }
  }
});

test("installer agents use the vendor installer for the platform", () => {
  assert.match(agentCommand("grok", "install", "win32"), /irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex/);
  assert.match(agentCommand("grok", "install", "linux"), /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
  assert.match(agentCommand("athena", "install", "win32"), /athena-code\/main\/scripts\/install\.ps1/);
  assert.match(agentCommand("hermes", "install", "linux"), /hermes-agent\/main\/scripts\/install\.sh/);
});

test("the missing-agent message names the agent, its install command and its docs", () => {
  const message = missingAgentMessage("grok", "grok", "linux");
  assert.match(message, /^Grok \(grok\) is not installed or not on PATH\./);
  assert.match(message, /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
  assert.match(message, /https:\/\/docs\.x\.ai\/build\/overview/);
  assert.equal(missingAgentMessage("shell", "bash"), "bash is not installed or not on PATH.");
});

test("resolveExecutable finds a command the way the panes do, and reports a missing one", async () => {
  const { dir, env } = fakeBin(["athena-fake-agent"]);
  const found = await resolveExecutable("athena-fake-agent", env);
  assert.ok(found, "the fake command should be found");
  // compare the unique folder name: Windows may report the temp folder by its long or its 8.3 short name
  assert.equal(path.basename(path.dirname(found)), path.basename(dir));
  assert.equal(await resolveExecutable("athena-no-such-agent", env), null);
});

test("agentCliStatus reports installed, where, and whether npm is there for npm agents", async () => {
  const { dir, env } = fakeBin(["codex", "npm"]);
  const codex = await agentCliStatus("codex", env);
  assert.equal(codex.installed, true);
  assert.equal(path.basename(path.dirname(codex.path)), path.basename(dir));
  assert.equal(codex.needsNpm, true);
  assert.equal(codex.npmAvailable, true);
  const claude = await agentCliStatus("claude", env);
  assert.equal(claude.installed, false);
  assert.equal(claude.path, null);
  assert.equal(claude.installCommand, agentCommand("claude", "install"));
  const { env: bare } = fakeBin([]);
  assert.equal((await agentCliStatus("opencode", bare)).npmAvailable, false);
  assert.equal((await agentCliStatus("grok", bare)).npmAvailable, true, "installer agents do not need npm");
});

test("privateAgentCopies reports agent packages an older Athena left in ~/.npm-global", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "athena-home-"));
  const modules = path.join(home, ".npm-global", "node_modules");
  fs.mkdirSync(path.join(modules, "@openai", "codex"), { recursive: true });
  fs.mkdirSync(path.join(modules, "@anthropic-ai", "claude-code"), { recursive: true });
  fs.mkdirSync(path.join(modules, "left-pad"), { recursive: true });

  const copies = privateAgentCopies(home, "C:\\Users\\you\\AppData\\Roaming\\npm", "win32");
  assert.deepEqual(copies.kinds.sort(), ["claude", "codex"]);
  assert.deepEqual(copies.packages.sort(), ["@anthropic-ai/claude-code", "@openai/codex"]);
  assert.match(copies.command, /^npm uninstall -g --prefix ".*\.npm-global" /);
  // a prefix the user chose as npm's real one is theirs, not Athena's
  assert.equal(privateAgentCopies(home, path.join(home, ".npm-global"), "win32"), null);
  // Linux and macOS keep global packages under lib/node_modules
  assert.equal(privateAgentCopies(home, null, "linux"), null);
  fs.mkdirSync(path.join(home, ".npm-global", "lib", "node_modules", "opencode-ai"), { recursive: true });
  assert.deepEqual(privateAgentCopies(home, null, "linux").kinds, ["opencode"]);
  assert.equal(privateAgentCopies(fs.mkdtempSync(path.join(os.tmpdir(), "athena-home-")), null, "win32"), null);
});

test("updates go to the copy that runs: npm for npm's copy, the CLI's own updater otherwise", () => {
  const prefix = "C:\\Users\\you\\AppData\\Roaming\\npm";
  assert.equal(agentUpdateCommand("claude", `${prefix}\\claude.cmd`, prefix, "win32"), "npm install -g @anthropic-ai/claude-code@latest");
  assert.equal(agentUpdateCommand("claude", "C:\\Users\\you\\.local\\bin\\claude.exe", prefix, "win32"), "claude update");
  assert.equal(agentUpdateCommand("opencode", "C:\\Users\\you\\scoop\\shims\\opencode.exe", prefix, "win32"), "opencode upgrade");
  // no updater of its own: npm; not installed yet: npm; installer agents: their installer
  assert.equal(agentUpdateCommand("codex", "C:\\somewhere\\codex.exe", prefix, "win32"), "npm install -g @openai/codex@latest");
  assert.equal(agentUpdateCommand("claude", null, prefix, "win32"), "npm install -g @anthropic-ai/claude-code@latest");
  assert.match(agentUpdateCommand("grok", "C:\\Users\\you\\.grok\\bin\\grok.exe", prefix, "win32"), /install\.ps1/);
});

test("where.exe lookups also find .ps1 scripts, as PowerShell's Get-Command does", { skip: !isWindows && "Windows only" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-agent-ps1-"));
  fs.writeFileSync(path.join(dir, "athena-ps1-agent.ps1"), "Write-Output hi\r\n");
  const env = { ...process.env, PATH: [dir, path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";"), Path: undefined };
  const found = await resolveExecutable("athena-ps1-agent", env);
  assert.ok(found && found.toLowerCase().endsWith(".ps1"), String(found));
});

test("setup panes run the registry's command and exit with its status", () => {
  const win = agentSetupLaunch("codex", "install", "C:\\ws", "win32", "pwsh.exe");
  assert.equal(win.command, "pwsh.exe");
  assert.equal(win.title, "Installing Codex");
  assert.equal(win.args.includes("-NoExit"), false, "the pane has to exit so the UI sees the result");
  const winScript = win.args.at(-1);
  assert.match(winScript, /npm install -g @openai\/codex@latest/);
  assert.match(winScript, /exit \$LASTEXITCODE/);
  const posix = agentSetupLaunch("grok", "update", "/home/you/ws", "linux");
  assert.equal(posix.command, "bash");
  assert.equal(posix.title, "Updating Grok");
  assert.match(posix.args[1], /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash; status=\$\?/);
  assert.match(posix.args[1], /exit \$status$/);
});

test("a setup pane's shell really exits with the command's status", { skip: !isWindows && "PowerShell runs on Windows" }, () => {
  const run = (script) => {
    const launch = setupScriptLaunch("Test", script, os.tmpdir(), "win32", "powershell.exe");
    return spawnSync(launch.command, launch.args, { encoding: "utf8", windowsHide: true }).status;
  };
  assert.equal(run("cmd /c exit 3"), 3);
  assert.equal(run("Write-Output ok"), 0);
  assert.equal(run("throw 'boom'"), 1);
});

test("a setup pane's bash exits with the command's status", { skip: isWindows && "bash builder runs on Linux and macOS" }, () => {
  const run = (script) => {
    const launch = setupScriptLaunch("Test", script, os.tmpdir(), "linux");
    return spawnSync(launch.command, launch.args, { encoding: "utf8" }).status;
  };
  assert.equal(run("sh -c 'exit 3'"), 3);
  assert.equal(run("true"), 0);
});
