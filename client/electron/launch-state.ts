import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type AthenaLaunchState = {
  pid: number;
  startedAt: string;
  cleanExit: boolean;
  terminalRestorePaused: boolean;
  previousCrashAt: string | null;
};

type ProcessInfo = {
  pid: number;
  ppid: number | null;
  command: string;
};

let currentState: AthenaLaunchState | null = null;

export function launchStateFilePath(): string {
  return path.join(os.homedir(), ".context-workspace", "athena-launch.json");
}

export function beginAthenaLaunch(): AthenaLaunchState {
  const previous = readAthenaLaunchState();
  currentState = nextAthenaLaunchState(previous, process.pid, new Date().toISOString());
  if (previous && !previous.cleanExit) cleanupStaleAthenaProcesses();
  writeAthenaLaunchState(currentState);
  return currentState;
}

export function nextAthenaLaunchState(previous: AthenaLaunchState | null, pid: number, startedAt: string): AthenaLaunchState {
  const previousCrashed = previous != null && !previous.cleanExit;
  return {
    pid,
    startedAt,
    cleanExit: false,
    terminalRestorePaused: Boolean(previous?.terminalRestorePaused || previousCrashed),
    previousCrashAt: previousCrashed ? previous.startedAt : previous?.previousCrashAt ?? null,
  };
}

export function markAthenaCleanExit(): void {
  if (!currentState) currentState = readAthenaLaunchState();
  if (!currentState) return;
  currentState = {
    ...currentState,
    cleanExit: true,
  };
  writeAthenaLaunchState(currentState);
}

export function isTerminalRestorePaused(): boolean {
  return Boolean(currentState?.terminalRestorePaused ?? readAthenaLaunchState()?.terminalRestorePaused);
}

export function clearTerminalRestorePause(): AthenaLaunchState {
  const previous = currentState ?? readAthenaLaunchState();
  currentState = {
    pid: process.pid,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    cleanExit: previous?.cleanExit ?? false,
    terminalRestorePaused: false,
    previousCrashAt: previous?.previousCrashAt ?? null,
  };
  writeAthenaLaunchState(currentState);
  return currentState;
}

export function readAthenaLaunchState(): AthenaLaunchState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(launchStateFilePath(), "utf8"));
    return isAthenaLaunchState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeAthenaLaunchState(state: AthenaLaunchState): void {
  try {
    const filePath = launchStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Launch state is a crash-loop guard; failure to persist must not block app startup.
  }
}

function isAthenaLaunchState(value: unknown): value is AthenaLaunchState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AthenaLaunchState>;
  return typeof state.pid === "number"
    && typeof state.startedAt === "string"
    && typeof state.cleanExit === "boolean"
    && typeof state.terminalRestorePaused === "boolean"
    && (state.previousCrashAt == null || typeof state.previousCrashAt === "string");
}

function cleanupStaleAthenaProcesses(): void {
  if (process.platform !== "linux") return;
  for (const item of listProcesses()) {
    if (item.pid === process.pid || item.ppid !== 1 || !isStaleAthenaProcess(item.command)) continue;
    try {
      process.kill(item.pid, "SIGTERM");
    } catch {
      // Best effort. The next launch should not fail because cleanup could not kill an orphan.
    }
  }
}

function listProcesses(): ProcessInfo[] {
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 2_000_000 });
    return output.split("\n").map((line): ProcessInfo | null => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    }).filter((entry): entry is ProcessInfo => Boolean(entry));
  } catch {
    return [];
  }
}

function isStaleAthenaProcess(command: string): boolean {
  const userDataArg = `--user-data-dir=${path.join(os.homedir(), ".config", "context-workspace-client")}`;
  return command.includes("context-workspace-client")
    || command.includes("uvicorn backend.app:app")
    || command.includes("/tmp/.mount_ATHENA")
    || command.includes(userDataArg);
}
