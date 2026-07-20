import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedTtlPromiseCache,
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
