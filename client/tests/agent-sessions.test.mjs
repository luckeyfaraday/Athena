import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentSessionScanner,
  BoundedTtlPromiseCache,
  claudeProjectDirsForWorkspace,
  FileMetadataCache,
  liveTerminalAgentSession,
  sameOrDescendantPath,
  workspaceSqlFilter,
} from "../dist-electron/agent-sessions.js";

test("agent-session cache evicts expired and least-recently-used workspaces", async () => {
  const cache = new BoundedTtlPromiseCache(2, 10);
  let loads = 0;
  const load = (value) => cache.getOrCreate(value, async () => { loads += 1; return value; }, 100);

  assert.equal(await load("first"), "first");
  assert.equal(await load("second"), "second");
  assert.equal(await load("first"), "first");
  assert.equal(await load("third"), "third");
  assert.equal(cache.size, 2);
  assert.equal(loads, 3);
  assert.equal(await load("second"), "second");
  assert.equal(loads, 4);

  assert.equal(await cache.getOrCreate("expired", async () => "fresh", 111), "fresh");
  assert.ok(cache.size <= 2);
});

function terminalSession(overrides = {}) {
  return {
    id: "terminal-1",
    title: "Codex",
    kind: "codex",
    workspace: "/workspace",
    pid: 123,
    promptPath: null,
    initialTask: null,
    sessionLabel: null,
    providerSessionId: null,
    createdAt: "2026-06-28T15:00:00Z",
    status: "running",
    exitCode: null,
    error: null,
    ...overrides,
  };
}

test("live terminal agent sessions keep stable timestamps across polls", () => {
  const first = liveTerminalAgentSession(terminalSession());
  const second = liveTerminalAgentSession(terminalSession());

  assert.equal(first.updatedAt, "2026-06-28T15:00:00Z");
  assert.equal(second.updatedAt, first.updatedAt);
});

test("live terminal agent sessions prefer discovered provider session ids", () => {
  const session = liveTerminalAgentSession(terminalSession({
    providerSessionId: "codex-session-1",
  }));

  assert.equal(session.id, "codex-session-1");
  assert.equal(session.terminalId, "terminal-1");
  assert.equal(session.status, "running");
});

test("provider SQL workspace filters preserve POSIX case and include Windows/WSL equivalents", () => {
  const posix = workspaceSqlFilter("cwd", "/Work/Case-Sensitive");
  assert.ok(posix.params.includes("/Work/Case-Sensitive"));
  assert.ok(!posix.params.includes("/work/case-sensitive"));

  const wsl = workspaceSqlFilter("cwd", "/mnt/C/Users/Alan/Project");
  assert.ok(wsl.params.includes("/mnt/c/users/alan/project"));
  assert.ok(wsl.params.includes("c:/users/alan/project"));
  assert.match(wsl.sql, /substr/);

  const unc = workspaceSqlFilter("cwd", "\\\\Server\\Share\\Project");
  assert.ok(unc.params.includes("//server/share/project"));
  assert.match(unc.sql, /lower/);
});

test("provider workspace guards include root descendants without folding POSIX case", () => {
  assert.equal(sameOrDescendantPath("/", "/"), true);
  assert.equal(sameOrDescendantPath("/work/project", "/"), true);
  assert.equal(sameOrDescendantPath("/Work/Project/child", "/Work/Project"), true);
  assert.equal(sameOrDescendantPath("/work/project", "/Work/Project"), false);
  assert.equal(sameOrDescendantPath("C:\\Users\\Alan", "C:\\"), true);
  assert.equal(sameOrDescendantPath("/mnt/c/Users/Alan", "C:\\"), true);

  const posixRoot = workspaceSqlFilter("cwd", "/");
  assert.equal(posixRoot.params.length, 0);
  assert.match(posixRoot.sql, /substr/);

  const driveRoot = workspaceSqlFilter("cwd", "C:\\");
  assert.ok(driveRoot.params.includes("c:"));
  assert.ok(driveRoot.params.includes("/mnt/c"));
});

// ---------------------------------------------------------------------------
// Incremental native-session scanner (runs in the session-index child).
// ---------------------------------------------------------------------------

async function scannerHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "athena-agent-scan-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

function claudeProjectName(workspace) {
  return path.resolve(workspace).replace(/[^A-Za-z0-9]/g, "-");
}

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function writeFile(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents);
}

function scannerFor(home, overrides = {}) {
  return new AgentSessionScanner({
    homeDir: home,
    athenaHome: path.join(home, ".athena-code"),
    queryDatabase: async () => [],
    codexListingShareMs: 0,
    ...overrides,
  });
}

function delta(after, before) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
}

test("agent session scanner never re-reads a session file whose mtime and size are unchanged", async (t) => {
  const home = await scannerHome(t);
  const workspace = path.join(home, "work", "project");
  const claudeFile = path.join(home, ".claude", "projects", claudeProjectName(workspace), "claude-1.jsonl");
  await writeFile(claudeFile, jsonl([
    { sessionId: "claude-1", cwd: workspace, gitBranch: "main", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Claude title" } },
    { sessionId: "claude-1", cwd: workspace, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", model: "claude-model", content: [] } },
  ]));
  await writeFile(path.join(home, ".codex", "sessions", "2026", "01", "02", "rollout-codex-1.jsonl"), jsonl([
    { timestamp: "2026-01-02T00:00:00.000Z", type: "session_meta", payload: { id: "codex-1", cwd: workspace, cli_version: "1.0" } },
    { timestamp: "2026-01-02T00:00:01.000Z", type: "turn_context", payload: { cwd: workspace, model: "gpt-x" } },
    { timestamp: "2026-01-02T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "Codex title" } },
  ]));

  const scanner = scannerFor(home);
  const start = scanner.getCounters();
  const first = await scanner.list(workspace);
  const afterFirst = scanner.getCounters();
  assert.deepEqual(first.map((session) => `${session.provider}:${session.id}`).sort(), ["claude:claude-1", "codex:codex-1"]);
  const claude = first.find((session) => session.provider === "claude");
  assert.equal(claude.title, "Claude title");
  assert.equal(claude.model, "claude-model");
  assert.equal(claude.updatedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(first.find((session) => session.provider === "codex").title, "Codex title");
  assert.equal(delta(afterFirst, start).filesParsed, 2);

  const second = await scanner.list(workspace);
  const afterSecond = scanner.getCounters();
  assert.deepEqual(second, first);
  assert.equal(delta(afterSecond, afterFirst).filesParsed, 0, "unchanged files must be served from the per-file cache");
  assert.equal(delta(afterSecond, afterFirst).bytesParsed, 0);
  assert.equal(delta(afterSecond, afterFirst).cacheHits, 2);

  // Parsed metadata is workspace-independent: an ancestor workspace reuses it.
  const ancestor = await scanner.list(path.join(home, "work"));
  const afterAncestor = scanner.getCounters();
  assert.deepEqual(ancestor.map((session) => `${session.provider}:${session.id}`).sort(), ["claude:claude-1", "codex:codex-1"]);
  assert.equal(delta(afterAncestor, afterSecond).filesParsed, 0);

  // A changed signature re-parses exactly that file.
  await fsp.appendFile(claudeFile, jsonl([{ sessionId: "claude-1", cwd: workspace, timestamp: "2026-01-01T00:05:00.000Z" }]));
  const future = new Date(Date.now() + 5_000);
  await fsp.utimes(claudeFile, future, future);
  const third = await scanner.list(workspace);
  const afterThird = scanner.getCounters();
  assert.equal(delta(afterThird, afterAncestor).filesParsed, 1);
  assert.equal(third.find((session) => session.provider === "claude").updatedAt, "2026-01-01T00:05:00.000Z");
});

test("claude history is read from the workspace folder and descendant folders only", async (t) => {
  const home = await scannerHome(t);
  const projects = path.join(home, ".claude", "projects");
  const workspace = path.join(home, "work", "project");
  const own = path.join(projects, claudeProjectName(workspace));
  const child = path.join(projects, claudeProjectName(path.join(workspace, "packages", "app")));
  const sibling = path.join(projects, claudeProjectName(`${workspace}-evil`));
  const lookalike = path.join(projects, `${claudeProjectName(workspace)}2`);
  const unrelated = path.join(projects, claudeProjectName(path.join(home, "elsewhere")));
  for (const directory of [own, child, sibling, lookalike, unrelated]) await fsp.mkdir(directory, { recursive: true });

  const dirs = await claudeProjectDirsForWorkspace(projects, workspace);
  assert.deepEqual(dirs[0], { dir: own, allowMissingCwd: true });
  // Encoded names are ambiguous ("a/b" and "a-b" both encode to "a-b"), so
  // prefix matches are candidates that must prove membership by cwd.
  assert.deepEqual(
    dirs.slice(1).sort((left, right) => left.dir.localeCompare(right.dir)),
    [{ dir: child, allowMissingCwd: false }, { dir: sibling, allowMissingCwd: false }].sort((left, right) => left.dir.localeCompare(right.dir)),
  );

  await writeFile(path.join(own, "own.jsonl"), jsonl([{ sessionId: "own", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Parent session" } }]));
  // Subagent sidechains share the parent's sessionId; they are not sessions
  // and must not replace the parent's title or timestamps.
  await writeFile(path.join(own, "own", "subagents", "agent-a1.jsonl"), jsonl([
    { sessionId: "own", cwd: workspace, isSidechain: true, timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "Subagent prompt" } },
  ]));
  await writeFile(path.join(child, "child.jsonl"), jsonl([{ sessionId: "child", cwd: path.join(workspace, "packages", "app"), timestamp: "2026-01-02T00:00:00.000Z" }]));
  await writeFile(path.join(sibling, "sibling.jsonl"), jsonl([{ sessionId: "sibling", cwd: `${workspace}-evil`, timestamp: "2026-01-02T00:00:00.000Z" }]));
  await writeFile(path.join(child, "no-cwd.jsonl"), jsonl([{ sessionId: "no-cwd", timestamp: "2026-01-02T00:00:00.000Z" }]));
  await writeFile(path.join(lookalike, "lookalike.jsonl"), jsonl([{ sessionId: "lookalike", cwd: workspace, timestamp: "2026-01-02T00:00:00.000Z" }]));
  await writeFile(path.join(unrelated, "unrelated.jsonl"), jsonl([{ sessionId: "unrelated", cwd: workspace, timestamp: "2026-01-02T00:00:00.000Z" }]));

  const sessions = await scannerFor(home).list(workspace);
  assert.deepEqual(sessions.map((session) => session.id), ["child", "own"]);
  const own0 = sessions.find((session) => session.id === "own");
  assert.equal(own0.title, "Parent session");
  assert.equal(own0.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(own0.workspace, workspace);
});

test("FileMetadataCache validates by mtime and size and stays bounded", () => {
  const cache = new FileMetadataCache(2);
  cache.set("/a", { mtimeMs: 1, size: 10 }, "a");
  assert.equal(cache.get("/a", { mtimeMs: 1, size: 10 }), "a");
  assert.equal(cache.get("/a", { mtimeMs: 2, size: 10 }), undefined);
  assert.equal(cache.get("/a", { mtimeMs: 1, size: 11 }), undefined);
  cache.set("/b", { mtimeMs: 1, size: 1 }, "b");
  assert.equal(cache.get("/a", { mtimeMs: 1, size: 10 }), "a");
  cache.set("/c", { mtimeMs: 1, size: 1 }, "c");
  assert.equal(cache.size, 2);
  assert.equal(cache.get("/b", { mtimeMs: 1, size: 1 }), undefined, "least recently used entry is evicted");
  cache.retainOnly(new Set(["/c"]));
  assert.equal(cache.size, 1);
});
