import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeComparablePath } from "./platform.js";
import { querySqlite, type SqliteValue } from "./sqlite.js";
import type { HermesIndexDiagnostics, HermesIndexedSession } from "./session-index-protocol.js";

const execFileAsync = promisify(execFile);
const INDEX_VERSION = 2;
const MAX_RESULTS_PER_WORKSPACE = 100;
const SEARCH_CHARACTER_BUDGET = 300_000;
const MAX_WORKSPACE_HINT_BYTES = 16_384;
const MAX_WORKSPACE_HINT_LENGTH = 512;

type HermesManifestEntry = {
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  platform: string | null;
  chatType: string | null;
};

type HermesSessionFileMetadata = {
  title: string | null;
  model: string | null;
  platform: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  workspace: string | null;
};

type HermesDatabaseRow = {
  id: string;
  source: string | null;
  model: string | null;
  startedAt: SqliteValue;
  endedAt: SqliteValue;
  title: string | null;
};

type CachedHermesFile = {
  filePath: string;
  mtimeMs: number;
  size: number;
  birthtime: string;
  metadata: HermesSessionFileMetadata;
  workspaceHints: string[];
};

type PersistedIndex = {
  version: number;
  hermesDir: string;
  entries: CachedHermesFile[];
};

type WorkspaceQuery = {
  workspace: string;
  key: string;
  needles: string[];
};

export type HermesSessionIndexOptions = {
  cachePath?: string;
  queryDatabase?: typeof querySqlite;
  readSessionFile?: (filePath: string) => Promise<string>;
  readCacheFile?: (filePath: string) => Promise<string>;
};

/**
 * Incremental Hermes metadata index.
 *
 * The large session JSON documents are parsed only in the session-index child,
 * only when their (mtime,size) signature changes or a previously unseen
 * workspace needs to be classified. The cache retains metadata and exact
 * workspace match decisions, never transcript/search text or parsed messages.
 */
export class HermesSessionIndex {
  private readonly cachePath: string;
  private readonly queryDatabase: typeof querySqlite;
  private readonly readSessionFile: (filePath: string) => Promise<string>;
  private readonly readCacheFile: (filePath: string) => Promise<string>;
  private entries = new Map<string, CachedHermesFile>();
  private loadedForDir: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private lastDatabaseRows = new Map<string, HermesDatabaseRow>();
  private refreshPromise: Promise<void> | null = null;
  private diagnostics: HermesIndexDiagnostics = emptyDiagnostics();

  constructor(options: HermesSessionIndexOptions = {}) {
    this.cachePath = options.cachePath ?? path.join(os.homedir(), ".context-workspace", "hermes-session-index-v2.json");
    this.queryDatabase = options.queryDatabase ?? querySqlite;
    this.readSessionFile = options.readSessionFile ?? ((filePath) => fs.promises.readFile(filePath, "utf8"));
    this.readCacheFile = options.readCacheFile ?? ((filePath) => fs.promises.readFile(filePath, "utf8"));
  }

  async list(workspaces: string[], hermesDirOverride?: string | null): Promise<Record<string, HermesIndexedSession[]>> {
    const uniqueQueries = uniqueWorkspaceQueries(workspaces);
    const result: Record<string, HermesIndexedSession[]> = Object.fromEntries(uniqueQueries.map((query) => [query.workspace, []]));
    if (uniqueQueries.length === 0) return result;

    const hermesDir = hermesDirOverride === undefined ? await resolveHermesDir() : hermesDirOverride;
    if (!hermesDir) return result;
    await this.loadPersistedIndex(hermesDir);
    await this.refresh(hermesDir);

    const manifest = await readHermesManifest(path.join(hermesDir, "sessions", "sessions.json"));
    for (const query of uniqueQueries) {
      const sessions: HermesIndexedSession[] = [];
      const ids = new Set([...this.lastDatabaseRows.keys(), ...this.entries.keys()]);
      for (const id of ids) {
        const file = this.entries.get(id);
        const row = this.lastDatabaseRows.get(id);
        const manifestEntry = manifest.get(id);
        if (!matchesWorkspace(file, manifestEntry, query)) continue;
        const session = indexedSession(id, file, row, manifestEntry);
        if (session) sessions.push(session);
      }
      result[query.workspace] = sessions
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_RESULTS_PER_WORKSPACE);
    }
    return result;
  }

  getDiagnostics(): HermesIndexDiagnostics {
    return { ...this.diagnostics };
  }

  private async refresh(hermesDir: string): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    const promise = this.refreshNow(hermesDir);
    this.refreshPromise = promise;
    try {
      await promise;
    } catch (error) {
      this.diagnostics = {
        ...emptyDiagnostics(),
        lastError: `Hermes session index refresh failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240),
      };
      throw error;
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    }
  }

  private async refreshNow(hermesDir: string): Promise<void> {
    const startedAt = Date.now();
    const diagnostics = emptyDiagnostics();
    const sessionsDir = path.join(hermesDir, "sessions");
    let dirty = false;
    const databaseRows = await this.readDatabaseRows(path.join(hermesDir, "state.db"));
    if (databaseRows.size > 0 || this.lastDatabaseRows.size === 0) this.lastDatabaseRows = databaseRows;

    const names = await safeReadDir(sessionsDir);
    const fileIds = new Map<string, string>();
    for (const name of names) {
      const match = /^session_(.+)\.json$/.exec(name);
      if (match) fileIds.set(match[1], path.join(sessionsDir, name));
    }
    diagnostics.filesSeen = fileIds.size;
    // Database-only rows are kept for display metadata, but only session files
    // can prove workspace membership. Conversely, file-only sessions remain
    // discoverable even when state.db is absent, locked, or behind the files.
    const currentIds = new Set(fileIds.keys());
    for (const id of this.entries.keys()) {
      if (!currentIds.has(id)) {
        this.entries.delete(id);
        dirty = true;
      }
    }

    for (const [id, filePath] of fileIds) {
      diagnostics.filesStatted += 1;
      const stat = await safeStat(filePath);
      if (!stat) continue;
      const cached = this.entries.get(id);
      const signatureChanged = !cached || cached.filePath !== filePath || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size;
      if (!signatureChanged) {
        diagnostics.cacheHits += 1;
        continue;
      }

      diagnostics.filesParsed += 1;
      const parsed = await parseHermesSessionFile(filePath, this.readSessionFile, (bytes) => {
        diagnostics.bytesParsed += bytes;
      });
      if (!parsed) {
        diagnostics.lastError = "One or more changed Hermes session files could not be parsed; retained last-known-good metadata.";
        continue;
      }
      this.entries.set(id, {
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        birthtime: stat.birthtime.toISOString(),
        metadata: parsed.metadata,
        workspaceHints: parsed.workspaceHints,
      });
      dirty = true;
    }
    if (dirty && !(await this.persist(hermesDir))) {
      diagnostics.lastError = diagnostics.lastError
        ?? "Hermes session metadata was indexed, but the persistent cache could not be updated.";
    }
    diagnostics.durationMs = Date.now() - startedAt;
    this.diagnostics = diagnostics;
  }

  private async readDatabaseRows(dbPath: string): Promise<Map<string, HermesDatabaseRow>> {
    if (!fs.existsSync(dbPath)) return new Map();
    const rows = await this.queryDatabase(dbPath, [
      "select id, source, model, started_at, ended_at, message_count, title",
      "from sessions",
      "order by coalesce(ended_at, started_at) desc",
    ].join(" "), []);
    const result = new Map<string, HermesDatabaseRow>();
    for (const row of rows) {
      const id = stringValue(row[0]);
      if (!id) continue;
      result.set(id, {
        id,
        source: nullableString(row[1]),
        model: nullableString(row[2]),
        startedAt: row[3] ?? null,
        endedAt: row[4] ?? null,
        title: nullableString(row[6]),
      });
    }
    return result;
  }

  private async loadPersistedIndex(hermesDir: string): Promise<void> {
    if (this.loadedForDir === hermesDir) return;
    while (this.loadPromise) {
      await this.loadPromise;
      if (this.loadedForDir === hermesDir) return;
    }
    const promise = this.loadPersistedIndexNow(hermesDir);
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) this.loadPromise = null;
    }
  }

  private async loadPersistedIndexNow(hermesDir: string): Promise<void> {
    const nextEntries = new Map<string, CachedHermesFile>();
    const parsed = await readJsonObject(this.cachePath, this.readCacheFile);
    if (parsed?.version === INDEX_VERSION && parsed.hermesDir === hermesDir && Array.isArray(parsed.entries)) {
      for (const value of parsed.entries) {
        if (!isCachedHermesFile(value)) continue;
        const id = sessionIdFromFile(value.filePath);
        if (id) nextEntries.set(id, value);
      }
    }
    this.entries = nextEntries;
    this.lastDatabaseRows = new Map();
    // Publish the directory only after its complete cache snapshot is ready.
    // Concurrent list() calls then either join this load or observe all of it;
    // none can refresh an empty map that is later overwritten by stale data.
    this.loadedForDir = hermesDir;
  }

  private async persist(hermesDir: string): Promise<boolean> {
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      hermesDir,
      entries: Array.from(this.entries.values()),
    };
    const directory = path.dirname(this.cachePath);
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      try {
        await fs.promises.rename(temporary, this.cachePath);
      } catch {
        // Windows does not consistently replace an existing destination with
        // rename(). The cache is reconstructible, so a brief remove/rename
        // fallback is safer than retaining a permanently stale index.
        await fs.promises.unlink(this.cachePath).catch(() => undefined);
        await fs.promises.rename(temporary, this.cachePath);
      }
      return true;
    } catch {
      await fs.promises.unlink(temporary).catch(() => undefined);
      return false;
    }
  }
}

async function parseHermesSessionFile(
  filePath: string,
  readSessionFile: (filePath: string) => Promise<string>,
  onRead: (bytes: number) => void,
): Promise<{
  metadata: HermesSessionFileMetadata;
  workspaceHints: string[];
} | null> {
  let parsed: Record<string, unknown> | null;
  try {
    const raw = await readSessionFile(filePath);
    onRead(Buffer.byteLength(raw, "utf8"));
    parsed = parseJsonObject(raw);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const metadata: HermesSessionFileMetadata = {
    title: firstHermesUserMessage(parsed),
    model: stringProperty(parsed, "model"),
    platform: stringProperty(parsed, "platform"),
    createdAt: stringProperty(parsed, "session_start"),
    updatedAt: stringProperty(parsed, "last_updated"),
    workspace: hermesWorkspace(parsed),
  };
  return {
    metadata,
    workspaceHints: collectWorkspaceHints(parsed),
  };
}

function emptyDiagnostics(): HermesIndexDiagnostics {
  return {
    filesSeen: 0,
    filesStatted: 0,
    filesParsed: 0,
    bytesParsed: 0,
    cacheHits: 0,
    durationMs: 0,
    lastError: null,
  };
}

function collectWorkspaceHints(session: Record<string, unknown>): string[] {
  const hints = new Set<string>();
  let hintBytes = 0;
  let consumed = 0;
  const stack: unknown[] = [session];
  const addHint = (value: string): void => {
    if (hintBytes >= MAX_WORKSPACE_HINT_BYTES) return;
    const normalized = normalizeSearchText(value).trim().slice(0, MAX_WORKSPACE_HINT_LENGTH);
    if (!normalized || hints.has(normalized)) return;
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (hintBytes + bytes > MAX_WORKSPACE_HINT_BYTES) return;
    hints.add(normalized);
    hintBytes += bytes;
  };

  while (stack.length > 0 && consumed < SEARCH_CHARACTER_BUDGET && hintBytes < MAX_WORKSPACE_HINT_BYTES) {
    const value = stack.pop();
    if (typeof value === "string") {
      consumed += value.length;
      const normalized = normalizeSearchText(value);
      for (const line of normalized.split(/\r?\n/)) {
        if (looksPathBearing(line)) addPathBearingLine(line, addHint);
        if (/\b(?:workspace|project|cwd|repository|repo|working directory)\b/.test(line)) {
          for (const identifier of line.matchAll(/\b[a-z0-9][a-z0-9._-]{5,}\b/g)) {
            if (/[-_]/.test(identifier[0])) addHint(identifier[0]);
          }
        }
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      continue;
    }
    if (value && typeof value === "object") {
      const values = Object.values(value as Record<string, unknown>);
      for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
    }
  }
  return Array.from(hints);
}

function looksPathBearing(value: string): boolean {
  return /(?:^|[\s"'`(])(?:[a-z]:\/|\/(?:[a-z0-9._~-]+\/)?[a-z0-9._~-]+)/i.test(value);
}

function addPathBearingLine(value: string, addHint: (value: string) => void): void {
  const trimmed = value.trim();
  // Preserve unquoted filesystem paths containing spaces without retaining
  // arbitrary transcript lines. Restrict this to common filesystem roots; URL
  // and API route lines continue through the token extractor below.
  if (trimmed.length <= MAX_WORKSPACE_HINT_LENGTH
    && /(?:[a-z]:\/|\/(?:home|users|mnt|workspaces?|projects?|tmp|var|opt|srv|root)\/)/i.test(trimmed)) {
    addHint(trimmed);
  }
  for (const quoted of trimmed.matchAll(/(["'`])((?:[a-z]:\/|\/)[^"'`\r\n]{1,512})\1/gi)) addHint(quoted[2].replace(/[).!?]+$/, ""));
  for (const match of trimmed.matchAll(/(?:[a-z]:\/|\/)[^\s"'`<>|{}\[\],;]+/gi)) addHint(match[0].replace(/[).!?]+$/, ""));
}

function indexedSession(
  id: string,
  file: CachedHermesFile | undefined,
  row: HermesDatabaseRow | undefined,
  manifest: HermesManifestEntry | undefined,
): HermesIndexedSession | null {
  if (!file && !row) return null;
  const metadata = file?.metadata;
  const createdAtFromDb = row ? fromEpoch(row.startedAt) : null;
  const createdAt = metadata?.createdAt || manifest?.createdAt || createdAtFromDb || file?.birthtime || new Date(0).toISOString();
  const updatedAtFromDb = row?.endedAt ? fromEpoch(row.endedAt) : null;
  return {
    id,
    title: cleanSessionTitle(row?.title || metadata?.title || manifest?.title || null) || "Hermes session",
    model: row?.model || metadata?.model || null,
    agent: hermesAgentLabel(row?.source ?? null, manifest, metadata),
    createdAt,
    updatedAt: updatedAtFromDb || metadata?.updatedAt || manifest?.updatedAt || (file ? new Date(file.mtimeMs).toISOString() : null) || createdAt,
  };
}

function matchesWorkspace(file: CachedHermesFile | undefined, manifest: HermesManifestEntry | undefined, query: WorkspaceQuery): boolean {
  // An explicit workspace is authoritative. Falling through to lower-cased
  // transcript hints after a mismatch would merge case-distinct POSIX paths.
  if (file?.metadata.workspace) return sameOrDescendantPath(file.metadata.workspace, query.workspace);
  if (file?.workspaceHints.some((hint) => query.needles.some((needle) => hint.includes(needle)))) return true;
  const titleText = normalizeSearchText(file?.metadata.title ?? "");
  if (query.needles.some((needle) => titleText.includes(needle))) return true;
  const manifestText = normalizeSearchText(manifest?.title ?? "");
  return query.needles.some((needle) => manifestText.includes(needle));
}

async function readHermesManifest(filePath: string): Promise<Map<string, HermesManifestEntry>> {
  const manifest = new Map<string, HermesManifestEntry>();
  const parsed = await readJsonObject(filePath);
  if (!parsed) return manifest;
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const sessionId = stringProperty(entry, "session_id");
    if (!sessionId) continue;
    const origin = objectProperty(entry, "origin");
    manifest.set(sessionId, {
      title: stringProperty(entry, "display_name") || stringProperty(origin, "chat_name") || stringProperty(entry, "session_key"),
      createdAt: stringProperty(entry, "created_at"),
      updatedAt: stringProperty(entry, "updated_at"),
      platform: stringProperty(entry, "platform") || stringProperty(origin, "platform"),
      chatType: stringProperty(entry, "chat_type") || stringProperty(origin, "chat_type"),
    });
  }
  return manifest;
}

export async function resolveHermesDir(): Promise<string | null> {
  const native = path.join(os.homedir(), ".hermes");
  if (fs.existsSync(native)) return native;
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-e", "sh", "-lc", 'wslpath -w "$HOME/.hermes"'], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const candidate = stdout.trim().split(/\r?\n/)[0];
    return candidate && fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function uniqueWorkspaceQueries(workspaces: string[]): WorkspaceQuery[] {
  const queries = new Map<string, WorkspaceQuery>();
  for (const workspace of workspaces) {
    const resolved = path.resolve(workspace);
    // normalizeComparablePath already folds Windows/WSL/UNC identity while
    // preserving the case-sensitive identity of POSIX filesystems.
    const key = normalizeComparablePath(resolved);
    if (!key || queries.has(key)) continue;
    queries.set(key, { workspace: resolved, key, needles: workspaceNeedles(resolved) });
  }
  return Array.from(queries.values());
}

function workspaceNeedles(workspace: string): string[] {
  const normalized = normalizeComparablePath(workspace).toLowerCase();
  const direct = normalizeSearchText(workspace).replace(/\/+$/, "");
  const baseName = path.basename(workspace).toLowerCase();
  const needles = new Set<string>([normalized, direct]);
  if (baseName.length >= 6 && /[-_]/.test(baseName)) {
    needles.add(baseName);
    needles.add(baseName.replace(/[-_]+/g, " "));
  }
  return Array.from(needles).filter(Boolean);
}

function sameOrDescendantPath(candidate: string, workspace: string): boolean {
  const child = normalizeComparablePath(candidate);
  const parent = normalizeComparablePath(workspace);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function sessionIdFromFile(filePath: string): string | null {
  return /^session_(.+)\.json$/.exec(path.basename(filePath))?.[1] ?? null;
}

function isCachedHermesFile(value: unknown): value is CachedHermesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CachedHermesFile>;
  const metadata = item.metadata as Partial<HermesSessionFileMetadata> | undefined;
  const nullableText = (entry: unknown): boolean => entry === null || typeof entry === "string";
  return typeof item.filePath === "string"
    && typeof item.mtimeMs === "number"
    && typeof item.size === "number"
    && typeof item.birthtime === "string"
    && Boolean(metadata && typeof metadata === "object")
    && nullableText(metadata?.title)
    && nullableText(metadata?.model)
    && nullableText(metadata?.platform)
    && nullableText(metadata?.createdAt)
    && nullableText(metadata?.updatedAt)
    && nullableText(metadata?.workspace)
    && Array.isArray(item.workspaceHints)
    && item.workspaceHints.every((entry) => typeof entry === "string" && entry.length <= MAX_WORKSPACE_HINT_LENGTH)
    && Buffer.byteLength(item.workspaceHints.join(""), "utf8") <= MAX_WORKSPACE_HINT_BYTES;
}

async function readJsonObject(
  filePath: string,
  readFile: (filePath: string) => Promise<string> = (target) => fs.promises.readFile(target, "utf8"),
): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonObject(await readFile(filePath));
  } catch {
    return null;
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function firstHermesUserMessage(session: Record<string, unknown>): string | null {
  const messages = session.messages;
  if (!Array.isArray(messages)) return null;
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    if (stringProperty(message, "role") !== "user") continue;
    return cleanSessionTitle(messageText(message));
  }
  return null;
}

function messageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((item) => item && typeof item === "object" && !Array.isArray(item) ? stringProperty(item as Record<string, unknown>, "text") : null)
    .filter(Boolean)
    .join("\n");
}

function hermesWorkspace(session: Record<string, unknown>): string | null {
  for (const key of ["workspace", "cwd", "project_dir", "projectDir", "project_path", "projectPath", "working_directory"]) {
    const value = stringProperty(session, key);
    if (value) return value;
  }
  const context = objectProperty(session, "context_workspace") || objectProperty(session, "contextWorkspace");
  return stringProperty(context, "project_dir") || stringProperty(context, "workspace");
}

function hermesAgentLabel(source: string | null, manifest?: HermesManifestEntry, metadata?: HermesSessionFileMetadata): string | null {
  const platform = manifest?.platform || metadata?.platform || source;
  return [platform, manifest?.chatType].filter(Boolean).join(" / ") || null;
}

function cleanSessionTitle(value: string | null): string {
  const text = value ?? "";
  const pane = text.match(/^Pane:\s*(.+)$/m)?.[1]?.trim();
  if (pane) return pane.slice(0, 120);
  const agent = text.match(/^Agent:\s*(.+)$/m)?.[1]?.trim();
  if (agent) return `${agent} session`.slice(0, 120);
  return text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 120) ?? "";
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

function fromEpoch(value: SqliteValue): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return new Date(0).toISOString();
  return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
}

async function safeReadDir(directory: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(directory);
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
