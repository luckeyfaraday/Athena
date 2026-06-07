import assert from "node:assert/strict";
import test from "node:test";

import {
  agentHandle,
  resolveAgentTarget,
} from "../dist-electron/agent-routing.js";

function session(id, workspace, kind = "codex", createdAt = "2026-06-07T10:00:00Z") {
  return {
    id,
    title: id,
    kind,
    workspace,
    pid: 1,
    promptPath: null,
    initialTask: null,
    sessionLabel: null,
    providerSessionId: null,
    createdAt,
    status: "running",
    exitCode: null,
    error: null,
  };
}

test("agent handles are numbered independently within each workspace", () => {
  const sessions = [
    session("repo-a-first", "/repo/a"),
    session("repo-b-first", "/repo/b"),
    session("repo-a-second", "/repo/a", "codex", "2026-06-07T11:00:00Z"),
  ];

  assert.equal(agentHandle(sessions[0], sessions), "codex#1");
  assert.equal(agentHandle(sessions[1], sessions), "codex#1");
  assert.equal(agentHandle(sessions[2], sessions), "codex#2");
});

test("workspace-scoped handles resolve to the intended terminal", () => {
  const sessions = [
    session("repo-a", "/repo/a"),
    session("repo-b", "/repo/b"),
  ];

  assert.equal(resolveAgentTarget("codex#1", sessions, "/repo/b").id, "repo-b");
  assert.equal(resolveAgentTarget("codex", sessions, "/repo/b").id, "repo-b");
});

test("unscoped duplicate handles fail instead of routing to the wrong workspace", () => {
  const sessions = [
    session("repo-a", "/repo/a"),
    session("repo-b", "/repo/b"),
  ];

  assert.throws(
    () => resolveAgentTarget("codex#1", sessions),
    /ambiguous across workspaces/,
  );
});

test("terminal ids remain globally resolvable without a workspace", () => {
  const sessions = [
    session("repo-a", "/repo/a"),
    session("repo-b", "/repo/b"),
  ];

  assert.equal(resolveAgentTarget("repo-b", sessions).id, "repo-b");
});
