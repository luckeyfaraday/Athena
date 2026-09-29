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

export function defaultShell(): TerminalLaunch {
  if (isWindows) return { command: preferredWindowsPowerShell(), args: ["-NoLogo"] };
  return { command: "bash", args: ["-l"] };
}

let cachedWindowsPowerShell: "pwsh.exe" | "powershell.exe" | null = null;

/**
 * PowerShell 7 when installed, else Windows PowerShell. The PATH probe spawns
 * `where.exe` synchronously (~100ms), and every agent launch/restore asks, so
 * the default probe is memoized for the process lifetime. Installing pwsh
 * while Athena is running takes effect on the next app start.
 */
export function preferredWindowsPowerShell(
  exists?: (command: string) => boolean,
): "pwsh.exe" | "powershell.exe" {
  if (exists) return exists("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
  cachedWindowsPowerShell ??= commandExists("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
  return cachedWindowsPowerShell;
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

export function normalizeComparablePath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  if (!slashed) return "";

  // Keep drive roots canonical. Removing their trailing slash turns `C:/`
  // into the drive-relative `C:` and breaks native/WSL descendant matching.
  const wslDrive = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(slashed);
  if (wslDrive) {
    const rest = (wslDrive[2] ?? "").replace(/\/+$/, "");
    return `${wslDrive[1]}:/${rest}`.toLowerCase();
  }
  const windowsDrive = /^\/?([a-zA-Z]):\/(.*)$/.exec(slashed);
  if (windowsDrive) {
    const rest = windowsDrive[2].replace(/\/+$/, "");
    return `${windowsDrive[1]}:/${rest}`.toLowerCase();
  }

  const withoutTrailingSlashes = slashed.replace(/\/+$/, "");
  const normalized = withoutTrailingSlashes || (slashed.startsWith("/") ? "/" : "");
  // UNC server/share names follow Windows' case-insensitive path semantics.
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) return normalized.toLowerCase();
  return normalized;
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
