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
): { restore: RestorableTerminal[]; retained: RestorableTerminal[] } {
  const allowed = restoreWorkspaceSet(allowedWorkspaces);
  const restore: RestorableTerminal[] = [];
  const retained: RestorableTerminal[] = [];

  for (const entry of entries) {
    if (allowed && !allowed.has(normalizeRestoreWorkspace(entry.workspace))) {
      retained.push(entry);
      continue;
    }
    restore.push(entry);
  }

  return { restore, retained };
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
