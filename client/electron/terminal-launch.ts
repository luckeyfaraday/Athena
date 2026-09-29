// Command construction for embedded terminals.
//
// This module owns how an EmbeddedTerminalKind is turned into a concrete
// `{ command, args }` PTY launch, including the per-agent bash and PowerShell
// command strings. It is intentionally free of PTY/session state so the
// security-sensitive command assembly can be unit tested in isolation.
//
// Quoting note: user/workspace-derived values are passed through
// `quoteShell`/`quotePowerShell`, and prompt-file contents are inlined via
// double-quoted `"$(cat ...)"` command substitution. Bash does not re-evaluate
// command-substitution output, so prompt contents cannot inject commands, and
// PowerShell receives prompts as splatted array elements rather than via string
// interpolation.

import type { AgentMcpLaunch } from "./agent-mcp.js";
import { missingAgentMessage } from "./agent-cli.js";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
import {
  defaultShell,
  isWindows,
  nvmLoadBashCommand,
  preferredWindowsPowerShell,
  quotePowerShell,
  quoteShell,
} from "./platform.js";

export type AgentConfig = {
  label: string;
  executable: string;
  powerShellCommand: string;
  powerShellCommandWithoutPrompt: string;
  resumePowerShellCommand: string;
  args: (cwd: string, promptPath: string | null, shell: "bash", mcp?: AgentMcpLaunch | null, newSessionId?: string | null, model?: string | null) => string;
  resumeArgs: (cwd: string, sessionId: string, shell: "bash", mcp?: AgentMcpLaunch | null) => string;
};

// Bash: render an explicit model selection as ` --model <model>` (leading space
// so callers can append directly). Empty when no model is requested. The value
// is quoted because it originates from a user request. Every supported agent CLI
// (claude, codex, opencode, athena) accepts the same `--model` flag shape.
function modelBashArg(model?: string | null): string {
  return model ? ` --model ${quoteShell(model)}` : "";
}

// Bash: render Codex's MCP overrides as ` -c '<override>'` tokens (leading space
// so the caller can append directly). Empty when no overrides are present.
function codexMcpBashArgs(mcp?: AgentMcpLaunch | null): string {
  const overrides = mcp?.codexConfigArgs;
  if (!overrides || overrides.length === 0) return "";
  return overrides.map((override) => ` -c ${quoteShell(override)}`).join("");
}

// PowerShell: render Codex's MCP overrides as the inside of an `@(...)` array,
// e.g. `'-c', '<override>'`. Empty string yields `@()`.
function codexMcpPowerShellArray(
  mcp?: AgentMcpLaunch | null,
  powerShellExecutable: "pwsh.exe" | "powershell.exe" = preferredWindowsPowerShell(),
): string {
  const overrides = mcp?.codexConfigArgs;
  if (!overrides || overrides.length === 0) return "";
  // Windows PowerShell 5.1 loses embedded quotes while forwarding arguments
  // through npm's .ps1 shim to a native executable. PowerShell 7 preserves
  // them, so only pre-escape the legacy path.
  const escapeNativeQuotes = powerShellExecutable.toLowerCase() === "powershell.exe";
  return overrides
    .flatMap((override) => ["'-c'", quotePowerShell(escapeNativeQuotes ? override.replaceAll('"', '\\"') : override)])
    .join(", ");
}

export function terminalLaunch(
  kind: EmbeddedTerminalKind,
  cwd: string,
  promptPath: string | null,
  resumeSessionId?: string,
  mcp?: AgentMcpLaunch | null,
  newSessionId?: string | null,
  model?: string | null,
): { command: string; args: string[] } {
  if (isWindows) {
    const shell = preferredWindowsPowerShell();
    if (kind === "hermes" && resumeSessionId) {
      return {
        command: shell,
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd, resumeSessionId)],
      };
    }
    if (kind === "hermes") {
      return {
        command: shell,
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd)],
      };
    }
    if (kind !== "shell" && resumeSessionId) {
      return {
        command: shell,
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchResumePowerShellCommand(kind, cwd, resumeSessionId, mcp, shell)],
      };
    }
    if (kind !== "shell") {
      return {
        command: shell,
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchPowerShellCommand(kind, cwd, promptPath, mcp, newSessionId, model, shell)],
      };
    }
    return defaultShell();
  }

  return { command: "bash", args: ["-lc", resumeSessionId ? launchResumeCommand(kind, cwd, resumeSessionId, mcp) : launchCommand(kind, cwd, promptPath, mcp, newSessionId, model)] };
}

export function launchCommand(
  kind: EmbeddedTerminalKind,
  cwd: string,
  promptPath: string | null,
  mcp?: AgentMcpLaunch | null,
  newSessionId?: string | null,
  model?: string | null,
): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      nvmLoadBashCommand(),
      "printf '\\033[36m[Context Workspace] Hermes ready.\\033[0m\\n'",
      `if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31m%s\\033[0m\\n' ${quoteShell(missingAgentMessage("hermes", "hermes", "linux"))}; exec bash -l; fi`,
      "hermes",
      "exec bash -l",
    ].join("; ");
  }

  if (kind !== "shell") {
    const agent = agentConfig(kind);
    return [
      `cd ${quoteShell(cwd)}`,
      nvmLoadBashCommand(),
      promptPath
        ? `printf '\\033[36m[Context Workspace] %s Athena context: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(promptPath)}`
        : `printf '\\033[36m[Context Workspace] Launching %s\\033[0m\\n' ${quoteShell(agent.label)}`,
      `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s\\033[0m\\n' ${quoteShell(missingAgentMessage(kind, agent.executable, "linux"))}; exec bash -l; fi`,
      `${agent.executable} ${agent.args(cwd, promptPath, "bash", mcp, newSessionId, model)}`.trimEnd(),
      "exec bash -l",
    ].filter(Boolean).join("; ");
  }

  return [
    `cd ${quoteShell(cwd)}`,
    "printf '\\033[36m[Context Workspace] Embedded shell ready. Launch Codex with Hermes from the Command Room when needed.\\033[0m\\n'",
    "exec bash -l",
  ].join("; ");
}

export function launchHermesPowerShellCommand(cwd: string, resumeSessionId?: string): string {
  // Hermes now ships a native Windows build, so the embedded terminal launches
  // `hermes` directly from the workspace just like the other agents. The legacy
  // WSL bridge (`wsl.exe -e sh -lc 'cd ... && hermes'`) is no longer used.
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    resumeSessionId ? `$sessionId = ${quotePowerShell(resumeSessionId)}` : "",
    "Set-Location -LiteralPath $workspace",
    resumeSessionId
      ? "Write-Host \"[Context Workspace] Resuming Hermes session: $sessionId\" -ForegroundColor Cyan"
      : "Write-Host \"[Context Workspace] Hermes ready.\" -ForegroundColor Cyan",
    "$resolvedHermes = Get-Command hermes -ErrorAction SilentlyContinue",
    `if (-not $resolvedHermes) { Write-Host ${quotePowerShell(missingAgentMessage("hermes", "hermes", "win32"))} -ForegroundColor Red; return }`,
    resumeSessionId ? "& hermes --resume $sessionId" : "& hermes",
  ].filter(Boolean).join("; ");
}

export function launchResumeCommand(kind: EmbeddedTerminalKind, cwd: string, resumeSessionId: string, mcp?: AgentMcpLaunch | null): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      nvmLoadBashCommand(),
      `printf '\\033[36m[Context Workspace] Resuming Hermes session: %s\\033[0m\\n' ${quoteShell(resumeSessionId)}`,
      `if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31m%s\\033[0m\\n' ${quoteShell(missingAgentMessage("hermes", "hermes", "linux"))}; exec bash -l; fi`,
      `hermes --resume ${quoteShell(resumeSessionId)}`,
      "exec bash -l",
    ].join("; ");
  }
  const agent = agentConfig(kind);
  return [
    `cd ${quoteShell(cwd)}`,
    nvmLoadBashCommand(),
    `printf '\\033[36m[Context Workspace] Resuming %s session: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(resumeSessionId)}`,
    `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s\\033[0m\\n' ${quoteShell(missingAgentMessage(kind, agent.executable, "linux"))}; exec bash -l; fi`,
    agent.resumeArgs(cwd, resumeSessionId, "bash", mcp),
    "exec bash -l",
  ].filter(Boolean).join("; ");
}

export function launchResumePowerShellCommand(
  kind: EmbeddedTerminalKind,
  cwd: string,
  resumeSessionId: string,
  mcp?: AgentMcpLaunch | null,
  powerShellExecutable: "pwsh.exe" | "powershell.exe" = preferredWindowsPowerShell(),
): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    `$sessionId = ${quotePowerShell(resumeSessionId)}`,
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcp?.configPath ? `$mcpConfigPath = ${quotePowerShell(mcp.configPath)}` : "",
    kind === "codex" ? `$mcpConfigArgs = @(${codexMcpPowerShellArray(mcp, powerShellExecutable)})` : "",
    "Set-Location -LiteralPath $workspace",
    "Write-Host \"[Context Workspace] Resuming $agentLabel session: $sessionId\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    `if (-not $resolvedAgent) { Write-Host ${quotePowerShell(missingAgentMessage(kind, agent.executable, "win32"))} -ForegroundColor Red; return }`,
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    ...(kind === "claude" ? [repairClaudeBinaryPowerShell()] : []),
    agent.resumePowerShellCommand,
  ].filter(Boolean).join("; ");
}

export function launchPowerShellCommand(
  kind: EmbeddedTerminalKind,
  cwd: string,
  promptPath: string | null,
  mcp?: AgentMcpLaunch | null,
  newSessionId?: string | null,
  model?: string | null,
  powerShellExecutable: "pwsh.exe" | "powershell.exe" = preferredWindowsPowerShell(),
): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    promptPath ? `$promptPath = ${quotePowerShell(promptPath)}` : "",
    "Set-Location -LiteralPath $workspace",
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcp?.configPath ? `$mcpConfigPath = ${quotePowerShell(mcp.configPath)}` : "",
    kind === "codex" ? `$mcpConfigArgs = @(${codexMcpPowerShellArray(mcp, powerShellExecutable)})` : "",
    // $modelArgs is spliced into every agent's argument array; @() when no model
    // was explicitly requested, so the agent CLI keeps its own default.
    model ? `$modelArgs = @('--model', ${quotePowerShell(model)})` : "$modelArgs = @()",
    newSessionId ? `$newSessionId = ${quotePowerShell(newSessionId)}` : "",
    promptPath
      ? "Write-Host \"[Context Workspace] $agentLabel Athena context: $promptPath\" -ForegroundColor Cyan"
      : "Write-Host \"[Context Workspace] Launching $agentLabel\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    `if (-not $resolvedAgent) { Write-Host ${quotePowerShell(missingAgentMessage(kind, agent.executable, "win32"))} -ForegroundColor Red; return }`,
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    ...(kind === "claude" ? [repairClaudeBinaryPowerShell()] : []),
    // Windows PowerShell 5.1 wraps space-containing native args in quotes but does NOT escape
    // embedded double-quotes, so a multi-line prompt containing `"` (e.g. JSON examples) gets
    // shattered into multiple argv tokens when agent launchers (codex.ps1 / claude npm shims)
    // re-forward $args to node. Pre-escaping `"` as `\"` makes CommandLineToArgvW treat them as
    // literal quotes inside a single argument. See agentConfig powerShellCommand.
    promptPath ? "$prompt = (Get-Content -LiteralPath $promptPath -Raw).Replace('\"', '\\\"')" : "",
    promptPath ? agent.powerShellCommand : agent.powerShellCommandWithoutPrompt,
  ].filter(Boolean).join("; ");
}

export function agentConfig(kind: EmbeddedTerminalKind): AgentConfig {
  if (kind === "grok") {
    // xAI's Grok Build CLI: the interactive TUI takes a positional initial prompt
    // and `--cwd <dir>` for the working directory, and resumes a saved session with
    // `-r <id>`. It accepts the shared `--model` flag, so $modelArgs is reused.
    return {
      label: "Grok",
      executable: "grok",
      powerShellCommand: "$agentPrompt = (($prompt -replace '[\\r\\n]+', ' ') -replace '\\s{2,}', ' ').Trim(); $agentArgs = $modelArgs + @('--cwd', $workspace, $agentPrompt); & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = $modelArgs + @('--cwd', $workspace); & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @('--cwd', $workspace, '-r', $sessionId); & $agentCommand @agentArgs",
      args: (cwd, promptPath, _shell, _mcp, _newSessionId, model) => {
        const base = promptPath
          ? `--cwd ${quoteShell(cwd)} "$(tr '\\r\\n' '  ' < ${quoteShell(promptPath)})"`
          : `--cwd ${quoteShell(cwd)}`;
        return `${modelBashArg(model)} ${base}`.trim();
      },
      resumeArgs: (cwd, sessionId) => `grok --cwd ${quoteShell(cwd)} -r ${quoteShell(sessionId)}`,
    };
  }
  if (kind === "athena") {
    // Athena Code is a standalone opencode fork installed like any other
    // agent CLI, so it shares opencode's argument shape.
    return {
      label: "Athena Code",
      executable: "athena-code",
      powerShellCommand: "$agentPrompt = (($prompt -replace '[\\r\\n]+', ' ') -replace '\\s{2,}', ' ').Trim(); $agentArgs = $modelArgs + @('--prompt', $agentPrompt, $workspace); & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = $modelArgs + @($workspace); & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @('--session', $sessionId, $workspace); & $agentCommand @agentArgs",
      args: (cwd, promptPath, _shell, _mcp, _newSessionId, model) => {
        const base = promptPath ? `--prompt "$(tr '\\r\\n' '  ' < ${quoteShell(promptPath)})" ${quoteShell(cwd)}` : quoteShell(cwd);
        return `${modelBashArg(model)} ${base}`.trim();
      },
      resumeArgs: (cwd, sessionId) => `athena-code --session ${quoteShell(sessionId)} ${quoteShell(cwd)}`,
    };
  }
  if (kind === "opencode") {
    return {
      label: "OpenCode",
      executable: "opencode",
      powerShellCommand: "$agentPrompt = (($prompt -replace '[\\r\\n]+', ' ') -replace '\\s{2,}', ' ').Trim(); $agentArgs = $modelArgs + @('--prompt', $agentPrompt, $workspace); & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = $modelArgs + @($workspace); & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @('--session', $sessionId, $workspace); & $agentCommand @agentArgs",
      args: (cwd, promptPath, _shell, _mcp, _newSessionId, model) => {
        const base = promptPath ? `--prompt "$(tr '\\r\\n' '  ' < ${quoteShell(promptPath)})" ${quoteShell(cwd)}` : quoteShell(cwd);
        return `${modelBashArg(model)} ${base}`.trim();
      },
      resumeArgs: (cwd, sessionId) => `opencode --session ${quoteShell(sessionId)} ${quoteShell(cwd)}`,
    };
  }
  if (kind === "claude") {
    // A pre-generated `--session-id` pins the Claude session identity at spawn
    // time so the registry never has to infer it from session-file mtimes,
    // which mis-attaches when two panes share a workspace (issue #137).
    return {
      label: "Claude Code",
      executable: "claude",
      powerShellCommand: "$agentArgs = @() + $modelArgs; if ($newSessionId) { $agentArgs += @('--session-id', $newSessionId) }; if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath, '--') }; $agentArgs += $prompt; & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = @() + $modelArgs; if ($newSessionId) { $agentArgs += @('--session-id', $newSessionId) }; if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; $agentArgs += @('--resume', $sessionId); & $agentCommand @agentArgs",
      args: (_cwd, promptPath, _shell, mcp, newSessionId, model) => [
        model ? `--model ${quoteShell(model)}` : "",
        newSessionId ? `--session-id ${quoteShell(newSessionId)}` : "",
        mcp?.configPath ? `--mcp-config ${quoteShell(mcp.configPath)}` : "",
        mcp?.configPath && promptPath ? "--" : "",
        promptPath ? `"$(cat ${quoteShell(promptPath)})"` : "",
      ].filter(Boolean).join(" "),
      resumeArgs: (_cwd, sessionId, _shell, mcp) => [
        "claude",
        mcp?.configPath ? `--mcp-config ${quoteShell(mcp.configPath)}` : "",
        "--resume",
        quoteShell(sessionId),
      ].filter(Boolean).join(" "),
    };
  }
  return {
    label: "Codex",
    executable: "codex",
    // $mcpConfigArgs is defined by the PowerShell launch builders ('-c <override>'
    // pairs, or @() when MCP is not wired) and spliced into the argument array.
    powerShellCommand: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all') + $mcpConfigArgs + $modelArgs + @('--cd', $workspace, '--', $prompt); & $agentCommand @agentArgs",
    powerShellCommandWithoutPrompt: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all') + $mcpConfigArgs + $modelArgs + @('--cd', $workspace); & $agentCommand @agentArgs",
    resumePowerShellCommand: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all') + $mcpConfigArgs + @('resume', '--cd', $workspace, $sessionId); & $agentCommand @agentArgs",
    args: (cwd, promptPath, _shell, mcp, _newSessionId, model) => {
      const base = `-c shell_environment_policy.inherit=all${codexMcpBashArgs(mcp)}${modelBashArg(model)} --cd ${quoteShell(cwd)}`;
      return promptPath ? `${base} -- "$(cat ${quoteShell(promptPath)})"` : base;
    },
    resumeArgs: (cwd, sessionId, _shell, mcp) =>
      `codex -c shell_environment_policy.inherit=all${codexMcpBashArgs(mcp)} resume --cd ${quoteShell(cwd)} ${quoteShell(sessionId)}`,
  };
}

export function repairClaudeBinaryPowerShell(): string {
  // Recover from an interrupted Claude Code auto-update on Windows. The updater
  // renames the running bin/claude.exe to claude.exe.old.<timestamp> (Windows
  // locks a running binary, so it must be moved aside before the replacement is
  // written) and then drops in the new exe. If that second step fails, bin/ is
  // left with only the backup and no claude.exe. Get-Command still resolves the
  // npm shim (claude.ps1 / claude.cmd), so the "not installed or not on PATH"
  // guard above passes -- but launching the shim then dies with
  // CommandNotFoundException because it forwards to the missing bin/claude.exe.
  // Restore the newest backup so the pane launches instead of failing on every
  // attempt until the user repairs the install by hand.
  return [
    "if ($resolvedAgent.Path) {",
    "  $claudeBinDirs = @()",
    "  $claudeShimDir = Split-Path -Parent $resolvedAgent.Path",
    // The shim lives at the npm prefix root; the exe lives under the package's
    // bin/. Also try the shim dir itself (Get-Command may resolve the exe
    // directly) and the default Windows npm global prefix.
    "  $claudeBinDirs += (Join-Path $claudeShimDir 'node_modules\\@anthropic-ai\\claude-code\\bin')",
    "  $claudeBinDirs += $claudeShimDir",
    "  if ($env:APPDATA) { $claudeBinDirs += (Join-Path $env:APPDATA 'npm\\node_modules\\@anthropic-ai\\claude-code\\bin') }",
    "  foreach ($claudeBinDir in ($claudeBinDirs | Select-Object -Unique)) {",
    "    $claudeExe = Join-Path $claudeBinDir 'claude.exe'",
    "    if ((Test-Path -LiteralPath $claudeBinDir) -and -not (Test-Path -LiteralPath $claudeExe)) {",
    "      $claudeBackup = Get-ChildItem -LiteralPath $claudeBinDir -Filter 'claude.exe.old.*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
    "      if ($claudeBackup) {",
    "        try {",
    "          Copy-Item -LiteralPath $claudeBackup.FullName -Destination $claudeExe -Force -ErrorAction Stop",
    "          Write-Host \"[Context Workspace] Restored claude.exe from $($claudeBackup.Name) after an interrupted auto-update.\" -ForegroundColor Yellow",
    "        } catch {",
    "          Write-Host \"[Context Workspace] Could not restore claude.exe after an interrupted auto-update: $_\" -ForegroundColor Red",
    "        }",
    "      }",
    "    }",
    "  }",
    // `claude --version` costs a full CLI start on every launch. Remember the
    // last successful probe keyed by the resolved command plus the write times
    // of the shim, package, and native exe, so it reruns only after an install,
    // update, or repair changes one of them.
    "  $claudeProbeKey = $null",
    "  try {",
    "    $claudeProbeParts = @($resolvedAgent.Path, (Get-Item -LiteralPath $resolvedAgent.Path -ErrorAction Stop).LastWriteTimeUtc.Ticks)",
    "    $claudeProbeFiles = @((Join-Path $claudeShimDir 'node_modules\\@anthropic-ai\\claude-code\\package.json'))",
    "    foreach ($claudeBinDir in ($claudeBinDirs | Select-Object -Unique)) { $claudeProbeFiles += (Join-Path $claudeBinDir 'claude.exe') }",
    "    foreach ($claudeProbeFile in $claudeProbeFiles) {",
    "      $claudeProbeItem = Get-Item -LiteralPath $claudeProbeFile -ErrorAction SilentlyContinue",
    "      if ($claudeProbeItem) { $claudeProbeParts += @($claudeProbeItem.FullName, $claudeProbeItem.LastWriteTimeUtc.Ticks) }",
    "    }",
    "    $claudeProbeKey = $claudeProbeParts -join '|'",
    "  } catch { $claudeProbeKey = $null }",
    "  $claudeProbeCache = Join-Path $HOME '.context-workspace\\claude-launch-probe.txt'",
    "  $claudeLaunchReady = $false",
    "  if ($claudeProbeKey -and (Test-Path -LiteralPath $claudeProbeCache)) {",
    "    try { $claudeLaunchReady = ((Get-Content -LiteralPath $claudeProbeCache -Raw -Encoding UTF8 -ErrorAction Stop).Trim() -eq $claudeProbeKey) } catch { $claudeLaunchReady = $false }",
    "  }",
    "  if (-not $claudeLaunchReady) {",
    "    try {",
    "      & $agentCommand --version 2>$null | Out-Null",
    "      $claudeLaunchReady = ($LASTEXITCODE -eq 0)",
    "    } catch { $claudeLaunchReady = $false }",
    "    if ($claudeLaunchReady -and $claudeProbeKey) {",
    "      try {",
    "        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $claudeProbeCache) -ErrorAction Stop | Out-Null",
    "        Set-Content -LiteralPath $claudeProbeCache -Value $claudeProbeKey -Encoding UTF8 -ErrorAction Stop",
    "      } catch { }",
    "    }",
    "  }",
    "  if (-not $claudeLaunchReady) {",
    "    foreach ($claudeCandidate in @(Get-Command claude -All -ErrorAction SilentlyContinue)) {",
    "      if (-not $claudeCandidate.Path) { continue }",
    "      try {",
    "        & $claudeCandidate.Path --version 2>$null | Out-Null",
    "        if ($LASTEXITCODE -eq 0) {",
    "          $agentCommand = $claudeCandidate.Path",
    "          $resolvedAgent = $claudeCandidate",
    "          $claudeLaunchReady = $true",
    "          break",
    "        }",
    "      } catch { continue }",
    "    }",
    "  }",
    "  if (-not $claudeLaunchReady) {",
    "    Write-Host \"Claude Code is installed but not runnable. Repair or reinstall it: https://docs.anthropic.com/en/docs/claude-code/setup\" -ForegroundColor Red",
    "    return",
    "  }",
    "}",
  ].join("\n");
}

function selectOpenCodeBaselinePowerShell(): string {
  return [
    "$baselineCandidates = @()",
    "if ($resolvedAgent.Path) {",
    "  $agentPath = $resolvedAgent.Path",
    "  $agentDir = Split-Path -Parent $agentPath",
    "  $baselineCandidates += Join-Path $agentDir 'node_modules\\opencode-ai\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "  if ($agentPath -like '*\\opencode-windows-x64\\bin\\opencode.exe') {",
    "    $baselineCandidates += ($agentPath -replace '\\\\opencode-windows-x64\\\\bin\\\\opencode\\.exe$', '\\opencode-windows-x64-baseline\\bin\\opencode.exe')",
    "  }",
    "  if ($agentPath -like '*\\node_modules\\opencode-ai\\bin\\opencode') {",
    "    $packageRoot = Split-Path -Parent (Split-Path -Parent $agentPath)",
    "    $baselineCandidates += Join-Path $packageRoot 'node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "  }",
    "}",
    "if ($env:APPDATA) {",
    "  $baselineCandidates += Join-Path $env:APPDATA 'npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64-baseline\\bin\\opencode.exe'",
    "}",
    "$baseline = $baselineCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1",
    "if ($baseline) {",
    "  $agentCommand = $baseline",
    "  $env:OPENCODE_BIN_PATH = $baseline",
    "  Write-Host \"[Context Workspace] OpenCode baseline binary selected to avoid Bun AVX2 crash: $baseline\" -ForegroundColor Yellow",
    "}",
  ].join("\n");
}
