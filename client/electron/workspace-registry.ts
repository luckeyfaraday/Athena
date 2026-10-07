import { toWorkspacePath, type WorkspacePath } from "./platform.js";
import fs from "node:fs";
import path from "node:path";

// The workspace tabs the renderer has open, as it last reported them. The
// control server serves them to remote Athenas (GET /workspaces, /events) so
// another machine sees the same tabs this one does.

export type ReportedWorkspaces = {
  workspaces: WorkspacePath[];
  active: WorkspacePath | null;
};

const MAX_REPORTED_WORKSPACES = 100;
const MAX_PATH_LENGTH = 4096;

let current: ReportedWorkspaces = { workspaces: [], active: null };
const listeners = new Set<(state: ReportedWorkspaces) => void>();
let persistencePath: string | null = null;

/** Services own tabs without a renderer. Desktop reporting remains compatible. */
export function initializeWorkspaceRegistry(filePath: string): void {
  let saved: { workspaces?: unknown; active?: unknown } = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  reportWorkspaces(saved.workspaces, saved.active);
  persistencePath = filePath;
}

export function openHostWorkspace(workspace: string, select: boolean): void {
  const paths = current.workspaces.map((item) => item.nativePath);
  const normalized = toWorkspacePath(workspace).nativePath;
  if (!paths.includes(normalized) && paths.length >= MAX_REPORTED_WORKSPACES) {
    throw new Error(`At most ${MAX_REPORTED_WORKSPACES} workspaces can be open.`);
  }
  reportWorkspaces([...paths, normalized], select ? normalized : current.active?.nativePath ?? normalized);
}

export function closeHostWorkspace(workspace: string): void {
  const normalized = toWorkspacePath(workspace).nativePath;
  const paths = current.workspaces.map((item) => item.nativePath).filter((item) => item !== normalized);
  reportWorkspaces(paths, current.active?.nativePath === normalized ? paths[0] : current.active?.nativePath);
}

export function reportedWorkspaces(): ReportedWorkspaces {
  return current;
}

export function onReportedWorkspaces(listener: (state: ReportedWorkspaces) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the reported tabs. Invalid entries are dropped; listeners hear only real changes. */
export function reportWorkspaces(paths: unknown, active: unknown): ReportedWorkspaces {
  const seen = new Set<string>();
  const workspaces: WorkspacePath[] = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    const workspace = workspaceFrom(value);
    if (!workspace || seen.has(workspace.nativePath)) continue;
    seen.add(workspace.nativePath);
    workspaces.push(workspace);
    if (workspaces.length >= MAX_REPORTED_WORKSPACES) break;
  }
  const selected = workspaceFrom(active);
  const next = { workspaces, active: workspaces.find((item) => item.nativePath === selected?.nativePath) ?? workspaces[0] ?? null };
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  if (persistencePath) {
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${persistencePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ workspaces: workspaces.map((item) => item.nativePath), active: next.active?.nativePath ?? null }), { mode: 0o600 });
    fs.renameSync(temporary, persistencePath);
  }
  current = next;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // One failing observer must not starve the rest.
    }
  }
  return current;
}

function workspaceFrom(value: unknown): WorkspacePath | null {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PATH_LENGTH) return null;
  try {
    return toWorkspacePath(value);
  } catch {
    return null;
  }
}
