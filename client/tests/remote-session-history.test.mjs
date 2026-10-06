import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSessionHistory } from "../dist-electron/remote-session-history.js";

const row = (id, workspace = "/work/project") => ({
  id: String(id), provider: "claude", title: `Session ${id}`, workspace,
  branch: null, model: null, agent: null, createdAt: "2026-01-01", updatedAt: "2026-01-02",
  status: "historical", terminalId: null, pid: null, resumeCommand: `claude --resume ${id}`, metadata: {},
});

test("idle history does no work; concurrent viewers share a scan even beyond the cache TTL", async () => {
  let calls = 0;
  let now = 0;
  let resolve;
  const history = new RemoteSessionHistory(() => { calls++; return new Promise((done) => { resolve = done; }); }, () => now);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 0);
  const first = history.list("/work/project");
  now = 40_000;
  const second = history.list("/work/project");
  await assert.rejects(history.list("/work/other"), (error) => error.status === 503);
  assert.equal(calls, 1);
  resolve([row("one")]);
  assert.deepEqual(await first, await second);
  now = 69_999;
  assert.equal((await history.list("/work/project")).sessions[0].id, "one");
  assert.equal(calls, 1, "TTL starts on completion, not scan start");
});

test("pages retain a snapshot, require no scan and reject cursors from another workspace or expired snapshot", async () => {
  let calls = 0;
  let now = 0;
  const history = new RemoteSessionHistory(async (workspace) => { calls++; return Array.from({ length: 205 }, (_, i) => row(i, workspace)); }, () => now);
  const first = await history.list("/work/project");
  assert.equal(first.sessions.length, 100);
  now = 31_000;
  const second = await history.list("/work/project", first.nextCursor);
  const third = await history.list("/work/project", second.nextCursor);
  assert.equal(third.sessions.length, 5);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map((s) => s.id)).size, 205);
  assert.equal(calls, 1);
  await assert.rejects(history.list("/work/other", first.nextCursor), (error) => error.status === 409);
  await history.list("/work/project");
  await assert.rejects(history.list("/work/project", first.nextCursor), (error) => error.status === 409);
});

test("worker failure returns stale metadata with a warning and backs off; never silently reports an empty history", async () => {
  let now = 0;
  let calls = 0;
  const history = new RemoteSessionHistory(async () => ++calls === 1 ? [row("cached")] : null, () => now);
  await history.list("/work/project");
  now = 31_000;
  const stale = await history.list("/work/project");
  assert.match(stale.warning, /cached history/);
  assert.equal(stale.sessions[0].id, "cached");
  await history.list("/work/project");
  assert.equal(calls, 2);
  await assert.rejects(history.list("/work/other"), (error) => error.status === 503);
  const unavailable = new RemoteSessionHistory(async () => null);
  await assert.rejects(unavailable.list("/work/project"), (error) => error.status === 503);
});

test("wire pages and retained metadata are bounded, stripping transcript metadata", async () => {
  const history = new RemoteSessionHistory(async () => Array.from({ length: 6000 }, (_, i) => ({
    ...row(i), title: "🐱".repeat(2000), workspace: "/" + "x".repeat(3000),
    metadata: { transcript: "secret transcript".repeat(1000) },
  })));
  let page = await history.list("/work/project");
  assert.match(page.warning, /limit/);
  let totalBytes = 0;
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    for (const session of page.sessions) {
      assert.deepEqual(session.metadata, {});
      assert.ok(session.title.length <= 512);
      totalBytes += Buffer.byteLength(JSON.stringify(session)) + 1;
    }
    if (!page.nextCursor) break;
    page = await history.list("/work/project", page.nextCursor);
  } while (true);
  assert.ok(totalBytes <= 2 * 1024 * 1024);
});

test("workspace cache eviction bounds memory and paths retain case on POSIX hosts", async () => {
  const calls = [];
  const history = new RemoteSessionHistory(async (workspace) => { calls.push(workspace); return [row(workspace)]; });
  for (let i = 0; i < 9; i++) await history.list(`/work/${i}`);
  await history.list("/work/0");
  assert.equal(calls.length, 10);
  await history.list("/work/Case");
  await history.list("/work/case");
  assert.deepEqual(calls.slice(-2), ["/work/Case", "/work/case"]);
});

test("malformed cursors never start a scan", async () => {
  let calls = 0;
  const history = new RemoteSessionHistory(async () => { calls++; return []; });
  for (const cursor of ["wrong", "x".repeat(500), "11111111-1111-1111-1111-111111111111:-1"]) {
    await assert.rejects(history.list("/work/project", cursor), (error) => error.status === 409);
  }
  assert.equal(calls, 0);
});

test("formatting large metadata results yields to terminal traffic between pages", async () => {
  const history = new RemoteSessionHistory(async () => Array.from({ length: 1000 }, (_, i) => row(i)));
  const pending = history.list("/work/project");
  let eventHandled = false;
  setImmediate(() => { eventHandled = true; });
  await pending;
  assert.equal(eventHandled, true);
});
