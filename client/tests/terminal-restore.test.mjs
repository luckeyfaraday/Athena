import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  claudeProjectPathCandidates,
  codexSessionIdForWorkspace,
  effectiveCreationMs,
  openCodeDatabaseCandidates,
  openCodeSessionCandidates,
  openCodeSessionExists,
  openCodeSessionIdForWorkspace,
  savedResumeSessionId,
  selectDiscoveredSessionId,
  selectEmbeddedTerminalRestoreEntries,
} from "../dist-electron/terminal-restore-policy.js";

const execFileAsync = promisify(execFile);

function entry(id, kind, workspace = "/home/dev/project", extras = {}) {
  return {
    id,
    workspace,
    kind,
    title: `${kind} ${id}`,
    sessionLabel: null,
    providerSessionId: null,
    resumeSessionId: null,
    createdAt: "2026-05-25T00:00:00.000Z",
    ...extras,
  };
}

test("workspace restore restores every saved terminal for the selected workspace", () => {
  const plan = selectEmbeddedTerminalRestoreEntries([
    entry("shell-1", "shell"),
    entry("codex-1", "codex", "/home/dev/project", { resumeSessionId: "codex-session" }),
    entry("claude-1", "claude", "/home/dev/project", { providerSessionId: "claude-session" }),
    entry("hermes-1", "hermes"),
  ], ["/home/dev/project"]);

  assert.deepEqual(plan.restore.map((item) => item.id), ["shell-1", "codex-1", "claude-1", "hermes-1"]);
  assert.deepEqual(plan.retained, []);
  assert.deepEqual(plan.live, []);
});

test("workspace restore keeps entries for workspaces outside the selected workspace", () => {
  const plan = selectEmbeddedTerminalRestoreEntries([
    entry("active-shell", "shell", "/home/dev/active"),
    entry("active-codex", "codex", "/home/dev/active", { resumeSessionId: "codex-session" }),
    entry("other-shell", "shell", "/home/dev/other"),
    entry("other-codex", "codex", "/home/dev/other", { resumeSessionId: "other-codex-session" }),
  ], ["/home/dev/active"]);

  assert.deepEqual(plan.restore.map((item) => item.id), ["active-shell", "active-codex"]);
  assert.deepEqual(plan.retained.map((item) => item.id), ["other-shell", "other-codex"]);
  assert.deepEqual(plan.live, []);
});

test("workspace restore keeps already live terminals instead of restoring duplicates", () => {
  const plan = selectEmbeddedTerminalRestoreEntries([
    entry("active-codex", "codex", "/home/dev/active", { resumeSessionId: "codex-session" }),
    entry("active-claude", "claude", "/home/dev/active", { providerSessionId: "claude-session" }),
    entry("stopped-shell", "shell", "/home/dev/active"),
    entry("other-codex", "codex", "/home/dev/other", { resumeSessionId: "other-codex-session" }),
  ], ["/home/dev/active"], ["active-codex", "active-claude"]);

  assert.deepEqual(plan.restore.map((item) => item.id), ["stopped-shell"]);
  assert.deepEqual(plan.live.map((item) => item.id), ["active-codex", "active-claude"]);
  assert.deepEqual(plan.retained.map((item) => item.id), ["other-codex"]);
});

test("restore uses provider session id when resume session id is missing", () => {
  assert.equal(
    savedResumeSessionId(entry("codex-provider-only", "codex", "/home/dev/project", { providerSessionId: "codex-session" })),
    "codex-session",
  );
  assert.equal(
    savedResumeSessionId(entry("codex-resume", "codex", "/home/dev/project", { providerSessionId: "provider-session", resumeSessionId: "resume-session" })),
    "resume-session",
  );
});

test("claude project path candidates include current and legacy encodings", () => {
  const projectsDir = path.join(path.sep, "home", "dev", ".claude", "projects");
  const project = path.join(path.sep, "home", "dev", "My Project");
  assert.deepEqual(
    claudeProjectPathCandidates(projectsDir, project),
    [
      path.join(projectsDir, currentClaudeEncoding(project)),
      path.join(projectsDir, legacyClaudeEncoding(project)),
    ],
  );
});

// Regression for issue #173: the primary encoding must match Claude Code's real
// cwd algorithm (replace every non-alphanumeric char with "-") rather than the
// old encoder that stripped ":" and collapsed/kept "."/separator runs. These
// use literal expected names (not a re-implemented encoder) so the candidate is
// pinned to the directory Claude actually creates on disk.
test("claude project path candidates match Claude's real on-disk encoding", () => {
  const projectsDir = path.join(path.sep, "home", "dev", ".claude", "projects");
  const encodedHead = (workspace) =>
    path.basename(claudeProjectPathCandidates(projectsDir, workspace)[0]);

  // "." must become "-" (e.g. domain-named dirs like example.com), not be kept.
  assert.equal(encodedHead("/home/dev/example.com"), "-home-dev-example-com");

  // A ":" anywhere must become "-" (the Windows drive-letter case generalised),
  // not be stripped. Old encoder produced "-home-dev-weirddir".
  assert.equal(encodedHead("/home/dev/weird:dir"), "-home-dev-weird-dir");

  // Adjacent separators must NOT be collapsed: each char maps one-to-one.
  // Old encoder collapsed the run to a single "-": "-home-dev-foo-bar".
  assert.equal(encodedHead("/home/dev/foo - bar"), "-home-dev-foo---bar");
});

// The headline symptom from issue #173: a Windows drive-letter path. The encoder
// uses the platform's path.resolve, so assert the transformation under win32
// semantics to lock the directory Claude creates on Windows ("C:\\" -> "C--").
test("claude encoding turns a Windows drive-letter colon into a double dash", () => {
  const winEncoding = (workspace) =>
    path.win32.resolve(workspace).replace(/[^A-Za-z0-9]/g, "-");
  assert.equal(winEncoding("C:\\Users\\dev\\Project"), "C--Users-dev-Project");
});

test("codex session discovery reads native jsonl metadata for the selected workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-codex-sessions-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions", "2026", "05", "31");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(
    path.join(sessions, "rollout.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-session-1", cwd: workspace } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: workspace, model: "gpt-5" } }),
    ].join("\n"),
  );

  const sessionId = await codexSessionIdForWorkspace(path.join(root, "sessions"), workspace, Date.now() - 5_000);

  assert.equal(sessionId, "codex-session-1");
});

test("codex session discovery ignores other workspaces and old files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-codex-sessions-"));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other");
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const oldFile = path.join(sessions, "old.jsonl");
  const otherFile = path.join(sessions, "other.jsonl");
  const currentFile = path.join(sessions, "current.jsonl");
  await fs.writeFile(oldFile, JSON.stringify({ type: "session_meta", payload: { id: "old-session", cwd: workspace } }));
  await fs.utimes(oldFile, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  await fs.writeFile(otherFile, JSON.stringify({ type: "session_meta", payload: { id: "other-session", cwd: otherWorkspace } }));
  await fs.writeFile(currentFile, JSON.stringify({ type: "session_meta", payload: { id: "current-session", cwd: workspace } }));

  const sessionId = await codexSessionIdForWorkspace(sessions, workspace, Date.now() - 5_000);

  assert.equal(sessionId, "current-session");
});

test("codex session discovery does not select nested workspace sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-codex-sessions-"));
  const workspace = path.join(root, "workspace");
  const nestedWorkspace = path.join(workspace, "nested");
  const sessions = path.join(root, "sessions");
  await fs.mkdir(nestedWorkspace, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  const rootFile = path.join(sessions, "root.jsonl");
  const nestedFile = path.join(sessions, "nested.jsonl");
  await fs.writeFile(rootFile, JSON.stringify({ type: "session_meta", payload: { id: "root-session", cwd: workspace } }));
  await fs.writeFile(nestedFile, JSON.stringify({ type: "session_meta", payload: { id: "nested-session", cwd: nestedWorkspace } }));
  await fs.utimes(rootFile, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000));
  await fs.utimes(nestedFile, new Date(), new Date());

  const sessionId = await codexSessionIdForWorkspace(sessions, workspace, Date.now() - 5_000);

  assert.equal(sessionId, "root-session");
});

test("codex session discovery skips session ids already attached to other live terminals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-codex-sessions-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(
    path.join(sessions, "claimed.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "claimed-session", cwd: workspace } }),
  );
  await fs.writeFile(
    path.join(sessions, "own.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "own-session", cwd: workspace } }),
  );

  const excluded = await codexSessionIdForWorkspace(sessions, workspace, Date.now(), new Set(["claimed-session"]));
  assert.equal(excluded, "own-session");

  const bothExcluded = await codexSessionIdForWorkspace(sessions, workspace, Date.now(), new Set(["claimed-session", "own-session"]));
  assert.equal(bothExcluded, null);
});

// Issue #137: a long-running neighbor pane's session file has a fresh mtime
// on every turn, but its creation time predates the new pane's spawn. The
// selector must key off creation time, not recency of modification.
test("selectDiscoveredSessionId ignores sessions created before the spawn window", () => {
  const spawnedAtMs = Date.parse("2026-06-10T16:00:00.000Z");
  const picked = selectDiscoveredSessionId(
    [
      { id: "busy-neighbor", createdMs: spawnedAtMs - 60_000 },
      { id: "own-session", createdMs: spawnedAtMs + 2_000 },
    ],
    spawnedAtMs,
  );
  assert.equal(picked, "own-session");
});

test("selectDiscoveredSessionId prefers the session created closest to the spawn", () => {
  const spawnedAtMs = Date.parse("2026-06-10T16:00:00.000Z");
  const picked = selectDiscoveredSessionId(
    [
      { id: "sibling-spawned-later", createdMs: spawnedAtMs + 9_000 },
      { id: "own-session", createdMs: spawnedAtMs + 1_000 },
      { id: "pre-window", createdMs: spawnedAtMs - 11_000 },
    ],
    spawnedAtMs,
  );
  assert.equal(picked, "own-session");
});

test("selectDiscoveredSessionId excludes ids bound to other terminals before ranking", () => {
  const spawnedAtMs = Date.parse("2026-06-10T16:00:00.000Z");
  const picked = selectDiscoveredSessionId(
    [
      { id: "closest-but-claimed", createdMs: spawnedAtMs + 1_000 },
      { id: "own-session", createdMs: spawnedAtMs + 4_000 },
    ],
    spawnedAtMs,
    new Set(["closest-but-claimed"]),
  );
  assert.equal(picked, "own-session");
});

test("effectiveCreationMs uses birthtime when present and never exceeds mtime", () => {
  assert.equal(effectiveCreationMs({ birthtimeMs: 1_000, mtimeMs: 5_000 }), 1_000);
  // Backdated mtime (e.g. utimes in tests or file copies) caps the estimate.
  assert.equal(effectiveCreationMs({ birthtimeMs: 5_000, mtimeMs: 1_000 }), 1_000);
  // Filesystems without birthtime report 0; fall back to mtime.
  assert.equal(effectiveCreationMs({ birthtimeMs: 0, mtimeMs: 5_000 }), 5_000);
});

test("openCodeDatabaseCandidates matches release and channel-suffixed database names", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-opencode-data-"));
  for (const name of ["opencode.db", "opencode-.db", "opencode-dev.db", "opencode.db-wal", "opencode.db-shm", "other.db", "notes.txt"]) {
    await fs.writeFile(path.join(dataDir, name), "");
  }

  assert.deepEqual(
    openCodeDatabaseCandidates(dataDir).map((dbPath) => path.basename(dbPath)),
    ["opencode-.db", "opencode-dev.db", "opencode.db"],
  );
  assert.deepEqual(openCodeDatabaseCandidates(path.join(dataDir, "missing")), []);
});

test("openCodeSessionCandidates keeps only rows for the selected workspace", () => {
  const workspace = path.join(path.sep, "home", "dev", "project");
  const candidates = openCodeSessionCandidates([
    ["ses_own", workspace, 2_000],
    ["ses_other", path.join(path.sep, "home", "dev", "other"), 3_000],
    ["ses_string_time", workspace, "4000"],
    [null, workspace, 5_000],
    ["ses_no_directory", null, 6_000],
  ], workspace);

  assert.deepEqual(candidates, [
    { id: "ses_own", createdMs: 2_000 },
    { id: "ses_string_time", createdMs: 4_000 },
  ]);
});

test("opencode session discovery finds the session created by this spawn", async (t) => {
  if (!(await hasPython())) return t.skip("python3 is not available");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-opencode-db-"));
  const workspace = path.join(root, "workspace");
  const dbPath = path.join(root, "opencode-.db");
  const spawnedAtMs = Date.now();
  await createOpenCodeDb(dbPath, [
    ["ses_old", workspace, spawnedAtMs - 60_000],
    ["ses_own", workspace, spawnedAtMs + 2_000],
    ["ses_other_workspace", path.join(root, "other"), spawnedAtMs + 1_000],
  ]);

  assert.equal(await openCodeSessionIdForWorkspace([dbPath], workspace, spawnedAtMs), "ses_own");
  assert.equal(await openCodeSessionIdForWorkspace([dbPath], workspace, spawnedAtMs, new Set(["ses_own"])), null);
  assert.equal(await openCodeSessionExists([dbPath], "ses_own"), true);
  assert.equal(await openCodeSessionExists([dbPath], "ses_deleted"), false);
  assert.equal(await openCodeSessionExists([path.join(root, "missing.db")], "ses_own"), false);
});

async function hasPython() {
  try {
    await execFileAsync("python3", ["-c", "import sqlite3"]);
    return true;
  } catch {
    return false;
  }
}

async function createOpenCodeDb(dbPath, rows) {
  const script = [
    "import json, sqlite3, sys",
    "con = sqlite3.connect(sys.argv[1])",
    "con.execute('create table session (id text primary key, directory text, project_id text, time_created integer)')",
    "con.execute('create table project (id text primary key, worktree text)')",
    "con.executemany('insert into session (id, directory, project_id, time_created) values (?, ?, null, ?)', json.loads(sys.argv[2]))",
    "con.commit()",
  ].join("\n");
  await execFileAsync("python3", ["-c", script, dbPath, JSON.stringify(rows)]);
}

// Mirror Claude Code's real cwd encoding: every non-alphanumeric char -> "-".
function currentClaudeEncoding(workspace) {
  return path.resolve(workspace).replace(/[^A-Za-z0-9]/g, "-");
}

function legacyClaudeEncoding(workspace) {
  return path.resolve(workspace).replace(/:/g, "").replace(/[\\/]/g, "-");
}
