import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";
import { normalizeComparablePath } from "./platform.js";
import { querySqlite, type SqliteValue } from "./sqlite.js";
import { mapWithConcurrency } from "./file-prefix.js";
import { memoizeAsyncWithTtl } from "./ttl-cache.js";
import {
  boundedRecentJsonlFiles,
  claudeProjectPathCandidates,
  readLeadingLines,
  type RecentJsonlFile,
} from "./terminal-restore-policy.js";
import { sessionIndexClient } from "./session-index-client.js";
import type {
  AgentSession,
  AgentSessionProvider,
  HermesIndexDiagnostics,
  HermesIndexedSession,
} from "./session-index-protocol.js";

export type { AgentSession, AgentSessionProvider } from "./session-index-protocol.js";

const CACHE_TTL_MS = 30_000;
const MAX_PROVIDER_ROWS = 1000;
const CODEX_JSONL_SCAN_LIMIT = 400;
const SESSION_FILE_PREFIX_MAX_BYTES = 512_000;
const CLAUDE_SESSION_WINDOW_LINES = 120;
const CODEX_SESSION_WINDOW_LINES = 240;
const SESSION_FILE_SCAN_CONCURRENCY = 8;
// The Codex corpus is workspace-independent; share one listing between the
// workspaces of a request batch without serving a stale listing to the next
// main-process refresh (which has its own 30 s cache).
const CODEX_LISTING_SHARE_MS = 5_000;
const CLAUDE_FILE_CACHE_MAX_ENTRIES = 4000;
const CODEX_FILE_CACHE_MAX_ENTRIES = 2 * CODEX_JSONL_SCAN_LIMIT;
export const AGENT_SESSION_CACHE_MAX_ENTRIES = 32;

export class BoundedTtlPromiseCache<T> {
  readonly #entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer.");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be non-negative.");
  }

  getOrCreate(key: string, factory: () => Promise<T>, now = Date.now()): Promise<T> {
    this.pruneExpired(now);
    const cached = this.#entries.get(key);
    if (cached) {
      // Map insertion order is the LRU order; refresh it on every hit.
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.promise;
    }

    const promise = factory();
    const entry = { expiresAt: now + this.ttlMs, promise };
    this.#entries.set(key, entry);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.#entries.delete(oldest);
    }
    void promise.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return promise;
  }

  get size(): number {
    return this.#entries.size;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

const sessionCache = new BoundedTtlPromiseCache<AgentSession[]>(AGENT_SESSION_CACHE_MAX_ENTRIES, CACHE_TTL_MS);

export function listAgentSessionsCached(workspace: string, liveTerminals: EmbeddedTerminalSession[] = []): Promise<AgentSession[]> {
  const resolvedWorkspace = path.resolve(workspace);
  const promise = sessionCache.getOrCreate(
    resolvedWorkspace,
    () => listHistoricalAgentSessions(resolvedWorkspace),
  );
  return promise.then((sessions) => mergeLiveSessions(sessions, liveTerminals, resolvedWorkspace));
}

export function getAgentSessionScanDiagnostics(): ReturnType<typeof sessionIndexClient.getDiagnostics> {
  return sessionIndexClient.getDiagnostics();
}

let inProcessScanner: AgentSessionScanner | null = null;

/**
 * Native session files and databases are read in the session-index child so
 * JSONL decoding and JSON parsing never run on the Electron main thread. Only
 * when that child cannot answer (and has no earlier answer to reuse) does the
 * main process scan itself, with the same incremental caches.
 */
async function listHistoricalAgentSessions(workspace: string): Promise<AgentSession[]> {
  const remote = await sessionIndexClient.listAgentSessions(workspace);
  if (remote) return remote;
  inProcessScanner ??= new AgentSessionScanner();
  return inProcessScanner.list(workspace, (target) => sessionIndexClient.listHermes(target));
}

function mergeLiveSessions(historical: AgentSession[], liveTerminals: EmbeddedTerminalSession[], workspace: string): AgentSession[] {
  const resolvedWorkspace = path.resolve(workspace);
  const live = liveTerminals
    .filter((session) => isAgentKind(session.kind) && samePath(session.workspace, resolvedWorkspace))
    .map(liveTerminalAgentSession);
  return mergeSessions([...live, ...historical]);
}

export function liveTerminalAgentSession(session: EmbeddedTerminalSession): AgentSession {
  const provider = session.kind as AgentSessionProvider;
  const providerSessionId = session.providerSessionId?.trim();
  return {
    id: providerSessionId || `terminal:${session.id}`,
    provider,
    title: session.title,
    workspace: session.workspace,
    branch: null,
    model: null,
    agent: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    status: session.status === "running" ? "running" : "exited",
    terminalId: session.id,
    pid: session.pid,
    resumeCommand: null,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Incremental scanner
// ---------------------------------------------------------------------------

type FileSignature = { mtimeMs: number; size: number };

/** Parsed per-file metadata keyed by path and validated by (mtime, size). */
export class FileMetadataCache<T> {
  readonly #entries = new Map<string, FileSignature & { value: T }>();

  constructor(readonly maxEntries: number) {}

  get(filePath: string, signature: FileSignature): T | undefined {
    const entry = this.#entries.get(filePath);
    if (!entry || entry.mtimeMs !== signature.mtimeMs || entry.size !== signature.size) return undefined;
    this.#entries.delete(filePath);
    this.#entries.set(filePath, entry);
    return entry.value;
  }

  set(filePath: string, signature: FileSignature, value: T): void {
    this.#entries.delete(filePath);
    this.#entries.set(filePath, { mtimeMs: signature.mtimeMs, size: signature.size, value });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  retainOnly(filePaths: ReadonlySet<string>): void {
    for (const filePath of this.#entries.keys()) {
      if (!filePaths.has(filePath)) this.#entries.delete(filePath);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

export type AgentScanCounters = {
  filesSeen: number;
  filesStatted: number;
  filesParsed: number;
  bytesParsed: number;
  cacheHits: number;
};

export type AgentSessionScannerOptions = {
  homeDir?: string;
  athenaHome?: string;
  queryDatabase?: typeof querySqlite;
  listHermes?: (workspace: string) => Promise<HermesIndexedSession[]>;
  /** How long one Codex directory listing is shared between workspaces. */
  codexListingShareMs?: number;
};

type ClaudeFileMetadata = {
  sessionId: string;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  birthtime: string;
  mtime: string;
};

/**
 * Historical sessions for one workspace across every native provider.
 *
 * Session files are parsed at most once per (path, mtime, size): unchanged
 * files cost one stat. Each file is read only as far as the historical
 * 512 KB / first-N-lines window requires, 32 KiB at a time. Claude history is
 * read only from the workspace's own ~/.claude/projects/<encoded cwd> folder
 * and its descendants' folders instead of the most recent files of every
 * project.
 */
export class AgentSessionScanner {
  private readonly homeDir: string | null;
  private readonly athenaHome: string | null;
  private readonly queryDatabase: typeof querySqlite;
  private readonly listHermesDefault: (workspace: string) => Promise<HermesIndexedSession[]>;
  private readonly claudeFiles = new FileMetadataCache<ClaudeFileMetadata>(CLAUDE_FILE_CACHE_MAX_ENTRIES);
  private readonly codexFiles = new FileMetadataCache<Record<string, string>>(CODEX_FILE_CACHE_MAX_ENTRIES);
  private readonly codexListing: () => Promise<Record<string, string>[]>;
  private readonly counters: AgentScanCounters = { filesSeen: 0, filesStatted: 0, filesParsed: 0, bytesParsed: 0, cacheHits: 0 };

  constructor(options: AgentSessionScannerOptions = {}) {
    this.homeDir = options.homeDir ?? null;
    this.athenaHome = options.athenaHome ?? null;
    this.queryDatabase = options.queryDatabase ?? querySqlite;
    this.listHermesDefault = options.listHermes ?? (async () => []);
    this.codexListing = memoizeAsyncWithTtl(
      Math.max(0, options.codexListingShareMs ?? CODEX_LISTING_SHARE_MS),
      () => this.scanCodexJsonlMetadata(),
    );
  }

  /** Cumulative file counters, for per-request diagnostics deltas. */
  getCounters(): AgentScanCounters {
    return { ...this.counters };
  }

  async list(
    workspace: string,
    listHermes: (workspace: string) => Promise<HermesIndexedSession[]> = this.listHermesDefault,
  ): Promise<AgentSession[]> {
    const resolvedWorkspace = path.resolve(workspace);
    const [codex, opencode, athena, claude, hermes, grok] = await Promise.all([
      this.readCodexSessions(resolvedWorkspace),
      this.readOpenCodeSessions(resolvedWorkspace),
      this.readAthenaSessions(resolvedWorkspace),
      this.readClaudeSessions(resolvedWorkspace),
      readHermesSessions(resolvedWorkspace, listHermes),
      this.readGrokSessions(resolvedWorkspace),
    ]);
    return mergeSessions([...codex, ...opencode, ...athena, ...claude, ...hermes, ...grok]);
  }

  private home(): string {
    return this.homeDir ?? os.homedir();
  }

  private async readCodexSessions(workspace: string): Promise<AgentSession[]> {
    const jsonlMetadata = await this.readCodexJsonlMetadata(workspace);
    const dbPath = path.join(this.home(), ".codex", "state_5.sqlite");
    const sessions: AgentSession[] = [];
    const seenIds = new Set<string>();

    if (fs.existsSync(dbPath)) {
      const workspaceFilter = workspaceSqlFilter("cwd", workspace);
      const rows = await this.queryDatabase(dbPath, [
        "select id, cwd, title, created_at_ms, updated_at_ms, git_branch, cli_version, first_user_message, model, agent_role",
        "from threads",
        `where ${workspaceFilter.sql}`,
        "order by updated_at_ms desc",
        `limit ${MAX_PROVIDER_ROWS}`,
      ].join(" "), workspaceFilter.params);
      for (const row of rows) {
        const id = stringValue(row[0]);
        if (!id) continue;
        const sessionWorkspace = stringValue(row[1]) || workspace;
        if (!sameOrDescendantPath(sessionWorkspace, workspace)) continue;
        const metadata = jsonlMetadata.get(id) ?? {};
        const cliVersion = nullableString(row[6]) ?? metadata.cli_version;
        const enriched = cliVersion ? { ...metadata, cli_version: cliVersion } : metadata;
        sessions.push({
          id,
          provider: "codex",
          title: cleanSessionTitle(stringValue(row[2]) || stringValue(row[7]) || metadata.first_user_message || null) || "Codex session",
          workspace: sessionWorkspace,
          branch: nullableString(row[5]) ?? metadata.git_branch ?? null,
          model: nullableString(row[8]) ?? metadata.model ?? null,
          agent: nullableString(row[9]) ?? metadata.personality ?? null,
          createdAt: metadata.created_at ?? fromEpoch(row[3]),
          updatedAt: latestIso(metadata.updated_at, fromEpoch(row[4])),
          status: "historical",
          terminalId: null,
          pid: null,
          resumeCommand: `codex resume --cd ${quoteShellArg(workspace)} ${quoteShellArg(id)}`,
          metadata: enriched,
        });
        seenIds.add(id);
      }
    }

    for (const [id, metadata] of jsonlMetadata) {
      if (seenIds.has(id)) continue;
      sessions.push({
        id,
        provider: "codex",
        title: cleanSessionTitle(metadata.first_user_message ?? null) || "Codex session",
        workspace: metadata.cwd || workspace,
        branch: metadata.git_branch ?? null,
        model: metadata.model ?? null,
        agent: metadata.personality ?? null,
        createdAt: metadata.created_at ?? new Date(0).toISOString(),
        updatedAt: metadata.updated_at ?? metadata.created_at ?? new Date(0).toISOString(),
        status: "historical",
        terminalId: null,
        pid: null,
        resumeCommand: `codex resume --cd ${quoteShellArg(workspace)} ${quoteShellArg(id)}`,
        metadata,
      });
    }

    return sessions;
  }

  private async readCodexJsonlMetadata(workspace: string): Promise<Map<string, Record<string, string>>> {
    const byId = new Map<string, Record<string, string>>();
    const results = await this.codexListing();
    for (const metadata of results) {
      const id = metadata.session_id;
      const cwd = metadata.cwd;
      if (!id || !cwd || !sameOrDescendantPath(cwd, workspace)) continue;
      byId.set(id, metadata);
    }
    return byId;
  }

  private async scanCodexJsonlMetadata(): Promise<Record<string, string>[]> {
    const sessionsDir = path.join(this.home(), ".codex", "sessions");
    if (!fs.existsSync(sessionsDir)) return [];
    const files = await boundedRecentJsonlFiles(sessionsDir, CODEX_JSONL_SCAN_LIMIT);
    this.counters.filesSeen += files.length;
    this.counters.filesStatted += files.length;
    const results = await mapWithConcurrency(files, SESSION_FILE_SCAN_CONCURRENCY, (file) => this.codexFileMetadata(file));
    this.codexFiles.retainOnly(new Set(files.map((file) => file.filePath)));
    return results;
  }

  private async codexFileMetadata(file: RecentJsonlFile): Promise<Record<string, string>> {
    const signature = file.stat && file.stat.isFile() ? { mtimeMs: file.stat.mtimeMs, size: file.stat.size } : null;
    if (signature) {
      const cached = this.codexFiles.get(file.filePath, signature);
      if (cached) {
        this.counters.cacheHits += 1;
        return cached;
      }
    }
    const metadata: Record<string, string> = { jsonl_path: file.filePath };
    let lines: string[];
    try {
      const read = await readLeadingLines(file.filePath, {
        maxBytes: SESSION_FILE_PREFIX_MAX_BYTES,
        maxLines: CODEX_SESSION_WINDOW_LINES,
        separator: /\r?\n/,
        dropEmpty: true,
        size: signature?.size,
      });
      lines = read.lines;
      this.counters.filesParsed += 1;
      this.counters.bytesParsed += read.bytesRead;
    } catch {
      return metadata;
    }
    for (const line of lines) {
      const entry = parseJsonObject(line);
      if (!entry) continue;
      const timestamp = stringProperty(entry, "timestamp");
      if (timestamp) {
        metadata.created_at ??= timestamp;
        metadata.updated_at = timestamp;
      }
      const entryType = stringProperty(entry, "type");
      const payload = objectProperty(entry, "payload");
      if (entryType === "session_meta") mergeCodexSessionMeta(metadata, payload);
      else if (entryType === "turn_context") mergeCodexTurnContext(metadata, payload);
      else if (entryType === "event_msg" && !metadata.first_user_message) {
        const messageType = stringProperty(payload, "type");
        const message = stringProperty(payload, "message");
        if (messageType === "user_message" && message) metadata.first_user_message = message;
      }
    }
    if (signature) this.codexFiles.set(file.filePath, signature, metadata);
    return metadata;
  }

  private async readOpenCodeSessions(workspace: string): Promise<AgentSession[]> {
    const dbPath = path.join(this.home(), ".local", "share", "opencode", "opencode.db");
    if (!fs.existsSync(dbPath)) return [];
    const workspaceFilter = workspaceSqlFilter("coalesce(s.directory, p.worktree)", workspace);
    const rows = await this.queryDatabase(dbPath, [
      "select s.id, coalesce(s.directory, p.worktree), s.title, s.time_created, s.time_updated, s.agent, s.model, p.worktree",
      "from session s",
      "left join project p on s.project_id = p.id",
      `where ${workspaceFilter.sql}`,
      "order by s.time_updated desc",
      `limit ${MAX_PROVIDER_ROWS}`,
    ].join(" "), workspaceFilter.params);
    return rows.filter((row) => sameOrDescendantPath(stringValue(row[1]) || stringValue(row[7]) || workspace, workspace)).map((row): AgentSession => {
      const id = stringValue(row[0]);
      const model = parseOpenCodeModel(nullableString(row[6]));
      return {
        id,
        provider: "opencode",
        title: cleanSessionTitle(stringValue(row[2])) || "OpenCode session",
        workspace: stringValue(row[1]) || stringValue(row[7]) || workspace,
        branch: null,
        model,
        agent: nullableString(row[5]),
        createdAt: fromEpoch(row[3]),
        updatedAt: fromEpoch(row[4]),
        status: "historical",
        terminalId: null,
        pid: null,
        resumeCommand: id ? `opencode ${quoteShellArg(workspace)} --session ${quoteShellArg(id)}` : null,
        metadata: {},
      };
    }).filter((session) => Boolean(session.id));
  }

  private async readAthenaSessions(workspace: string): Promise<AgentSession[]> {
    const athenaHome = this.athenaHome ?? (process.env.ATHENA_CODE_HOME || path.join(this.home(), ".athena-code"));
    const dbPath = path.join(athenaHome, "context", "sessions.db");
    if (!fs.existsSync(dbPath) || !await sqliteUserVersion(this.queryDatabase, dbPath, 2)) return [];
    const workspaceFilter = workspaceSqlFilter("m.workspace", workspace);
    const rows = await this.queryDatabase(dbPath, [
      "select m.session_id, m.workspace,",
      "(select text from messages first_user where first_user.agent = 'athena'",
      "and first_user.session_id = m.session_id and first_user.workspace = m.workspace",
      "and first_user.role = 'user' order by first_user.id asc limit 1),",
      "min(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end),",
      "max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end), count(*)",
      "from messages m",
      `where m.agent = 'athena' and ${workspaceFilter.sql}`,
      "group by m.session_id, m.workspace",
      "order by (max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end) is null),",
      "max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end) desc, max(id) desc",
      `limit ${MAX_PROVIDER_ROWS}`,
    ].join(" "), workspaceFilter.params);
    return rows.filter((row) => sameOrDescendantPath(stringValue(row[1]) || workspace, workspace)).map((row): AgentSession => {
      const id = stringValue(row[0]);
      const sessionWorkspace = stringValue(row[1]) || workspace;
      const createdAt = nullableString(row[3]) ?? new Date(0).toISOString();
      const updatedAt = nullableString(row[4]) ?? createdAt;
      return {
        id,
        provider: "athena",
        title: cleanSessionTitle(nullableString(row[2])) || "Athena Code session",
        workspace: sessionWorkspace,
        branch: null,
        model: null,
        agent: "Athena Code",
        createdAt,
        updatedAt,
        status: "historical",
        terminalId: null,
        pid: null,
        resumeCommand: id ? `athena-code --session ${quoteShellArg(id)} ${quoteShellArg(sessionWorkspace)}` : null,
        metadata: { turns: stringValue(row[5]) },
      };
    }).filter((session) => Boolean(session.id));
  }

  // Grok Build stores one directory per session at
  // ~/.grok/sessions/<urlencoded-cwd>/<session-id>/, each holding summary.json
  // (id, cwd, created/updated, model) and chat_history.jsonl (messages). There is
  // no shared database to query, so we enumerate the session dirs whose decoded cwd
  // is the workspace or a descendant and read each summary.
  private async readGrokSessions(workspace: string): Promise<AgentSession[]> {
    const sessionsRoot = path.join(this.home(), ".grok", "sessions");
    let cwdDirs: fs.Dirent[];
    try {
      cwdDirs = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions: AgentSession[] = [];
    for (const cwdDir of cwdDirs) {
      if (!cwdDir.isDirectory()) continue;
      const decodedCwd = decodeGrokCwd(cwdDir.name);
      if (!decodedCwd || !sameOrDescendantPath(decodedCwd, workspace)) continue;
      const cwdPath = path.join(sessionsRoot, cwdDir.name);
      let sessionDirs: fs.Dirent[];
      try {
        sessionDirs = await fs.promises.readdir(cwdPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        const session = await readGrokSession(path.join(cwdPath, sessionDir.name), sessionDir.name, decodedCwd);
        if (session) sessions.push(session);
        if (sessions.length >= MAX_PROVIDER_ROWS) return sessions;
      }
    }
    return sessions;
  }

  private async readClaudeSessions(workspace: string): Promise<AgentSession[]> {
    const projectsDir = path.join(this.home(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return [];
    const sessions: AgentSession[] = [];
    const seenFiles = new Set<string>();
    for (const { dir, allowMissingCwd } of await claudeProjectDirsForWorkspace(projectsDir, workspace)) {
      const names = (await safeReadDir(dir)).filter((name) => name.endsWith(".jsonl"));
      const candidateFiles = names
        .map((name) => path.join(dir, name))
        .filter((filePath) => {
          if (seenFiles.has(filePath)) return false;
          seenFiles.add(filePath);
          return true;
        });
      this.counters.filesSeen += candidateFiles.length;
      const results = await mapWithConcurrency(
        candidateFiles,
        SESSION_FILE_SCAN_CONCURRENCY,
        async (filePath) => {
          const metadata = await this.claudeFileMetadata(filePath);
          return metadata ? claudeSessionForWorkspace(metadata, workspace, allowMissingCwd) : null;
        },
      );
      sessions.push(...results.filter((session): session is AgentSession => session !== null));
    }
    return sessions
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 50);
  }

  private async claudeFileMetadata(filePath: string): Promise<ClaudeFileMetadata | null> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    this.counters.filesStatted += 1;
    if (!stat.isFile()) return null;
    const signature = { mtimeMs: stat.mtimeMs, size: stat.size };
    const cached = this.claudeFiles.get(filePath, signature);
    if (cached) {
      this.counters.cacheHits += 1;
      return cached;
    }
    let lines: string[];
    try {
      const read = await readLeadingLines(filePath, {
        maxBytes: SESSION_FILE_PREFIX_MAX_BYTES,
        maxLines: CLAUDE_SESSION_WINDOW_LINES,
        separator: "\n",
        dropEmpty: true,
        size: stat.size,
      });
      lines = read.lines;
      this.counters.filesParsed += 1;
      this.counters.bytesParsed += read.bytesRead;
    } catch {
      return null;
    }
    const metadata = parseClaudeSessionLines(lines, path.basename(filePath, ".jsonl"), stat);
    this.claudeFiles.set(filePath, signature, metadata);
    return metadata;
  }
}

type ClaudeProjectDir = { dir: string; allowMissingCwd: boolean };

/**
 * The ~/.claude/projects folders that can hold sessions for a workspace:
 * the workspace's own folder(s) (current and legacy encodings), whose files
 * may omit cwd, plus folders whose encoded name extends the workspace's —
 * the only place descendant-cwd sessions can live. Descendant candidates must
 * prove membership through their recorded cwd, because the encoding maps
 * every separator and punctuation character to "-" and is therefore
 * ambiguous ("a/b" and "a-b" encode alike).
 */
export async function claudeProjectDirsForWorkspace(projectsDir: string, workspace: string): Promise<ClaudeProjectDir[]> {
  const exactDirs = claudeProjectPathCandidates(projectsDir, workspace);
  const result: ClaudeProjectDir[] = [];
  const exactNames = new Set<string>();
  for (const dir of exactDirs) {
    exactNames.add(path.basename(dir).toLowerCase());
    try {
      if ((await fs.promises.stat(dir)).isDirectory()) result.push({ dir, allowMissingCwd: true });
    } catch {
      // No sessions under this encoding.
    }
  }
  const prefixes = Array.from(exactNames, (name) => (name.endsWith("-") ? name : `${name}-`));
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (exactNames.has(name)) continue;
    if (prefixes.some((prefix) => name.startsWith(prefix))) {
      result.push({ dir: path.join(projectsDir, entry.name), allowMissingCwd: false });
    }
  }
  return result;
}

function parseClaudeSessionLines(lines: readonly string[], fallbackSessionId: string, stat: fs.Stats): ClaudeFileMetadata {
  let sessionId = fallbackSessionId;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let model: string | null = null;
  let title: string | null = null;

  for (const line of lines) {
    const entry = parseJsonObject(line);
    if (!entry) continue;
    sessionId = stringProperty(entry, "sessionId") || sessionId;
    cwd = stringProperty(entry, "cwd") || cwd;
    branch = stringProperty(entry, "gitBranch") || branch;
    const timestamp = stringProperty(entry, "timestamp");
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }
    const message = objectProperty(entry, "message");
    model = stringProperty(message, "model") || model;
    if (!title && stringProperty(message, "role") === "user") {
      title = cleanSessionTitle(stringProperty(message, "content"));
    }
  }
  return {
    sessionId,
    cwd,
    branch,
    model,
    title,
    createdAt,
    updatedAt,
    birthtime: stat.birthtime.toISOString(),
    mtime: stat.mtime.toISOString(),
  };
}

function claudeSessionForWorkspace(metadata: ClaudeFileMetadata, workspace: string, allowMissingCwd: boolean): AgentSession | null {
  if (metadata.cwd) {
    if (!sameOrDescendantPath(metadata.cwd, workspace)) return null;
  } else if (!allowMissingCwd) {
    return null;
  }
  return {
    id: metadata.sessionId,
    provider: "claude",
    title: metadata.title || "Claude Code session",
    workspace: metadata.cwd || workspace,
    branch: metadata.branch,
    model: metadata.model,
    agent: null,
    createdAt: metadata.createdAt || metadata.birthtime,
    updatedAt: metadata.updatedAt || metadata.mtime,
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: `claude --resume ${quoteShellArg(metadata.sessionId)}`,
    metadata: {},
  };
}

function mergeCodexSessionMeta(metadata: Record<string, string>, payload: Record<string, unknown> | null): void {
  copyStringFields(metadata, payload, {
    id: "session_id",
    cwd: "cwd",
    cli_version: "cli_version",
    model_provider: "model_provider",
    originator: "originator",
    source: "source",
    thread_source: "thread_source",
    timestamp: "created_at",
  });
  const baseText = stringProperty(objectProperty(payload, "base_instructions"), "text");
  if (baseText) metadata.system_prompt_excerpt = boundedUtf8(baseText, 4096);
}

function mergeCodexTurnContext(metadata: Record<string, string>, payload: Record<string, unknown> | null): void {
  copyStringFields(metadata, payload, {
    cwd: "cwd",
    model: "model",
    personality: "personality",
    approval_policy: "approval_policy",
    timezone: "timezone",
    current_date: "current_date",
  });
  const sandboxType = stringProperty(objectProperty(payload, "sandbox_policy"), "type");
  if (sandboxType) metadata.sandbox_policy = sandboxType;
  const collaborationMode = stringProperty(objectProperty(payload, "collaboration_mode"), "mode");
  if (collaborationMode) metadata.collaboration_mode = collaborationMode;
  copyStringFields(metadata, objectProperty(payload, "git"), {
    branch: "git_branch",
    commit_hash: "git_commit_hash",
    commit: "git_commit_hash",
  });
}

function copyStringFields(metadata: Record<string, string>, source: Record<string, unknown> | null, mapping: Record<string, string>): void {
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    const value = stringProperty(source, sourceKey);
    if (value) metadata[targetKey] = value;
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

async function readGrokSession(sessionPath: string, dirName: string, fallbackWorkspace: string): Promise<AgentSession | null> {
  const summary = parseJsonObject(await readFileSafe(path.join(sessionPath, "summary.json")));
  const info = objectProperty(summary, "info");
  const id = stringProperty(info, "id") ?? dirName;
  if (!id) return null;
  const sessionWorkspace = stringProperty(info, "cwd") ?? fallbackWorkspace;
  const createdAt = stringProperty(summary, "created_at") ?? new Date(0).toISOString();
  const updatedAt = stringProperty(summary, "updated_at") ?? createdAt;
  const summaryTitle = stringProperty(summary, "session_summary");
  const title = cleanSessionTitle(summaryTitle ?? await firstGrokUserMessage(path.join(sessionPath, "chat_history.jsonl"))) || "Grok session";
  return {
    id,
    provider: "grok",
    title,
    workspace: sessionWorkspace,
    branch: null,
    model: stringProperty(summary, "current_model_id"),
    agent: "Grok",
    createdAt,
    updatedAt,
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: `grok --cwd ${quoteShellArg(sessionWorkspace)} -r ${quoteShellArg(id)}`,
    metadata: {},
  };
}

function decodeGrokCwd(dirName: string): string | null {
  try {
    return decodeURIComponent(dirName);
  } catch {
    return null;
  }
}

async function firstGrokUserMessage(historyPath: string): Promise<string | null> {
  let lines: string[];
  try {
    ({ lines } = await readLeadingLines(historyPath, {
      maxBytes: SESSION_FILE_PREFIX_MAX_BYTES,
      maxLines: Number.POSITIVE_INFINITY,
      separator: /\r?\n/,
      dropEmpty: false,
      enough: (read) => firstGrokUserMessageFromLines(read) !== null,
    }));
  } catch {
    return null;
  }
  return firstGrokUserMessageFromLines(lines);
}

function firstGrokUserMessageFromLines(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseJsonObject(line);
    // Skip injected system-reminders, which Grok records as synthetic user turns.
    if (!entry || entry.type !== "user" || "synthetic_reason" in entry) continue;
    const content = entry.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block && typeof block === "object" ? stringProperty(block as Record<string, unknown>, "text") ?? "" : "")).join(" ")
        : "";
    if (text.trim()) return text;
  }
  return null;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readHermesSessions(
  workspace: string,
  listHermes: (workspace: string) => Promise<HermesIndexedSession[]>,
): Promise<AgentSession[]> {
  let indexed: HermesIndexedSession[];
  try {
    indexed = await listHermes(workspace);
  } catch {
    indexed = [];
  }
  return indexed.map((session): AgentSession => ({
    ...session,
    provider: "hermes",
    workspace,
    branch: null,
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: `hermes --resume ${quoteShellArg(session.id)}`,
    metadata: {},
  }));
}

/** Combine scan counters with the Hermes index's view for one request. */
export function combineScanDiagnostics(
  before: AgentScanCounters,
  after: AgentScanCounters,
  durationMs: number,
  hermes: HermesIndexDiagnostics | null,
  lastError: string | null = null,
): HermesIndexDiagnostics {
  return {
    filesSeen: after.filesSeen - before.filesSeen + (hermes?.filesSeen ?? 0),
    filesStatted: after.filesStatted - before.filesStatted + (hermes?.filesStatted ?? 0),
    filesParsed: after.filesParsed - before.filesParsed + (hermes?.filesParsed ?? 0),
    bytesParsed: after.bytesParsed - before.bytesParsed + (hermes?.bytesParsed ?? 0),
    cacheHits: after.cacheHits - before.cacheHits + (hermes?.cacheHits ?? 0),
    durationMs,
    lastError: lastError ?? hermes?.lastError ?? null,
  };
}

const warnedSessionIndexes = new Set<string>();

async function sqliteUserVersion(queryDatabase: typeof querySqlite, dbPath: string, minimum: number): Promise<boolean> {
  const rows = await queryDatabase(dbPath, "pragma user_version", []);
  const version = rows[0]?.[0];
  if (typeof version === "number" && version >= minimum) return true;
  if (!warnedSessionIndexes.has(dbPath)) {
    warnedSessionIndexes.add(dbPath);
    console.warn(`Skipping agent session index ${dbPath}: sqlite user_version ${String(version)} is below ${minimum}.`);
  }
  return false;
}

function mergeSessions(sessions: AgentSession[]): AgentSession[] {
  const byKey = new Map<string, AgentSession>();
  for (const session of sessions) {
    const key = `${session.provider}:${session.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, session);
      continue;
    }
    if (session.status === "running") {
      byKey.set(key, {
        ...existing,
        ...session,
        title: existing.title || session.title,
        branch: existing.branch ?? session.branch,
        model: existing.model ?? session.model,
        agent: existing.agent ?? session.agent,
        resumeCommand: existing.resumeCommand ?? session.resumeCommand,
        status: "running",
        terminalId: session.terminalId,
        pid: session.pid,
        updatedAt: session.updatedAt,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    })
    .slice(0, 100);
}

function isAgentKind(kind: string): kind is AgentSessionProvider {
  return kind === "codex" || kind === "opencode" || kind === "athena" || kind === "claude" || kind === "hermes" || kind === "grok";
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

export function sameOrDescendantPath(candidate: string, workspace: string): boolean {
  const child = normalizeComparablePath(candidate);
  const parent = normalizeComparablePath(workspace);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Apply workspace narrowing before a provider's ORDER/LIMIT. The final
 * sameOrDescendantPath check remains in JS as a correctness guard, while this
 * SQL predicate prevents a busy unrelated workspace from consuming the global
 * row budget first. Native Windows and WSL spellings are both included.
 */
export function workspaceSqlFilter(columnExpression: string, workspace: string): { sql: string; params: string[] } {
  const slashedExpression = `replace(trim(coalesce(${columnExpression}, '')), char(92), '/')`;
  const sensitiveExpression = `rtrim(${slashedExpression}, '/')`;
  const insensitiveExpression = `lower(${sensitiveExpression})`;
  const candidates = sqlWorkspaceCandidates(workspace);
  const clauses: string[] = [];
  const params: string[] = [];
  for (const candidate of candidates) {
    const expression = candidate.caseInsensitive ? insensitiveExpression : sensitiveExpression;
    if (candidate.value === "/") {
      // rtrim('/') is empty, so root must inspect the untrimmed spelling.
      clauses.push(`substr(${slashedExpression}, 1, 1) = '/'`);
      continue;
    }
    clauses.push(`(${expression} = ? or substr(${expression}, 1, length(?) + 1) = ? || '/')`);
    params.push(candidate.value, candidate.value, candidate.value);
  }
  return { sql: clauses.length > 0 ? `(${clauses.join(" or ")})` : "0", params };
}

function sqlWorkspaceCandidates(workspace: string): Array<{ value: string; caseInsensitive: boolean }> {
  const direct = workspace.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const comparable = normalizeComparablePath(workspace) || "/";
  const candidates = new Map<string, { value: string; caseInsensitive: boolean }>();
  const add = (value: string, caseInsensitive: boolean): void => {
    const normalized = caseInsensitive ? value.toLowerCase() : value;
    candidates.set(`${caseInsensitive ? "i" : "s"}:${normalized}`, { value: normalized, caseInsensitive });
  };
  add(direct, isCaseInsensitiveSqlPath(direct));
  add(comparable, isCaseInsensitiveSqlPath(comparable));
  const drive = /^([a-z]):(?:\/(.*))?$/i.exec(comparable);
  if (drive) add(`/mnt/${drive[1].toLowerCase()}${drive[2] ? `/${drive[2]}` : ""}`, true);
  return Array.from(candidates.values());
}

function isCaseInsensitiveSqlPath(value: string): boolean {
  return /^[a-z]:(?:\/|$)/i.test(value)
    || /^\/mnt\/[a-z](?:\/|$)/i.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value);
}

function fromEpoch(value: SqliteValue): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return new Date(0).toISOString();
  return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
}

function latestIso(left: string | undefined, right: string): string {
  if (!left) return right;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function parseOpenCodeModel(value: string | null): string | null {
  if (!value) return null;
  const parsed = parseJsonObject(value);
  const id = stringProperty(parsed, "id");
  const provider = stringProperty(parsed, "providerID");
  if (provider && id) return `${provider}/${id}`;
  return id || value;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
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
  return typeof item === "string" && item.trim() ? item : null;
}

function nullableString(value: SqliteValue): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringValue(value: SqliteValue): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function firstLine(value: string | null): string {
  return (value ?? "").split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 120) ?? "";
}

function cleanSessionTitle(value: string | null): string {
  const text = value ?? "";
  const pane = text.match(/^Pane:\s*(.+)$/m)?.[1]?.trim();
  if (pane) return pane.slice(0, 120);
  const agent = text.match(/^Agent:\s*(.+)$/m)?.[1]?.trim();
  if (agent) return `${agent} session`.slice(0, 120);
  return firstLine(text);
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}
