import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";
export const isLinux = process.platform === "linux";
export const isMac = process.platform === "darwin";

export type WorkspacePath = {
  nativePath: string;
  wslPath: string | null;
  displayPath: string;
};

export type TerminalLaunch = {
  command: string;
  args: string[];
};

export type TerminalLauncher = {
  shell(cwd: string): TerminalLaunch;
  agent(kind: string, cwd: string, promptPath: string): TerminalLaunch;
  nativeTerminal(cwd: string, scriptPath: string): TerminalLaunch | null;
  commandExists(command: string): boolean;
};

export function defaultShell(): TerminalLaunch {
  if (isWindows) return { command: "cmd.exe", args: [] };
  return { command: "bash", args: ["-l"] };
}

export function defaultPythonExecutable(): string {
  return process.env.CONTEXT_WORKSPACE_PYTHON || (isWindows ? "python" : "python3");
}

export function commandExists(command: string): boolean {
  const lookup = commandLookupTool();
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

export function commandLookupTool(platform: NodeJS.Platform = process.platform): "where.exe" | "which" {
  return platform === "win32" ? "where.exe" : "which";
}

export function tempWorkspaceDirectory(): string {
  const directory = path.join(os.tmpdir(), "context-workspace");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function scriptExtension(): ".ps1" | ".sh" {
  return scriptExtensionForPlatform(process.platform);
}

export function scriptExtensionForPlatform(platform: NodeJS.Platform): ".ps1" | ".sh" {
  return platform === "win32" ? ".ps1" : ".sh";
}

export function getDefaultWorkspace(appRoot?: string): WorkspacePath {
  const configured = process.env.CONTEXT_WORKSPACE_DEFAULT_WORKSPACE?.trim();
  if (configured) return toWorkspacePath(configured);

  const cwd = process.cwd();
  if (cwd && cwd !== path.parse(cwd).root && fs.existsSync(cwd)) {
    return toWorkspacePath(cwd);
  }

  if (appRoot && !appRoot.includes(".asar") && fs.existsSync(appRoot)) {
    return toWorkspacePath(path.resolve(appRoot, ".."));
  }

  return toWorkspacePath(os.homedir());
}

export function toWorkspacePath(value: string): WorkspacePath {
  const nativePath = normalizeNativePath(value);
  const wslPath = isWindowsPath(nativePath) ? windowsPathToWslPath(nativePath) : isWslPath(nativePath) ? nativePath : null;
  return {
    nativePath,
    wslPath,
    displayPath: nativePath,
  };
}

export function normalizeNativePath(value: string): string {
  const trimmed = value.trim();
  if (isWindowsPath(trimmed) || isUncPath(trimmed)) {
    return path.win32.normalize(trimmed);
  }
  return path.resolve(trimmed);
}

export function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function isUncPath(value: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}

export function isPosixPath(value: string): boolean {
  return value.startsWith("/");
}

export function isWslPath(value: string): boolean {
  return /^\/mnt\/[a-zA-Z]\//.test(value) || value.startsWith("/home/");
}

export function windowsPathToWslPath(value: string): string | null {
  const normalized = path.win32.normalize(value);
  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(normalized);
  if (!driveMatch) return null;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export function wslPathToWindowsPath(value: string): string | null {
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(value);
  if (!match) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

export function nativeTerminalLaunch(cwd: string, scriptPath: string): TerminalLaunch | null {
  if (isWindows) {
    if (!commandExists("wt.exe")) return null;
    return { command: "wt.exe", args: ["-d", cwd, "powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", scriptPath] };
  }

  if (isMac) {
    const script = [
      'tell application "Terminal"',
      "activate",
      `do script "${escapeAppleScript(`bash ${quoteShell(scriptPath)}`)}"`,
      "end tell",
    ].join("\n");
    return { command: "osascript", args: ["-e", script] };
  }

  const command = `bash ${quoteShell(scriptPath)}`;
  const terminalFromEnv = process.env.TERMINAL?.trim();
  const candidates: TerminalLaunch[] = [
    ...(terminalFromEnv ? [{ command: terminalFromEnv, args: ["-e", "bash", "-lc", command] }] : []),
    { command: "gnome-terminal", args: ["--working-directory", cwd, "--", "bash", "-lc", command] },
    { command: "konsole", args: ["--workdir", cwd, "-e", "bash", "-lc", command] },
    { command: "xfce4-terminal", args: ["--working-directory", cwd, "--command", `bash -lc '${command}'`] },
    { command: "alacritty", args: ["--working-directory", cwd, "-e", "bash", "-lc", command] },
    { command: "kitty", args: ["--directory", cwd, "bash", "-lc", command] },
    { command: "x-terminal-emulator", args: ["-e", "bash", "-lc", command] },
  ];

  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

export function windowsTerminalGridLaunch(cwd: string, scriptPaths: string[]): TerminalLaunch | null {
  if (!isWindows || scriptPaths.length === 0 || !commandExists("wt.exe")) return null;
  return { command: "wt.exe", args: windowsTerminalGridArgs(cwd, scriptPaths) };
}

export function windowsTerminalGridArgs(cwd: string, scriptPaths: string[]): string[] {
  if (scriptPaths.length === 0) return [];

  const shellArgs = (scriptPath: string) => [
    "powershell.exe",
    "-NoLogo",
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ];
  const args = ["-d", cwd, ...shellArgs(scriptPaths[0])];
  for (const scriptPath of scriptPaths.slice(1)) {
    args.push(";", "split-pane", "-d", cwd, ...shellArgs(scriptPath));
  }
  return args;
}

export function resolveOpenCodeBaselineBinary(): string | null {
  if (!isWindows) return null;

  const appData = process.env.APPDATA;
  const candidates = [
    appData
      ? path.join(appData, "npm", "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe")
      : null,
  ];

  return candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) ?? null;
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "'\\''");
}
