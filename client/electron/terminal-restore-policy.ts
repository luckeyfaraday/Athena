import * as path from "node:path";
import * as fs from "node:fs";
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

export function savedResumeSessionId(entry: RestorableTerminal): string | null {
  return entry.resumeSessionId ?? entry.providerSessionId;
}

export function claudeProjectPathCandidates(projectsDir: string, workspace: string): string[] {
  return Array.from(new Set([
    path.join(projectsDir, encodeClaudeProjectPath(workspace)),
    path.join(projectsDir, legacyEncodeClaudeProjectPath(workspace)),
  ]));
}

export async function newestCodexSessionIdForWorkspace(sessionsDir: string, workspace: string, minMtimeMs: number): Promise<string | null> {
  const files = await recentJsonlFiles(sessionsDir, 120);
  const candidates: { id: string; mtimeMs: number }[] = [];
  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < minMtimeMs) continue;
      const metadata = await readCodexJsonlMetadata(filePath);
      if (!metadata.sessionId || !metadata.cwd || !samePath(metadata.cwd, workspace)) continue;
      candidates.push({ id: metadata.sessionId, mtimeMs: stat.mtimeMs });
    } catch {
      // Codex session discovery is best-effort; a failed file should not block restore.
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id ?? null;
}

function encodeClaudeProjectPath(workspace: string): string {
  return path.resolve(workspace).replace(/:/g, "").replace(/[^A-Za-z0-9.]+/g, "-");
}

function legacyEncodeClaudeProjectPath(workspace: string): string {
  return path.resolve(workspace).replace(/:/g, "").replace(/[\\/]/g, "-");
}

async function recentJsonlFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }));
  }
  await visit(root);
  const withMtime = await Promise.all(files.map(async (filePath) => {
    try {
      return { filePath, mtimeMs: (await fs.promises.stat(filePath)).mtimeMs };
    } catch {
      return { filePath, mtimeMs: 0 };
    }
  }));
  return withMtime
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((item) => item.filePath);
}

async function readCodexJsonlMetadata(filePath: string): Promise<{ sessionId: string | null; cwd: string | null }> {
  const contents = await fs.promises.readFile(filePath, "utf8");
  let sessionId: string | null = null;
  let cwd: string | null = null;
  for (const line of contents.split("\n").slice(0, 240)) {
    const entry = parseJsonObject(line);
    if (!entry) continue;
    const entryType = stringProperty(entry, "type");
    const payload = objectProperty(entry, "payload");
    if (entryType === "session_meta") {
      sessionId = stringProperty(payload, "id") ?? sessionId;
      cwd = stringProperty(payload, "cwd") ?? cwd;
    } else if (entryType === "turn_context") {
      cwd = stringProperty(payload, "cwd") ?? cwd;
    }
    if (sessionId && cwd) break;
  }
  return { sessionId, cwd };
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectProperty(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const item = value?.[key];
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
}

function stringProperty(value: Record<string, unknown> | null, key: string): string | null {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

function samePath(candidate: string, root: string): boolean {
  try {
    return path.resolve(candidate) === path.resolve(root);
  } catch {
    return candidate === root;
  }
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
