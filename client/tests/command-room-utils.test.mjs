import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRelativeTime,
  matchesSessionQuery,
  paneInstanceNumbers,
  paneStatusLabel,
  workspaceFolderName,
} from "../src/session-utils.ts";

const now = Date.parse("2026-09-29T12:00:00.000Z");
const ago = (seconds) => new Date(now - seconds * 1000).toISOString();

function pane(overrides = {}) {
  return {
    id: "pane-1",
    title: "Codex",
    kind: "codex",
    workspace: "C:\\Projects\\athena",
    pid: 1,
    promptPath: null,
    initialTask: null,
    sessionLabel: null,
    providerSessionId: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    status: "running",
    exitCode: null,
    error: null,
    ...overrides,
  };
}

function agentSession(overrides = {}) {
  return {
    id: "019a2b3c-session",
    provider: "claude",
    title: "Fix the flaky upload test",
    workspace: "/work/athena",
    branch: "fix/upload",
    model: "claude-opus-5-5",
    agent: null,
    createdAt: ago(3600),
    updatedAt: ago(600),
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: "claude --resume 019a2b3c-session",
    metadata: {},
    ...overrides,
  };
}

test("relative times read naturally", () => {
  assert.equal(formatRelativeTime(ago(5), now), "just now");
  assert.equal(formatRelativeTime(ago(59), now), "just now");
  assert.equal(formatRelativeTime(ago(60), now), "1 min ago");
  assert.equal(formatRelativeTime(ago(59 * 60), now), "59 min ago");
  assert.equal(formatRelativeTime(ago(3 * 3600), now), "3 hr ago");
  assert.equal(formatRelativeTime(ago(30 * 3600), now), "yesterday");
  assert.equal(formatRelativeTime(ago(3 * 86400), now), "3 days ago");
  assert.equal(formatRelativeTime(ago(8 * 86400), now), "last week");
  assert.equal(formatRelativeTime(ago(20 * 86400), now), "2 weeks ago");
  assert.equal(formatRelativeTime("not a date", now), "unknown");
});

test("future timestamps from clock skew never read as negative", () => {
  assert.equal(formatRelativeTime(new Date(now + 90_000).toISOString(), now), "just now");
});

test("session search matches every term across title, id, branch, model and provider", () => {
  const session = agentSession();
  assert.equal(matchesSessionQuery(session, ""), true);
  assert.equal(matchesSessionQuery(session, "   "), true);
  assert.equal(matchesSessionQuery(session, "flaky"), true);
  assert.equal(matchesSessionQuery(session, "UPLOAD opus"), true);
  assert.equal(matchesSessionQuery(session, "019a2b3c"), true);
  assert.equal(matchesSessionQuery(session, "fix/upload"), true);
  assert.equal(matchesSessionQuery(session, "claude"), true);
  assert.equal(matchesSessionQuery(session, "flaky codex"), false);
  assert.equal(matchesSessionQuery(agentSession({ provider: "athena", model: null }), "athena code"), true);
});

test("panes are numbered per kind and workspace, oldest first", () => {
  const sessions = [
    pane({ id: "c2", createdAt: "2026-09-29T10:05:00.000Z" }),
    pane({ id: "c1", createdAt: "2026-09-29T10:00:00.000Z" }),
    pane({ id: "s1", kind: "shell", title: "Shell" }),
    pane({ id: "c-other", workspace: "C:/Projects/other" }),
    pane({ id: "c3", workspace: "c:/projects/athena/", createdAt: "2026-09-29T10:09:00.000Z" }),
  ];
  const numbers = paneInstanceNumbers(sessions);
  assert.deepEqual(numbers.get("c1"), { number: 1, total: 3 });
  assert.deepEqual(numbers.get("c2"), { number: 2, total: 3 });
  assert.deepEqual(numbers.get("c3"), { number: 3, total: 3 });
  assert.deepEqual(numbers.get("s1"), { number: 1, total: 1 });
  assert.deepEqual(numbers.get("c-other"), { number: 1, total: 1 });
});

test("pane status labels explain how a pane ended", () => {
  assert.equal(paneStatusLabel(pane()), "Running");
  assert.equal(paneStatusLabel(pane({ status: "exited", exitCode: 0 })), "Exited with code 0");
  assert.equal(paneStatusLabel(pane({ status: "exited", exitCode: null })), "Exited");
  assert.equal(paneStatusLabel(pane({ status: "failed", error: "spawn ENOENT" })), "Failed: spawn ENOENT");
});

test("workspace folder names come from the last path segment", () => {
  assert.equal(workspaceFolderName("C:\\Users\\me\\athena\\"), "athena");
  assert.equal(workspaceFolderName("/home/me/projects/site"), "site");
  assert.equal(workspaceFolderName("/"), "/");
});
