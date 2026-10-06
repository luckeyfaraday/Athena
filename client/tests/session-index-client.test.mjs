import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { SessionIndexClient } from "../dist-electron/session-index-client.js";

const diagnostics = {
  filesSeen: 1,
  filesStatted: 1,
  filesParsed: 1,
  bytesParsed: 100,
  cacheHits: 0,
  durationMs: 1,
  lastError: null,
};

function indexedSession(id) {
  return {
    id,
    title: id,
    model: null,
    agent: "Hermes",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();

  schedule = (callback, delayMs) => {
    const timer = {
      id: this.nextId++,
      due: this.now + delayMs,
      callback,
      unref() {},
    };
    this.timers.set(timer.id, timer);
    return timer;
  };

  cancel = (timer) => {
    this.timers.delete(timer.id);
  };

  advance(delayMs) {
    const target = this.now + delayMs;
    while (true) {
      const due = Array.from(this.timers.values())
        .filter((timer) => timer.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!due) break;
      this.now = due.due;
      this.timers.delete(due.id);
      due.callback();
    }
    this.now = target;
  }
}

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  channel = { unref() {} };
  sent = [];
  callbacks = [];
  killCalls = 0;
  disconnectCalls = 0;

  unref() {}

  send(message, callback) {
    this.sent.push(message);
    this.callbacks.push(callback);
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
    return true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  respond(requestIndex, sessions) {
    const request = this.sent[requestIndex];
    this.emit("message", {
      type: "response",
      requestId: request.requestId,
      ok: true,
      sessions,
      diagnostics,
    });
  }

  exit(code = 0, signal = null) {
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

function fixture({ requestTimeoutMs = 100, restartBackoffMs = 100 } = {}) {
  const clock = new FakeClock();
  const children = [];
  const client = new SessionIndexClient({
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    requestTimeoutMs,
    restartBackoffMs,
  });
  return { client, clock, children };
}

test("remote scans opt out of silent stale fallback while local callers retain it", async () => {
  const { client, clock, children } = fixture();
  const known = indexedSession("known");
  const seed = client.listAgentSessions("/work/a");
  clock.advance(0);
  children[0].respond(0, { "/work/a": [known] });
  await seed;
  const remote = client.listAgentSessions("/work/a", false);
  const local = client.listAgentSessions("/work/a");
  clock.advance(100);
  assert.equal(await remote, null);
  assert.deepEqual(await local, [known]);
});

test("a timeout retires its exact worker, resolves all of that worker's requests, and restarts after bounded backoff", async () => {
  const { client, clock, children } = fixture();
  const sessionA = indexedSession("known-a");
  const sessionB = indexedSession("known-b");

  const seedA = client.listHermes("/work/a");
  const seedB = client.listHermes("/work/b");
  clock.advance(0);
  children[0].respond(0, { "/work/a": [sessionA], "/work/b": [sessionB] });
  assert.deepEqual(await seedA, [sessionA]);
  assert.deepEqual(await seedB, [sessionB]);

  const pendingA = client.listHermes("/work/a");
  clock.advance(0);
  const pendingB = client.listHermes("/work/b");
  clock.advance(0);
  assert.equal(children[0].sent.length, 3);

  clock.advance(100);
  assert.deepEqual(await pendingA, [sessionA]);
  assert.deepEqual(await pendingB, [sessionB]);
  assert.equal(children[0].killCalls, 1);
  assert.equal(children[0].disconnectCalls, 1);

  const duringBackoff = client.listHermes("/work/a");
  clock.advance(0);
  assert.deepEqual(await duringBackoff, [sessionA]);
  assert.equal(children.length, 1, "backoff must not create a restart loop");

  clock.advance(100);
  const recovered = client.listHermes("/work/a");
  clock.advance(0);
  assert.equal(children.length, 2);
  assert.notEqual(children[1], children[0]);

  // Late events from the retired generation cannot retire or resolve the new one.
  children[0].exit(0, null);
  const fresh = indexedSession("fresh-a");
  children[1].respond(0, { "/work/a": [fresh] });
  assert.deepEqual(await recovered, [fresh]);
});

test("an IPC send error retires the worker and resolves every request assigned to it", async () => {
  const { client, clock, children } = fixture();
  const first = client.listHermes("/work/first");
  clock.advance(0);
  const second = client.listHermes("/work/second");
  clock.advance(0);

  children[0].callbacks[1](new Error("IPC channel closed"));
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.equal(children[0].killCalls, 1);
  assert.equal(children.length, 1);

  clock.advance(100);
  const recovered = client.listHermes("/work/first");
  clock.advance(0);
  assert.equal(children.length, 2);
  const fresh = indexedSession("fresh");
  children[1].respond(0, { "/work/first": [fresh] });
  assert.deepEqual(await recovered, [fresh]);
});

function agentSession(id) {
  return {
    id,
    provider: "claude",
    title: id,
    workspace: "/work/a",
    branch: null,
    model: null,
    agent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: null,
    metadata: {},
  };
}

test("agent-session and Hermes requests share one worker but keep separate last-known results", async () => {
  const { client, clock, children } = fixture();
  const hermes = client.listHermes("/work/a");
  const agents = client.listAgentSessions("/work/a");
  clock.advance(0);
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].sent.map((message) => message.type), ["list-hermes", "list-agent-sessions"]);
  const hermesSession = indexedSession("hermes-a");
  const claudeSession = agentSession("claude-a");
  children[0].respond(0, { "/work/a": [hermesSession] });
  children[0].respond(1, { "/work/a": [claudeSession] });
  assert.deepEqual(await hermes, [hermesSession]);
  assert.deepEqual(await agents, [claudeSession]);

  // The worker times out: known workspaces fall back to their own kind's
  // last result, unknown ones report null so the caller can scan itself.
  const pendingKnown = client.listAgentSessions("/work/a");
  const pendingUnknown = client.listAgentSessions("/work/b");
  const pendingHermesUnknown = client.listHermes("/work/b");
  clock.advance(0);
  clock.advance(100);
  assert.deepEqual(await pendingKnown, [claudeSession]);
  assert.equal(await pendingUnknown, null);
  assert.deepEqual(await pendingHermesUnknown, [], "Hermes keeps its historical empty fallback");
});

test("a clean idle worker exit allows the next request to restart immediately", async () => {
  const { client, clock, children } = fixture({ restartBackoffMs: 10_000 });
  const first = client.listHermes("/work/idle");
  clock.advance(0);
  children[0].respond(0, { "/work/idle": [] });
  assert.deepEqual(await first, []);

  children[0].exit(0, null);
  const next = client.listHermes("/work/idle");
  clock.advance(0);
  assert.equal(children.length, 2, "clean idle exit must not inherit failure backoff");
  children[1].respond(0, { "/work/idle": [] });
  assert.deepEqual(await next, []);
});
