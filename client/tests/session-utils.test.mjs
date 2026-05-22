import assert from "node:assert/strict";
import test from "node:test";

import {
  embeddedSessionKey,
} from "../src/session-rename-keys.ts";

function embeddedSession(overrides = {}) {
  return {
    id: "terminal-1",
    title: "Codex Resume",
    kind: "codex",
    workspace: "/workspace",
    pid: 123,
    promptPath: null,
    initialTask: null,
    sessionLabel: "Previous task",
    providerSessionId: null,
    createdAt: "2026-05-23T00:00:00.000Z",
    status: "running",
    exitCode: null,
    error: null,
    ...overrides,
  };
}

test("embedded shell rename keys stay tied to the terminal id", () => {
  assert.equal(embeddedSessionKey(embeddedSession({ kind: "shell", providerSessionId: null })), "embedded:terminal-1");
});

test("embedded agent rename keys use the provider session id when available", () => {
  assert.equal(
    embeddedSessionKey(embeddedSession({ id: "terminal-2", providerSessionId: "codex-run-123" })),
    "embedded-provider:codex:codex-run-123",
  );
});

test("embedded agent rename keys survive restored terminal ids", () => {
  const original = embeddedSession({ id: "terminal-before-quit", providerSessionId: "codex-run-123" });
  const restored = embeddedSession({ id: "terminal-after-restore", providerSessionId: "codex-run-123" });

  assert.equal(embeddedSessionKey(restored), embeddedSessionKey(original));
});
