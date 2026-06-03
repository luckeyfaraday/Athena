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

import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
import {
  defaultShell,
  isWindows,
  quotePowerShell,
  quoteShell,
  windowsPathToWslPath,
} from "./platform.js";

export type AgentConfig = {
  label: string;
  executable: string;
  powerShellCommand: string;
  powerShellCommandWithoutPrompt: string;
  resumePowerShellCommand: string;
  args: (cwd: string, promptPath: string | null, shell: "bash", mcpConfigPath?: string | null) => string;
  resumeArgs: (cwd: string, sessionId: string, shell: "bash", mcpConfigPath?: string | null) => string;
};

export function terminalLaunch(
  kind: EmbeddedTerminalKind,
  cwd: string,
  promptPath: string | null,
  resumeSessionId?: string,
  mcpConfigPath?: string | null,
): { command: string; args: string[] } {
  if (isWindows) {
    if (kind === "hermes" && resumeSessionId) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd, resumeSessionId)],
      };
    }
    if (kind === "hermes") {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchHermesPowerShellCommand(cwd)],
      };
    }
    if (kind !== "shell" && resumeSessionId) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchResumePowerShellCommand(kind, cwd, resumeSessionId, mcpConfigPath)],
      };
    }
    if (kind !== "shell") {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", launchPowerShellCommand(kind, cwd, promptPath, mcpConfigPath)],
      };
    }
    return defaultShell();
  }

  return { command: "bash", args: ["-lc", resumeSessionId ? launchResumeCommand(kind, cwd, resumeSessionId, mcpConfigPath) : launchCommand(kind, cwd, promptPath, mcpConfigPath)] };
}

export function launchCommand(kind: EmbeddedTerminalKind, cwd: string, promptPath: string | null, mcpConfigPath?: string | null): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      "printf '\\033[36m[Context Workspace] Hermes ready.\\033[0m\\n'",
      "if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31mhermes is not installed or not on PATH.\\033[0m\\n'; exec bash -l; fi",
      "hermes",
      "exec bash -l",
    ].join("; ");
  }

  if (kind !== "shell") {
    const agent = agentConfig(kind);
    return [
      `cd ${quoteShell(cwd)}`,
      promptPath
        ? `printf '\\033[36m[Context Workspace] %s Athena context: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(promptPath)}`
        : `printf '\\033[36m[Context Workspace] Launching %s\\033[0m\\n' ${quoteShell(agent.label)}`,
      `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s is not installed or not on PATH.\\033[0m\\n' ${quoteShell(agent.executable)}; exec bash -l; fi`,
      `${agent.executable} ${agent.args(cwd, promptPath, "bash", mcpConfigPath)}`.trimEnd(),
      "exec bash -l",
    ].join("; ");
  }

  return [
    `cd ${quoteShell(cwd)}`,
    "printf '\\033[36m[Context Workspace] Embedded shell ready. Launch Codex with Hermes from the Command Room when needed.\\033[0m\\n'",
    "exec bash -l",
  ].join("; ");
}

export function launchHermesPowerShellCommand(cwd: string, resumeSessionId?: string): string {
  const wslCwd = windowsPathToWslPath(cwd) ?? cwd.replace(/\\/g, "/");
  const hermesCommand = resumeSessionId ? `hermes --resume ${quoteShell(resumeSessionId)}` : "hermes";
  const wslCommand = `cd ${quoteShell(wslCwd)} && ${hermesCommand}`;
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    `$wslCommand = ${quotePowerShell(wslCommand)}`,
    "Set-Location -LiteralPath $workspace",
    resumeSessionId
      ? `Write-Host ${quotePowerShell(`[Context Workspace] Resuming Hermes session: ${resumeSessionId}`)} -ForegroundColor Cyan`
      : "Write-Host \"[Context Workspace] Hermes ready.\" -ForegroundColor Cyan",
    "$resolvedWsl = Get-Command wsl.exe -ErrorAction SilentlyContinue",
    "if ($resolvedWsl) { & wsl.exe -e sh -lc $wslCommand; return }",
    "$resolvedHermes = Get-Command hermes -ErrorAction SilentlyContinue",
    resumeSessionId ? `$sessionId = ${quotePowerShell(resumeSessionId)}` : "",
    resumeSessionId ? "if ($resolvedHermes) { & hermes --resume $sessionId; return }" : "if ($resolvedHermes) { & hermes; return }",
    "Write-Host \"wsl.exe is unavailable and native hermes is not on PATH.\" -ForegroundColor Red",
  ].filter(Boolean).join("; ");
}

export function launchResumeCommand(kind: EmbeddedTerminalKind, cwd: string, resumeSessionId: string, mcpConfigPath?: string | null): string {
  if (kind === "hermes") {
    return [
      `cd ${quoteShell(cwd)}`,
      `printf '\\033[36m[Context Workspace] Resuming Hermes session: %s\\033[0m\\n' ${quoteShell(resumeSessionId)}`,
      "if ! command -v hermes >/dev/null 2>&1; then printf '\\033[31mhermes is not installed or not on PATH.\\033[0m\\n'; exec bash -l; fi",
      `hermes --resume ${quoteShell(resumeSessionId)}`,
      "exec bash -l",
    ].join("; ");
  }
  const agent = agentConfig(kind);
  return [
    `cd ${quoteShell(cwd)}`,
    `printf '\\033[36m[Context Workspace] Resuming %s session: %s\\033[0m\\n' ${quoteShell(agent.label)} ${quoteShell(resumeSessionId)}`,
    `if ! command -v ${quoteShell(agent.executable)} >/dev/null 2>&1; then printf '\\033[31m%s is not installed or not on PATH.\\033[0m\\n' ${quoteShell(agent.executable)}; exec bash -l; fi`,
    agent.resumeArgs(cwd, resumeSessionId, "bash", mcpConfigPath),
    "exec bash -l",
  ].join("; ");
}

export function launchResumePowerShellCommand(kind: EmbeddedTerminalKind, cwd: string, resumeSessionId: string, mcpConfigPath?: string | null): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    `$sessionId = ${quotePowerShell(resumeSessionId)}`,
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcpConfigPath ? `$mcpConfigPath = ${quotePowerShell(mcpConfigPath)}` : "",
    "Set-Location -LiteralPath $workspace",
    "Write-Host \"[Context Workspace] Resuming $agentLabel session: $sessionId\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    "if (-not $resolvedAgent) { Write-Host \"$agentCommand is not installed or not on PATH.\" -ForegroundColor Red; return }",
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    agent.resumePowerShellCommand,
  ].join("; ");
}

export function launchPowerShellCommand(kind: EmbeddedTerminalKind, cwd: string, promptPath: string | null, mcpConfigPath?: string | null): string {
  const agent = agentConfig(kind);
  return [
    `$workspace = ${quotePowerShell(cwd)}`,
    promptPath ? `$promptPath = ${quotePowerShell(promptPath)}` : "",
    "Set-Location -LiteralPath $workspace",
    `$agentCommand = ${quotePowerShell(agent.executable)}`,
    `$agentLabel = ${quotePowerShell(agent.label)}`,
    mcpConfigPath ? `$mcpConfigPath = ${quotePowerShell(mcpConfigPath)}` : "",
    promptPath
      ? "Write-Host \"[Context Workspace] $agentLabel Athena context: $promptPath\" -ForegroundColor Cyan"
      : "Write-Host \"[Context Workspace] Launching $agentLabel\" -ForegroundColor Cyan",
    "$resolvedAgent = Get-Command $agentCommand -ErrorAction SilentlyContinue",
    "if (-not $resolvedAgent) { Write-Host \"$agentCommand is not installed or not on PATH.\" -ForegroundColor Red; return }",
    ...(kind === "opencode" ? [selectOpenCodeBaselinePowerShell()] : []),
    // Windows PowerShell 5.1 wraps space-containing native args in quotes but does NOT escape
    // embedded double-quotes, so a multi-line prompt containing `"` (e.g. JSON examples) gets
    // shattered into multiple argv tokens when agent launchers (codex.ps1 / claude npm shims)
    // re-forward $args to node. Pre-escaping `"` as `\"` makes CommandLineToArgvW treat them as
    // literal quotes inside a single argument. See agentConfig powerShellCommand.
    promptPath ? "$prompt = (Get-Content -LiteralPath $promptPath -Raw).Replace('\"', '\\\"')" : "",
    promptPath ? agent.powerShellCommand : agent.powerShellCommandWithoutPrompt,
  ].join("; ");
}

export function agentConfig(kind: EmbeddedTerminalKind): AgentConfig {
  if (kind === "opencode") {
    return {
      label: "OpenCode",
      executable: "opencode",
      powerShellCommand: "$agentPrompt = (($prompt -replace '[\\r\\n]+', ' ') -replace '\\s{2,}', ' ').Trim(); $agentArgs = @('--prompt', $agentPrompt, $workspace); & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = @($workspace); & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @('--session', $sessionId, $workspace); & $agentCommand @agentArgs",
      args: (cwd, promptPath) => promptPath ? `--prompt "$(tr '\\r\\n' '  ' < ${quoteShell(promptPath)})" ${quoteShell(cwd)}` : quoteShell(cwd),
      resumeArgs: (cwd, sessionId) => `opencode --session ${quoteShell(sessionId)} ${quoteShell(cwd)}`,
    };
  }
  if (kind === "claude") {
    return {
      label: "Claude Code",
      executable: "claude",
      powerShellCommand: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; $agentArgs += $prompt; & $agentCommand @agentArgs",
      powerShellCommandWithoutPrompt: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; & $agentCommand @agentArgs",
      resumePowerShellCommand: "$agentArgs = @(); if ($mcpConfigPath) { $agentArgs += @('--mcp-config', $mcpConfigPath) }; $agentArgs += @('--resume', $sessionId); & $agentCommand @agentArgs",
      args: (_cwd, promptPath, _shell, mcpConfigPath) => [
        mcpConfigPath ? `--mcp-config ${quoteShell(mcpConfigPath)}` : "",
        promptPath ? `"$(cat ${quoteShell(promptPath)})"` : "",
      ].filter(Boolean).join(" "),
      resumeArgs: (_cwd, sessionId, _shell, mcpConfigPath) => [
        "claude",
        mcpConfigPath ? `--mcp-config ${quoteShell(mcpConfigPath)}` : "",
        "--resume",
        quoteShell(sessionId),
      ].filter(Boolean).join(" "),
    };
  }
  return {
    label: "Codex",
    executable: "codex",
    powerShellCommand: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all', '--cd', $workspace, '--', $prompt); & $agentCommand @agentArgs",
    powerShellCommandWithoutPrompt: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all', '--cd', $workspace); & $agentCommand @agentArgs",
    resumePowerShellCommand: "$agentArgs = @('-c', 'shell_environment_policy.inherit=all', 'resume', '--cd', $workspace, $sessionId); & $agentCommand @agentArgs",
    args: (cwd, promptPath) => promptPath
      ? `-c shell_environment_policy.inherit=all --cd ${quoteShell(cwd)} -- "$(cat ${quoteShell(promptPath)})"`
      : `-c shell_environment_policy.inherit=all --cd ${quoteShell(cwd)}`,
    resumeArgs: (cwd, sessionId) => `codex -c shell_environment_policy.inherit=all resume --cd ${quoteShell(cwd)} ${quoteShell(sessionId)}`,
  };
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
