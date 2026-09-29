import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
import { querySqliteBatch, type SqliteValue } from "./sqlite.js";

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

export function hasMissingSavedRestoreIdentity(
  entry: RestorableTerminal,
  resolvedResumeSessionId: string | null,
): boolean {
  return Boolean(savedResumeSessionId(entry) && !resolvedResumeSessionId);
}

export function shouldConfirmEmbeddedTerminalRestoreShutdown(
  completedBeforeDeadline: boolean,
  ptyHostShutdownConfirmed: boolean,
): boolean {
  return completedBeforeDeadline && ptyHostShutdownConfirmed;
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
  const sinceMs = spawnedAtMs - SESSION_DISCOVERY_GRACE_MS;
  const files = await codexDiscoveryFiles(sessionsDir, sinceMs, Date.now());
  const candidates: SessionFileCandidate[] = [];
  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      const createdMs = effectiveCreationMs(stat);
      if (createdMs < sinceMs) continue;
      const metadata = await cachedCodexSessionIdentity(filePath, stat);
      if (!metadata.sessionId || !metadata.cwd || !samePath(metadata.cwd, workspace)) continue;
      candidates.push({ id: metadata.sessionId, createdMs });
    } catch {
      // Codex session discovery is best-effort; a failed file should not block restore.
    }
  }
  return selectDiscoveredSessionId(candidates, spawnedAtMs, excludeSessionIds);
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Newly spawned panes poll discovery every 750 ms; only the dated folders that
// can hold a session created since the spawn are listed. Wider windows (a
// restore entry created days ago) use the bounded most-recent walk instead.
export const CODEX_DISCOVERY_MAX_DATED_DAYS = 3;
const CODEX_DISCOVERY_WALK_LIMIT = 120;

/**
 * Codex writes rollouts to sessions/YYYY/MM/DD/ named by the session's local
 * start date. Returns the dated folders that can contain a session created in
 * [sinceMs, nowMs] — local and UTC calendar days, so midnight rollover and
 * timezone quirks are covered — or null when the window is too wide.
 */
export function codexDatedSessionDirectories(sessionsDir: string, sinceMs: number, nowMs: number): string[] | null {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return null;
  const start = Math.min(sinceMs, nowMs);
  const end = Math.max(sinceMs, nowMs);
  if (end - start > CODEX_DISCOVERY_MAX_DATED_DAYS * DAY_MS) return null;
  const days = new Set<string>();
  const add = (ms: number): void => {
    const date = new Date(ms);
    days.add([date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("/"));
    days.add([date.getUTCFullYear(), pad2(date.getUTCMonth() + 1), pad2(date.getUTCDate())].join("/"));
  };
  for (let ms = start; ms < end; ms += DAY_MS) add(ms);
  add(end);
  return Array.from(days).sort().map((day) => path.join(sessionsDir, ...day.split("/")));
}

/** The *.jsonl files session discovery must inspect for a spawn window. */
export async function codexDiscoveryFiles(sessionsDir: string, sinceMs: number, nowMs: number): Promise<string[]> {
  const rootEntries = await safeReadDirEntries(sessionsDir);
  const years = rootEntries
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map((entry) => entry.name);
  const datedDirectories = years.length > 0 ? codexDatedSessionDirectories(sessionsDir, sinceMs, nowMs) : null;
  if (!datedDirectories) {
    // Legacy/flat layouts and long restore windows keep the most-recent walk.
    return (await boundedRecentJsonlFiles(sessionsDir, CODEX_DISCOVERY_WALK_LIMIT)).map((file) => file.filePath);
  }
  // The newest existing dated folder is always included (two readdirs), so a
  // clock or timezone mismatch between Athena and Codex cannot hide a session.
  // A missing folder otherwise just means Codex has not written the session
  // yet; the caller polls again instead of walking the whole history.
  const directories = new Set(datedDirectories);
  const newest = await newestDatedDirectory(sessionsDir, years);
  if (newest) directories.add(newest);
  const files = rootEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionsDir, entry.name));
  for (const directory of directories) {
    for (const entry of await safeReadDirEntries(directory)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

async function newestDatedDirectory(sessionsDir: string, years: string[]): Promise<string | null> {
  const descendingChildren = async (directory: string): Promise<string[]> => (await safeReadDirEntries(directory))
    .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const year of [...years].sort().reverse()) {
    const yearDir = path.join(sessionsDir, year);
    for (const month of await descendingChildren(yearDir)) {
      const day = (await descendingChildren(path.join(yearDir, month)))[0];
      if (day) return path.join(yearDir, month, day);
    }
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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

// These probes run synchronously (node:sqlite) on the Electron main thread:
// never wait on a database lock there.
const MAIN_THREAD_SQLITE_OPTIONS = { busyTimeoutMs: 0 } as const;

export async function openCodeSessionIdForWorkspace(
  dbPaths: string[],
  workspace: string,
  spawnedAtMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): Promise<string | null> {
  const existing = dbPaths.filter((dbPath) => fs.existsSync(dbPath));
  // One batch: in-process with node:sqlite, or a single interpreter otherwise.
  // Discovery runs on the Electron main thread and polls on a backoff, so a
  // locked database fails fast instead of stalling the thread.
  const results = await querySqliteBatch(
    existing.map((dbPath) => ({ dbPath, sql: OPENCODE_SESSION_QUERY, params: [] })),
    MAIN_THREAD_SQLITE_OPTIONS,
  );
  const candidates = results.flatMap((rows) => openCodeSessionCandidates(rows, workspace));
  return selectDiscoveredSessionId(candidates, spawnedAtMs, excludeSessionIds);
}

export async function openCodeSessionExists(dbPaths: string[], sessionId: string): Promise<boolean> {
  let sawQueryFailure = false;
  const existing = dbPaths.filter((dbPath) => fs.existsSync(dbPath));
  const results = await querySqliteBatch(existing.map((dbPath) => ({
    dbPath,
    sql: "select count(*) from session where id = ?",
    params: [sessionId],
  })), MAIN_THREAD_SQLITE_OPTIONS);
  for (const rows of results) {
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

const JSONL_WALK_MAX_DIRS = 160;
const JSONL_WALK_MAX_ENTRIES = 1200;

export type RecentJsonlFile = { filePath: string; stat: fs.Stats | null };

/**
 * The `limit` most recently modified *.jsonl files under root, from a bounded
 * walk: directories are visited newest-name-first (dated session folders sort
 * chronologically), at most 160 directories / 1200 entries are inspected, and
 * the walk stops after 2×limit candidates. Stats are returned for reuse.
 */
export async function boundedRecentJsonlFiles(root: string, limit: number): Promise<RecentJsonlFile[]> {
  const files: string[] = [];
  let visitedDirs = 0;
  let inspectedEntries = 0;
  const visit = async (directory: string): Promise<void> => {
    if (visitedDirs >= JSONL_WALK_MAX_DIRS || inspectedEntries >= JSONL_WALK_MAX_ENTRIES) return;
    visitedDirs += 1;
    const entries = (await safeReadDirEntries(directory)).sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (inspectedEntries >= JSONL_WALK_MAX_ENTRIES) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name.endsWith(".jsonl")) {
        inspectedEntries += 1;
        files.push(entryPath);
        if (files.length >= limit * 2) return;
      } else {
        inspectedEntries += 1;
      }
    }
  };
  await visit(root);
  const withStats = await Promise.all(files.map(async (filePath) => ({ filePath, stat: await safeStat(filePath) })));
  return withStats
    .sort((left, right) => (right.stat?.mtimeMs ?? 0) - (left.stat?.mtimeMs ?? 0))
    .slice(0, limit);
}

export type LeadingLinesOptions = {
  /** Hard cap on bytes read, like the historical single prefix read. */
  maxBytes: number;
  /** Lines kept after splitting (and dropping empties, when requested). */
  maxLines: number;
  separator: string | RegExp;
  dropEmpty: boolean;
  /** First read size; later reads double until maxBytes. */
  initialBytes?: number;
  /** Known file size, to size buffers and skip the EOF probe. */
  size?: number;
  /** Stop early once the complete lines read so far suffice. */
  enough?: (lines: readonly string[]) => boolean;
};

export type LeadingLines = { lines: string[]; bytesRead: number };

export const LEADING_LINES_INITIAL_BYTES = 32 * 1024;

/**
 * Returns exactly what
 *   prefix(maxBytes).split(separator)[.filter(Boolean)].slice(0, maxLines)
 * would, but reads progressively: 32 KiB first, then doubling, stopping as
 * soon as maxLines complete lines (or `enough`) are available. Lines are cut
 * only at "\n" bytes, so UTF-8 sequences and "\r\n" pairs are never split;
 * an unterminated tail is included only at EOF or at the byte cap, just like
 * the single-read version.
 */
export async function readLeadingLines(filePath: string, options: LeadingLinesOptions): Promise<LeadingLines> {
  const maxLines = Math.max(0, options.maxLines);
  const knownSize = options.size !== undefined && Number.isFinite(options.size) && options.size >= 0 ? options.size : null;
  const limit = Math.max(0, Math.min(Math.floor(options.maxBytes), knownSize ?? Number.MAX_SAFE_INTEGER));
  const lines: string[] = [];
  const push = (text: string, terminated: boolean): void => {
    const segments = text.split(options.separator);
    // A region ending in "\n" splits into [...lines, ""]; the trailing empty
    // piece is the start of the next region, not a line of its own.
    if (terminated) segments.pop();
    for (const segment of segments) {
      if (!options.dropEmpty || segment) lines.push(segment);
    }
  };
  if (limit === 0) {
    push("", false);
    return { lines: lines.slice(0, maxLines), bytesRead: 0 };
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(1, options.initialBytes ?? LEADING_LINES_INITIAL_BYTES)));
    let total = 0;
    let parsedUpTo = 0;
    while (total < limit) {
      if (total === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit, buffer.length * 2));
        buffer.copy(grown, 0, 0, total);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total < buffer.length && total < limit && knownSize === null) continue;
      const lastNewline = buffer.lastIndexOf(0x0a, total - 1);
      if (lastNewline >= parsedUpTo) {
        push(buffer.toString("utf8", parsedUpTo, lastNewline + 1), true);
        parsedUpTo = lastNewline + 1;
        if (lines.length >= maxLines || options.enough?.(lines)) {
          return { lines: lines.slice(0, maxLines), bytesRead: total };
        }
      }
    }
    push(buffer.toString("utf8", parsedUpTo, total), false);
    return { lines: lines.slice(0, maxLines), bytesRead: total };
  } finally {
    await handle.close();
  }
}

type CodexSessionIdentity = { sessionId: string | null; cwd: string | null };

const CODEX_IDENTITY_CACHE_MAX_ENTRIES = 256;
const codexIdentityCache = new Map<string, { birthtimeMs: number; mtimeMs: number; size: number; identity: CodexSessionIdentity }>();

/**
 * Discovery polls the same few rollout files every 750 ms. Their identity
 * comes from the session_meta header of an append-only log, so a complete
 * identity stays valid while the file only grows.
 */
async function cachedCodexSessionIdentity(filePath: string, stat: fs.Stats): Promise<CodexSessionIdentity> {
  const cached = codexIdentityCache.get(filePath);
  if (cached && cached.birthtimeMs === stat.birthtimeMs) {
    const complete = Boolean(cached.identity.sessionId && cached.identity.cwd);
    if ((complete && stat.size >= cached.size) || (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)) {
      codexIdentityCache.delete(filePath);
      codexIdentityCache.set(filePath, cached);
      return cached.identity;
    }
  }
  const identity = await readCodexSessionIdentity(filePath, stat.size);
  codexIdentityCache.delete(filePath);
  codexIdentityCache.set(filePath, { birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, size: stat.size, identity });
  while (codexIdentityCache.size > CODEX_IDENTITY_CACHE_MAX_ENTRIES) {
    const oldest = codexIdentityCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    codexIdentityCache.delete(oldest);
  }
  return identity;
}

async function readCodexSessionIdentity(filePath: string, size?: number): Promise<CodexSessionIdentity> {
  const { lines } = await readLeadingLines(filePath, {
    maxBytes: 512_000,
    maxLines: 240,
    separator: "\n",
    dropEmpty: false,
    size,
    enough: (read) => {
      const identity = codexIdentityFromLines(read);
      return Boolean(identity.sessionId && identity.cwd);
    },
  });
  return codexIdentityFromLines(lines);
}

function codexIdentityFromLines(lines: readonly string[]): CodexSessionIdentity {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  for (const line of lines) {
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

async function safeReadDirEntries(directory: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
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
