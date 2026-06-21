import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
import { querySqlite, type SqliteValue } from "./sqlite.js";
import { readFilePrefix } from "./file-prefix.js";

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

// Session discovery accepts files created up to this long before the terminal
// spawned, to absorb clock skew between PTY bookkeeping and file timestamps.
export const SESSION_DISCOVERY_GRACE_MS = 10_000;

export type SessionFileCandidate = { id: string; createdMs: number };

// A long-running session file is rewritten on every turn, so its mtime is
// useless for telling "created by this spawn" apart from "busy neighbor pane"
// (issue #137). Use birthtime when the filesystem provides one; the min()
// guards against tools that backdate mtime below birthtime.
export function effectiveCreationMs(stat: fs.Stats): number {
  return stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
}

export function selectDiscoveredSessionId(
  candidates: SessionFileCandidate[],
  spawnedAtMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): string | null {
  return candidates
    .filter((candidate) => candidate.createdMs >= spawnedAtMs - SESSION_DISCOVERY_GRACE_MS && !excludeSessionIds?.has(candidate.id))
    .sort((left, right) => Math.abs(left.createdMs - spawnedAtMs) - Math.abs(right.createdMs - spawnedAtMs))[0]?.id ?? null;
}

export async function codexSessionIdForWorkspace(
  sessionsDir: string,
  workspace: string,
  spawnedAtMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): Promise<string | null> {
  const files = await recentJsonlFiles(sessionsDir, 120);
  const candidates: SessionFileCandidate[] = [];
  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      const createdMs = effectiveCreationMs(stat);
      if (createdMs < spawnedAtMs - SESSION_DISCOVERY_GRACE_MS) continue;
      const metadata = await readCodexJsonlMetadata(filePath);
      if (!metadata.sessionId || !metadata.cwd || !samePath(metadata.cwd, workspace)) continue;
      candidates.push({ id: metadata.sessionId, createdMs });
    } catch {
      // Codex session discovery is best-effort; a failed file should not block restore.
    }
  }
  return selectDiscoveredSessionId(candidates, spawnedAtMs, excludeSessionIds);
}

// OpenCode (and the Athena Code fork, which keeps OpenCode's storage layout)
// writes sessions to a sqlite database whose filename embeds the build
// channel: `opencode.db` for release channels, `opencode-<channel>.db`
// otherwise (Athena Code builds currently produce `opencode-.db`). Scanning
// for every variant keeps discovery working across builds and upgrades.
export function openCodeDatabaseCandidates(dataDir = path.join(os.homedir(), ".local", "share", "opencode")): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^opencode(-[A-Za-z0-9._-]*)?\.db$/.test(name))
    .sort()
    .map((name) => path.join(dataDir, name));
}

export function openCodeSessionCandidates(rows: SqliteValue[][], workspace: string): SessionFileCandidate[] {
  const candidates: SessionFileCandidate[] = [];
  for (const row of rows) {
    const id = typeof row[0] === "string" && row[0] ? row[0] : null;
    const directory = typeof row[1] === "string" && row[1] ? row[1] : null;
    const createdMs = typeof row[2] === "number" ? row[2] : Number(row[2]);
    if (!id || !directory || !Number.isFinite(createdMs)) continue;
    if (!samePath(directory, workspace)) continue;
    candidates.push({ id, createdMs });
  }
  return candidates;
}

const OPENCODE_SESSION_QUERY = [
  "select s.id, coalesce(s.directory, p.worktree), s.time_created",
  "from session s",
  "left join project p on s.project_id = p.id",
  "order by s.time_created desc",
  "limit 40",
].join(" ");

export async function openCodeSessionIdForWorkspace(
  dbPaths: string[],
  workspace: string,
  spawnedAtMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): Promise<string | null> {
  const candidates: SessionFileCandidate[] = [];
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    candidates.push(...openCodeSessionCandidates(await querySqlite(dbPath, OPENCODE_SESSION_QUERY, []), workspace));
  }
  return selectDiscoveredSessionId(candidates, spawnedAtMs, excludeSessionIds);
}

export async function openCodeSessionExists(dbPaths: string[], sessionId: string): Promise<boolean> {
  let sawQueryFailure = false;
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    const rows = await querySqlite(dbPath, "select count(*) from session where id = ?", [sessionId]);
    if (rows.length === 0) {
      sawQueryFailure = true;
      continue;
    }
    if (Number(rows[0]?.[0]) > 0) return true;
  }
  // The saved id only ever came from a successful query of these databases, so
  // a failed re-check (transient lock, missing Python) is treated as "still
  // there": resuming optimistically degrades to an error plus a shell, while
  // launching fresh silently discards the conversation.
  return sawQueryFailure;
}

// Mirror Claude Code's own cwd -> ~/.claude/projects/<dir> encoding exactly:
// every non-alphanumeric character maps one-to-one to "-". So a drive-letter
// colon plus separator becomes a double dash ("C:\\Users" -> "C--Users"), a
// "." becomes "-", and adjacent separators are NOT collapsed. Any divergence
// here makes restore probe the wrong directory and silently launch a fresh
// session instead of resuming the saved one (see issue #173).
function encodeClaudeProjectPath(workspace: string): string {
  return encodeResolvedClaudeProjectPath(path.resolve(workspace));
}

export function encodeResolvedClaudeProjectPath(resolvedWorkspace: string): string {
  return resolvedWorkspace.replace(/[^A-Za-z0-9]/g, "-");
}

// Kept as an extra candidate so sessions saved under Athena's older (incorrect)
// encoding still resolve. New sessions always use encodeClaudeProjectPath.
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
  const contents = await readFilePrefix(filePath);
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
