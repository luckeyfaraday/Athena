import * as path from "node:path";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";

export type RestorableTerminal = {
  id: string;
  workspace: string;
  kind: EmbeddedTerminalKind;
  title: string;
  sessionLabel: string | null;
  providerSessionId: string | null;
  resumeSessionId: string | null;
  createdAt: string;
};

export function selectEmbeddedTerminalRestoreEntries(
  entries: RestorableTerminal[],
  allowedWorkspaces?: string[],
  activeTerminalIds: Iterable<string> = [],
): { restore: RestorableTerminal[]; retained: RestorableTerminal[]; live: RestorableTerminal[] } {
  const allowed = restoreWorkspaceSet(allowedWorkspaces);
  const active = new Set(activeTerminalIds);
  const restore: RestorableTerminal[] = [];
  const retained: RestorableTerminal[] = [];
  const live: RestorableTerminal[] = [];

  for (const entry of entries) {
    if (allowed && !allowed.has(normalizeRestoreWorkspace(entry.workspace))) {
      retained.push(entry);
      continue;
    }
    if (active.has(entry.id)) {
      live.push(entry);
      continue;
    }
    restore.push(entry);
  }

  return { restore, retained, live };
}

export function claudeProjectPathCandidates(projectsDir: string, workspace: string): string[] {
  return Array.from(new Set([
    path.join(projectsDir, encodeClaudeProjectPath(workspace)),
    path.join(projectsDir, legacyEncodeClaudeProjectPath(workspace)),
  ]));
}

function encodeClaudeProjectPath(workspace: string): string {
  return path.resolve(workspace).replace(/:/g, "").replace(/[^A-Za-z0-9.]+/g, "-");
}

function legacyEncodeClaudeProjectPath(workspace: string): string {
  return path.resolve(workspace).replace(/:/g, "").replace(/[\\/]/g, "-");
}

function restoreWorkspaceSet(workspaces?: string[]): Set<string> | null {
  if (!workspaces || workspaces.length === 0) return null;
  const normalized = workspaces
    .map((workspace) => normalizeRestoreWorkspace(workspace))
    .filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function normalizeRestoreWorkspace(workspace: string): string {
  try {
    return path.resolve(workspace);
  } catch {
    return workspace;
  }
}
