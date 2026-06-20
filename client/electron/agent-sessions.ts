import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";
import { normalizeComparablePath } from "./platform.js";
import { querySqlite, type SqliteValue } from "./sqlite.js";
import { mapWithConcurrency, readFilePrefix } from "./file-prefix.js";
import { memoizeAsyncWithTtl } from "./ttl-cache.js";

export type AgentSessionProvider = "codex" | "opencode" | "athena" | "claude" | "hermes" | "grok";

export type AgentSession = {
  id: string;
  provider: AgentSessionProvider;
  title: string;
  workspace: string;
  branch: string | null;
  model: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited" | "historical";
  terminalId: string | null;
  pid: number | null;
  resumeCommand: string | null;
  metadata: Record<string, string>;
};

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const MAX_PROVIDER_ROWS = 1000;
const MAX_JSONL_SCAN_DIRS = 160;
const MAX_JSONL_SCAN_FILES = 1200;
const SESSION_FILE_PREFIX_MAX_BYTES = 512_000;
const SESSION_FILE_SCAN_CONCURRENCY = 8;
const sessionCache = new Map<string, { expiresAt: number; promise: Promise<AgentSession[]> }>();

export function listAgentSessionsCached(workspace: string, liveTerminals: EmbeddedTerminalSession[] = []): Promise<AgentSession[]> {
  const resolvedWorkspace = path.resolve(workspace);
  const cached = sessionCache.get(resolvedWorkspace);
  if (cached && cached.expiresAt > Date.now()) return cached.promise.then((sessions) => mergeLiveSessions(sessions, liveTerminals, resolvedWorkspace));
  const promise = listHistoricalAgentSessions(resolvedWorkspace);
  sessionCache.set(resolvedWorkspace, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise.then((sessions) => mergeLiveSessions(sessions, liveTerminals, resolvedWorkspace));
}

async function listHistoricalAgentSessions(workspace: string): Promise<AgentSession[]> {
  const [codex, opencode, athena, claude, hermes, grok] = await Promise.all([
    readCodexSessions(workspace),
    readOpenCodeSessions(workspace),
    readAthenaSessions(workspace),
    readClaudeSessions(workspace),
    readHermesSessions(workspace),
    readGrokSessions(workspace),
  ]);
  return mergeSessions([...codex, ...opencode, ...athena, ...claude, ...hermes, ...grok]);
}

function mergeLiveSessions(historical: AgentSession[], liveTerminals: EmbeddedTerminalSession[], workspace: string): AgentSession[] {
  const resolvedWorkspace = path.resolve(workspace);
  const live = liveTerminals
    .filter((session) => isAgentKind(session.kind) && samePath(session.workspace, resolvedWorkspace))
    .map(liveTerminalSession);
  return mergeSessions([...live, ...historical]);
}

function liveTerminalSession(session: EmbeddedTerminalSession): AgentSession {
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
    updatedAt: new Date().toISOString(),
    status: session.status === "running" ? "running" : "exited",
    terminalId: session.id,
    pid: session.pid,
    resumeCommand: null,
    metadata: {},
  };
}

async function readCodexSessions(workspace: string): Promise<AgentSession[]> {
  const jsonlMetadata = await readCodexJsonlMetadata(workspace);
  const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
  const sessions: AgentSession[] = [];
  const seenIds = new Set<string>();

  if (fs.existsSync(dbPath)) {
    const rows = await querySqlite(dbPath, [
      "select id, cwd, title, created_at_ms, updated_at_ms, git_branch, cli_version, first_user_message, model, agent_role",
      "from threads",
      "order by updated_at_ms desc",
      `limit ${MAX_PROVIDER_ROWS}`,
    ].join(" "), []);
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

async function readCodexJsonlMetadata(workspace: string): Promise<Map<string, Record<string, string>>> {
  const byId = new Map<string, Record<string, string>>();
  const results = await cachedCodexJsonlMetadata();
  for (const metadata of results) {
    const id = metadata.session_id;
    const cwd = metadata.cwd;
    if (!id || !cwd || !sameOrDescendantPath(cwd, workspace)) continue;
    byId.set(id, metadata);
  }
  return byId;
}

// Scan the workspace-independent ~/.codex/sessions corpus once per CACHE_TTL_MS
// and share it across workspaces, mirroring the Hermes scan dedup.
const cachedCodexJsonlMetadata = memoizeAsyncWithTtl(CACHE_TTL_MS, scanCodexJsonlMetadata);

async function scanCodexJsonlMetadata(): Promise<Record<string, string>[]> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  const files = await recentJsonlFiles(sessionsDir, 400);
  return mapWithConcurrency(files, SESSION_FILE_SCAN_CONCURRENCY, readCodexJsonlFileMetadata);
}

async function recentJsonlFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  let visitedDirs = 0;
  let inspectedFiles = 0;
  const visit = async (dir: string): Promise<void> => {
    if (visitedDirs >= MAX_JSONL_SCAN_DIRS || inspectedFiles >= MAX_JSONL_SCAN_FILES) return;
    visitedDirs += 1;
    const entries = (await safeReadDirEntries(dir)).sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (inspectedFiles >= MAX_JSONL_SCAN_FILES) return;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.name.endsWith(".jsonl")) {
        inspectedFiles += 1;
        files.push(filePath);
        if (files.length >= limit * 2) return;
      } else {
        inspectedFiles += 1;
      }
    }
  };
  await visit(root);
  const mtimes = await Promise.all(files.map(async (f) => ({ f, mt: await safeMtimeMs(f) })));
  return mtimes.sort((a, b) => b.mt - a.mt).map((x) => x.f).slice(0, limit);
}

async function safeMtimeMs(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readCodexJsonlFileMetadata(filePath: string): Promise<Record<string, string>> {
  const metadata: Record<string, string> = { jsonl_path: filePath };
  let lines: string[];
  try {
    lines = (await readFilePrefix(filePath, SESSION_FILE_PREFIX_MAX_BYTES)).split(/\r?\n/).filter(Boolean).slice(0, 240);
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
  return metadata;
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

async function readOpenCodeSessions(workspace: string): Promise<AgentSession[]> {
  const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(dbPath)) return [];
  const rows = await querySqlite(dbPath, [
    "select s.id, coalesce(s.directory, p.worktree), s.title, s.time_created, s.time_updated, s.agent, s.model, p.worktree",
    "from session s",
    "left join project p on s.project_id = p.id",
    "order by s.time_updated desc",
    `limit ${MAX_PROVIDER_ROWS}`,
  ].join(" "), []);
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


async function readAthenaSessions(workspace: string): Promise<AgentSession[]> {
  const dbPath = path.join(process.env.ATHENA_CODE_HOME || path.join(os.homedir(), ".athena-code"), "context", "sessions.db");
  if (!fs.existsSync(dbPath) || !await sqliteUserVersion(dbPath, 2)) return [];
  const rows = await querySqlite(dbPath, [
    "select m.session_id, m.workspace,",
    "(select text from messages first_user where first_user.agent = 'athena'",
    "and first_user.session_id = m.session_id and first_user.workspace = m.workspace",
    "and first_user.role = 'user' order by first_user.id asc limit 1),",
    "min(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end),",
    "max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end), count(*)",
    "from messages m",
    "where m.agent = 'athena'",
    "group by m.session_id, m.workspace",
    "order by (max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end) is null),",
    "max(case when ts glob '[12][0-9][0-9][0-9]-*' then ts end) desc, max(id) desc",
    `limit ${MAX_PROVIDER_ROWS}`,
  ].join(" "), []);
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
async function readGrokSessions(workspace: string): Promise<AgentSession[]> {
  const sessionsRoot = path.join(os.homedir(), ".grok", "sessions");
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
  const raw = await readFilePrefix(historyPath, SESSION_FILE_PREFIX_MAX_BYTES).catch(() => null);
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
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

async function readClaudeSessions(workspace: string): Promise<AgentSession[]> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const candidateDirs = claudeProjectPathCandidates(projectsDir, workspace);
  const seenFiles = new Set<string>();
  const sessions: AgentSession[] = [];
  for (const dir of candidateDirs) {
    let dirStat: fs.Stats;
    try {
      dirStat = await fs.promises.stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const names = (await safeReadDir(dir)).filter((name) => name.endsWith(".jsonl"));
    const candidateFiles = names
      .map((name) => path.join(dir, name))
      .filter((filePath) => {
        if (seenFiles.has(filePath)) return false;
        seenFiles.add(filePath);
        return true;
      });
    const results = await mapWithConcurrency(
      candidateFiles,
      SESSION_FILE_SCAN_CONCURRENCY,
      (filePath) => readClaudeSessionFile(filePath, workspace, { allowMissingCwd: true }),
    );
    sessions.push(...results.filter((s): s is AgentSession => s !== null));
  }
  const recentFiles = (await recentJsonlFiles(projectsDir, MAX_PROVIDER_ROWS))
    .filter((filePath) => {
      if (seenFiles.has(filePath)) return false;
      seenFiles.add(filePath);
      return true;
    });
  const recentResults = await mapWithConcurrency(
    recentFiles,
    SESSION_FILE_SCAN_CONCURRENCY,
    (filePath) => readClaudeSessionFile(filePath, workspace, { allowMissingCwd: false }),
  );
  sessions.push(...recentResults.filter((s): s is AgentSession => s !== null));
  return sessions
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 50);
}

async function readClaudeSessionFile(filePath: string, workspace: string, options: { allowMissingCwd: boolean }): Promise<AgentSession | null> {
  let stat: fs.Stats;
  let lines: string[];
  try {
    stat = await fs.promises.stat(filePath);
    lines = (await readFilePrefix(filePath, SESSION_FILE_PREFIX_MAX_BYTES)).split("\n").filter(Boolean).slice(0, 120);
  } catch {
    return null;
  }
  let sessionId = path.basename(filePath, ".jsonl");
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

  if (cwd) {
    if (!sameOrDescendantPath(cwd, workspace)) return null;
  } else if (!options.allowMissingCwd) {
    return null;
  }
  return {
    id: sessionId,
    provider: "claude",
    title: title || "Claude Code session",
    workspace: cwd || workspace,
    branch,
    model,
    agent: null,
    createdAt: createdAt || stat.birthtime.toISOString(),
    updatedAt: updatedAt || stat.mtime.toISOString(),
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: `claude --resume ${quoteShellArg(sessionId)}`,
    metadata: {},
  };
}

// The Hermes session corpus lives in a single, workspace-independent directory
// (~/.hermes plus its state.db) and is only narrowed to a workspace by the final
// match. Each cached entry therefore carries a workspace-agnostic session
// template alongside the metadata needed to test workspace membership; the only
// per-workspace field is `workspace`, applied when the entry is selected.
type HermesScanEntry = {
  session: AgentSession;
  metadata: HermesSessionFileMetadata | null;
  manifestEntry: HermesManifestEntry | undefined;
};

// Scan the global corpus once per CACHE_TTL_MS and share it across workspaces.
// Without this, a multi-workspace review reran the entire scan — re-reading and
// re-decoding every session file — once per open workspace, multiplying peak
// heap by the workspace count.
const cachedHermesScan = memoizeAsyncWithTtl(CACHE_TTL_MS, scanHermesSessions);

async function readHermesSessions(workspace: string): Promise<AgentSession[]> {
  const entries = await cachedHermesScan();
  const matched: AgentSession[] = [];
  for (const entry of entries) {
    if (!hermesSessionMatchesWorkspace(entry.metadata, entry.manifestEntry, workspace)) continue;
    matched.push({ ...entry.session, workspace });
  }
  return matched
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 100);
}

async function scanHermesSessions(): Promise<HermesScanEntry[]> {
  const hermesDir = await resolveHermesDir();
  if (!hermesDir) return [];
  const dbPath = path.join(hermesDir, "state.db");
  const sessionsDir = path.join(hermesDir, "sessions");
  const manifest = await readHermesManifest(path.join(sessionsDir, "sessions.json"));
  const entries = new Map<string, HermesScanEntry>();

  if (fs.existsSync(dbPath)) {
    const rows = await querySqlite(dbPath, [
      "select id, source, model, started_at, ended_at, message_count, title",
      "from sessions",
      "order by coalesce(ended_at, started_at) desc",
      `limit ${MAX_PROVIDER_ROWS}`,
    ].join(" "), []);
    for (const row of rows) {
      const id = stringValue(row[0]);
      if (!id) continue;
      const metadata = await readHermesSessionFile(path.join(sessionsDir, `session_${id}.json`));
      const manifestEntry = manifest.get(id);
      const agent = hermesAgentLabel(nullableString(row[1]), manifestEntry, metadata);
      const createdAt = fromEpoch(row[3]);
      const updatedAt = row[4] ? fromEpoch(row[4]) : metadata?.updatedAt ?? manifestEntry?.updatedAt ?? createdAt;
      entries.set(id, {
        metadata,
        manifestEntry,
        session: {
          id,
          provider: "hermes",
          title: cleanSessionTitle(nullableString(row[6]) || metadata?.title || manifestEntry?.title || null) || "Hermes session",
          workspace: "",
          branch: null,
          model: nullableString(row[2]) || metadata?.model || null,
          agent,
          createdAt: metadata?.createdAt || manifestEntry?.createdAt || createdAt,
          updatedAt,
          status: "historical",
          terminalId: null,
          pid: null,
          resumeCommand: `hermes --resume ${quoteShellArg(id)}`,
          metadata: {},
        },
      });
    }
  }

  // Fallback for installs without a session database: enumerate the on-disk
  // session files directly. Mirrors the previous per-workspace fallback, hoisted
  // to the shared scan (so it triggers when the database yields nothing at all).
  if (entries.size === 0 && fs.existsSync(sessionsDir)) {
    for (const name of await safeReadDir(sessionsDir)) {
      const match = name.match(/^session_(.+)\.json$/);
      if (!match || entries.has(match[1])) continue;
      const filePath = path.join(sessionsDir, name);
      const metadata = await readHermesSessionFile(filePath);
      if (!metadata) continue;
      const stat = await fs.promises.stat(filePath);
      const manifestEntry = manifest.get(match[1]);
      entries.set(match[1], {
        metadata,
        manifestEntry,
        session: {
          id: match[1],
          provider: "hermes",
          title: cleanSessionTitle(metadata.title || manifestEntry?.title || null) || "Hermes session",
          workspace: "",
          branch: null,
          model: metadata.model,
          agent: hermesAgentLabel(metadata.platform, manifestEntry, metadata),
          createdAt: metadata.createdAt || manifestEntry?.createdAt || stat.birthtime.toISOString(),
          updatedAt: metadata.updatedAt || manifestEntry?.updatedAt || stat.mtime.toISOString(),
          status: "historical",
          terminalId: null,
          pid: null,
          resumeCommand: `hermes --resume ${quoteShellArg(match[1])}`,
          metadata: {},
        },
      });
    }
  }

  return Array.from(entries.values());
}

async function resolveHermesDir(): Promise<string | null> {
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
  searchText: string;
};

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

async function readHermesSessionFile(filePath: string): Promise<HermesSessionFileMetadata | null> {
  const parsed = await readJsonObject(filePath);
  if (!parsed) return null;
  return {
    title: firstHermesUserMessage(parsed),
    model: stringProperty(parsed, "model"),
    platform: stringProperty(parsed, "platform"),
    createdAt: stringProperty(parsed, "session_start"),
    updatedAt: stringProperty(parsed, "last_updated"),
    workspace: hermesWorkspace(parsed),
    searchText: JSON.stringify(parsed).slice(0, 300_000),
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonObject(await fs.promises.readFile(filePath, "utf8"));
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

function hermesAgentLabel(source: string | null, manifestEntry?: HermesManifestEntry, metadata?: HermesSessionFileMetadata | null): string | null {
  const platform = manifestEntry?.platform || metadata?.platform || source;
  const chatType = manifestEntry?.chatType;
  return [platform, chatType].filter(Boolean).join(" / ") || null;
}

function hermesWorkspace(session: Record<string, unknown>): string | null {
  for (const key of ["workspace", "cwd", "project_dir", "projectDir", "project_path", "projectPath", "working_directory"]) {
    const value = stringProperty(session, key);
    if (value) return value;
  }
  const context = objectProperty(session, "context_workspace") || objectProperty(session, "contextWorkspace");
  return stringProperty(context, "project_dir") || stringProperty(context, "workspace");
}

function hermesSessionMatchesWorkspace(metadata: HermesSessionFileMetadata | null, manifestEntry: HermesManifestEntry | undefined, workspace: string): boolean {
  if (metadata?.workspace && sameOrDescendantPath(metadata.workspace, workspace)) return true;
  const text = normalizeSessionSearchText([
    metadata?.title,
    metadata?.searchText,
    manifestEntry?.title,
  ].filter(Boolean).join("\n"));
  return workspaceNeedles(workspace).some((needle) => text.includes(needle));
}

const warnedSessionIndexes = new Set<string>();

async function sqliteUserVersion(dbPath: string, minimum: number): Promise<boolean> {
  const rows = await querySqlite(dbPath, "pragma user_version", []);
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

function sameOrDescendantPath(candidate: string, workspace: string): boolean {
  const child = normalizeComparablePath(candidate);
  const parent = normalizeComparablePath(workspace);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return parent === "/" ? child.startsWith("/") : child.startsWith(`${parent}/`);
}

function workspaceNeedles(workspace: string): string[] {
  const normalized = normalizeComparablePath(workspace).toLowerCase();
  const baseName = path.basename(workspace).toLowerCase();
  const needles = new Set<string>([normalized]);
  if (baseName.length >= 6 && /[-_]/.test(baseName)) {
    needles.add(baseName);
    needles.add(baseName.replace(/[-_]+/g, " "));
  }
  return Array.from(needles).filter(Boolean);
}

function normalizeSessionSearchText(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");
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

function claudeProjectPathCandidates(projectsDir: string, workspace: string): string[] {
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

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadDirEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
