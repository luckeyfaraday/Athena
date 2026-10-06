import { toWorkspacePath, type WorkspacePath } from "./platform.js";

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
  const next = { workspaces, active: workspaceFrom(active) };
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
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
