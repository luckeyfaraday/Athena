import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";

export type AgentSessionProvider = "codex" | "opencode" | "claude" | "hermes";

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

type SqliteValue = string | number | null;

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;
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
  const [codex, opencode, hermes] = await Promise.all([
    readCodexSessions(workspace),
    readOpenCodeSessions(workspace),
    readHermesSessions(workspace),
  ]);
  const claude = readClaudeSessions(workspace);
  return mergeSessions([...codex, ...opencode, ...claude, ...hermes]);
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
  const jsonlMetadata = readCodexJsonlMetadata(workspace);
  const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
  const sessions: AgentSession[] = [];
  const seenIds = new Set<string>();

  if (fs.existsSync(dbPath)) {
    const rows = await querySqlite(dbPath, [
      "select id, cwd, title, created_at_ms, updated_at_ms, git_branch, cli_version, first_user_message, model, agent_role",
      "from threads",
      "where cwd = ?",
      "order by updated_at_ms desc",
      "limit 50",
    ].join(" "), [workspace]);
    for (const row of rows) {
      const id = stringValue(row[0]);
      if (!id) continue;
      const metadata = jsonlMetadata.get(id) ?? {};
      const cliVersion = nullableString(row[6]) ?? metadata.cli_version;
      const enriched = cliVersion ? { ...metadata, cli_version: cliVersion } : metadata;
      sessions.push({
        id,
        provider: "codex",
        title: cleanSessionTitle(stringValue(row[2]) || stringValue(row[7]) || metadata.first_user_message || null) || "Codex session",
        workspace: stringValue(row[1]) || workspace,
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

function readCodexJsonlMetadata(workspace: string): Map<string, Record<string, string>> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const byId = new Map<string, Record<string, string>>();
  if (!fs.existsSync(sessionsDir)) return byId;
  for (const filePath of recentJsonlFiles(sessionsDir, 400)) {
    const metadata = readCodexJsonlFileMetadata(filePath);
    const id = metadata.session_id;
    const cwd = metadata.cwd;
    if (!id || !cwd || !samePath(cwd, workspace)) continue;
    byId.set(id, metadata);
  }
  return byId;
}

function recentJsonlFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const name of safeReadDir(dir)) {
      const filePath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(filePath);
      else if (name.endsWith(".jsonl")) files.push(filePath);
    }
  };
  visit(root);
  return files.sort((left, right) => safeMtimeMs(right) - safeMtimeMs(left)).slice(0, limit);
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readCodexJsonlFileMetadata(filePath: string): Record<string, string> {
  const metadata: Record<string, string> = { jsonl_path: filePath };
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 240);
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
    "where s.directory = ? or p.worktree = ?",
    "order by s.time_updated desc",
    "limit 50",
  ].join(" "), [workspace, workspace]);
  return rows.map((row): AgentSession => {
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

function readClaudeSessions(workspace: string): AgentSession[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const candidateDirs = [
    path.join(projectsDir, encodeClaudeProjectPath(workspace)),
    ...safeReadDir(projectsDir).map((name) => path.join(projectsDir, name)),
  ];
  const seenFiles = new Set<string>();
  const sessions: AgentSession[] = [];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of safeReadDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const session = readClaudeSessionFile(filePath, workspace);
      if (session) sessions.push(session);
    }
  }
  return sessions
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 50);
}

function readClaudeSessionFile(filePath: string, workspace: string): AgentSession | null {
  const stat = fs.statSync(filePath);
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).slice(0, 120);
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

  if (cwd && !samePath(cwd, workspace)) return null;
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

async function readHermesSessions(workspace: string): Promise<AgentSession[]> {
  const hermesDir = await resolveHermesDir();
  if (!hermesDir) return [];
  const dbPath = path.join(hermesDir, "state.db");
  const sessionsDir = path.join(hermesDir, "sessions");
  const manifest = readHermesManifest(path.join(sessionsDir, "sessions.json"));
  const sessionsById = new Map<string, AgentSession>();

  if (fs.existsSync(dbPath)) {
    const rows = await querySqlite(dbPath, [
      "select id, source, model, started_at, ended_at, message_count, title",
      "from sessions",
      "order by coalesce(ended_at, started_at) desc",
      "limit 250",
    ].join(" "), []);
    for (const row of rows) {
      const id = stringValue(row[0]);
      if (!id) continue;
      const metadata = nullableString(row[2]) && nullableString(row[6]) && row[4]
        ? null
        : readHermesSessionFile(path.join(sessionsDir, `session_${id}.json`));
      const manifestEntry = manifest.get(id);
      const agent = hermesAgentLabel(nullableString(row[1]), manifestEntry, metadata);
      const createdAt = fromEpoch(row[3]);
      const updatedAt = row[4] ? fromEpoch(row[4]) : metadata?.updatedAt ?? manifestEntry?.updatedAt ?? createdAt;
      sessionsById.set(id, {
        id,
        provider: "hermes",
        title: cleanSessionTitle(nullableString(row[6]) || metadata?.title || manifestEntry?.title || null) || "Hermes session",
        workspace,
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
      });
    }
  }

  if (sessionsById.size === 0 && fs.existsSync(sessionsDir)) {
    for (const name of safeReadDir(sessionsDir)) {
      const match = name.match(/^session_(.+)\.json$/);
      if (!match || sessionsById.has(match[1])) continue;
      const filePath = path.join(sessionsDir, name);
      const metadata = readHermesSessionFile(filePath);
      if (!metadata) continue;
      const stat = fs.statSync(filePath);
      const manifestEntry = manifest.get(match[1]);
      sessionsById.set(match[1], {
        id: match[1],
        provider: "hermes",
        title: cleanSessionTitle(metadata.title || manifestEntry?.title || null) || "Hermes session",
        workspace,
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
      });
    }
  }

  return Array.from(sessionsById.values())
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 100);
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
};

function readHermesManifest(filePath: string): Map<string, HermesManifestEntry> {
  const manifest = new Map<string, HermesManifestEntry>();
  const parsed = readJsonObject(filePath);
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

function readHermesSessionFile(filePath: string): HermesSessionFileMetadata | null {
  const parsed = readJsonObject(filePath);
  if (!parsed) return null;
  return {
    title: firstHermesUserMessage(parsed),
    model: stringProperty(parsed, "model"),
    platform: stringProperty(parsed, "platform"),
    createdAt: stringProperty(parsed, "session_start"),
    updatedAt: stringProperty(parsed, "last_updated"),
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonObject(fs.readFileSync(filePath, "utf8"));
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

async function querySqlite(dbPath: string, sql: string, params: string[]): Promise<SqliteValue[][]> {
  const script = [
    "import json, sqlite3, sys",
    "db, sql, params = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])",
    "con = sqlite3.connect('file:' + db + '?mode=ro', uri=True, timeout=0.25)",
    "con.row_factory = lambda cursor, row: list(row)",
    "print(json.dumps(con.execute(sql, params).fetchall()))",
  ].join("\n");
  for (const executable of ["python3", "python"]) {
    try {
      const { stdout } = await execFileAsync(executable, ["-c", script, dbPath, sql, JSON.stringify(params)], {
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout) as SqliteValue[][];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Try the next Python executable, then gracefully omit this provider.
    }
  }
  return [];
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
  return kind === "codex" || kind === "opencode" || kind === "claude" || kind === "hermes";
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
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

function encodeClaudeProjectPath(workspace: string): string {
  return path.resolve(workspace).replace(/:/g, "").replace(/[\\/]/g, "-");
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
