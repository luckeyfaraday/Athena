import assert from "node:assert/strict";
import test from "node:test";

import { liveTerminalAgentSession } from "../dist-electron/agent-sessions.js";

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
