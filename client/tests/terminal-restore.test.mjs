import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";

import { claudeProjectPathCandidates, newestCodexSessionIdForWorkspace, savedResumeSessionId, selectEmbeddedTerminalRestoreEntries } from "../dist-electron/terminal-restore-policy.js";

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
  const dottedProject = path.join(path.sep, "home", "dev", "project.name");
  assert.deepEqual(
    claudeProjectPathCandidates(projectsDir, project),
    [
      path.join(projectsDir, currentClaudeEncoding(project)),
      path.join(projectsDir, legacyClaudeEncoding(project)),
    ],
  );

  assert.deepEqual(
    claudeProjectPathCandidates(projectsDir, dottedProject),
    [
      path.join(projectsDir, currentClaudeEncoding(dottedProject)),
    ],
  );
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

  const sessionId = await newestCodexSessionIdForWorkspace(path.join(root, "sessions"), workspace, Date.now() - 5_000);

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

  const sessionId = await newestCodexSessionIdForWorkspace(sessions, workspace, Date.now() - 5_000);

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

  const sessionId = await newestCodexSessionIdForWorkspace(sessions, workspace, Date.now() - 5_000);

  assert.equal(sessionId, "root-session");
});

function currentClaudeEncoding(workspace) {
  return path.resolve(workspace).replace(/:/g, "").replace(/[^A-Za-z0-9.]+/g, "-");
}

function legacyClaudeEncoding(workspace) {
  return path.resolve(workspace).replace(/:/g, "").replace(/[\\/]/g, "-");
}
