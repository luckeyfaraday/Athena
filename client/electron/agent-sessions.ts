import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";

export type AgentSessionProvider = "codex" | "opencode" | "claude";

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
};

type SqliteValue = string | number | null;

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5000;
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
  const [codex, opencode] = await Promise.all([
    readCodexSessions(workspace),
    readOpenCodeSessions(workspace),
  ]);
  const claude = readClaudeSessions(workspace);
  return mergeSessions([...codex, ...opencode, ...claude]);
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
  return {
    id: `terminal:${session.id}`,
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
  };
}

async function readCodexSessions(workspace: string): Promise<AgentSession[]> {
  const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  const rows = await querySqlite(dbPath, [
    "select id, cwd, title, created_at_ms, updated_at_ms, git_branch, cli_version, first_user_message, model, agent_role",
    "from threads",
    "where cwd = ?",
    "order by updated_at_ms desc",
    "limit 50",
  ].join(" "), [workspace]);
  return rows.map((row): AgentSession => {
    const id = stringValue(row[0]);
    const title = cleanSessionTitle(stringValue(row[2]) || stringValue(row[7])) || "Codex session";
    return {
      id,
      provider: "codex",
      title,
      workspace: stringValue(row[1]) || workspace,
      branch: nullableString(row[5]),
      model: nullableString(row[8]),
      agent: nullableString(row[9]),
      createdAt: fromEpoch(row[3]),
      updatedAt: fromEpoch(row[4]),
      status: "historical",
      terminalId: null,
      pid: null,
      resumeCommand: id ? `codex resume --cd ${quoteShellArg(workspace)} ${quoteShellArg(id)}` : null,
    };
  }).filter((session) => Boolean(session.id));
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
  };
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
    if (!existing || session.status === "running") byKey.set(key, session);
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
  return kind === "codex" || kind === "opencode" || kind === "claude";
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function fromEpoch(value: SqliteValue): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return new Date(0).toISOString();
  return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
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
