import assert from "node:assert/strict";
import test from "node:test";

import { canAutoRestoreEmbeddedTerminal, claudeProjectPathCandidates, selectEmbeddedTerminalRestoreEntries } from "../dist-electron/terminal-restore-policy.js";

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

test("claude project path candidates include current and legacy encodings", () => {
  assert.deepEqual(
    claudeProjectPathCandidates("/home/dev/.claude/projects", "/home/dev/My Project"),
    [
      "/home/dev/.claude/projects/-home-dev-My-Project",
      "/home/dev/.claude/projects/-home-dev-My Project",
    ],
  );

  assert.deepEqual(
    claudeProjectPathCandidates("/home/dev/.claude/projects", "/home/dev/project.name"),
    [
      "/home/dev/.claude/projects/-home-dev-project.name",
    ],
  );
});

test("saved terminal entries are not auto-restored as live PTYs", () => {
  for (const kind of ["shell", "hermes", "codex", "opencode", "claude"]) {
    assert.equal(canAutoRestoreEmbeddedTerminal(entry(`${kind}-1`, kind)), false);
  }
});
