import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The store lives under os.homedir(); point it at a throwaway home before the
// module under test ever resolves the path.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "athena-agent-messages-"));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;

const {
  agentMessageStorePath,
  createAgentMessage,
  flushAgentMessages,
  listAgentMessages,
  updateAgentMessageStatus,
} = await import("../dist-electron/agent-messages.js");

const DEBOUNCE_MS = 250;
const WORKSPACE = path.join(home, "repo");
const store = agentMessageStorePath();

after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await delay(10);
  }
}

function strayTemporaryFiles() {
  return fs.readdirSync(path.dirname(store)).filter((name) => name.endsWith(".tmp"));
}

function savedMessages() {
  return JSON.parse(fs.readFileSync(store, "utf8"));
}

function send(text) {
  return createAgentMessage({ workspace: WORKSPACE, to: "codex#1", text, source: "test" });
}

test("the store path is isolated under the temporary home", () => {
  assert.ok(store.startsWith(home), store);
  assert.equal(fs.existsSync(store), false);
});

test("several sends within the debounce window coalesce into one async write", async (t) => {
  const writeFile = t.mock.method(fs.promises, "writeFile");
  const rename = t.mock.method(fs, "renameSync");

  const first = send("first");
  updateAgentMessageStatus(first.id, "injecting");
  updateAgentMessageStatus(first.id, "written");
  send("second");
  send("third");

  // Nothing touches disk synchronously; reads are served from memory.
  assert.equal(fs.existsSync(store), false);
  assert.equal(writeFile.mock.callCount(), 0);
  assert.deepEqual(listAgentMessages(WORKSPACE).map((message) => message.text).sort(), ["first", "second", "third"]);

  await waitFor(() => fs.existsSync(store));
  // Give a hypothetical second write every chance to happen.
  await delay(DEBOUNCE_MS * 2);
  assert.equal(writeFile.mock.callCount(), 1);
  assert.equal(rename.mock.callCount(), 1);

  const saved = savedMessages();
  assert.deepEqual(saved.map((message) => message.text).sort(), ["first", "second", "third"]);
  assert.equal(saved.find((message) => message.id === first.id).status, "written");
  assert.deepEqual(strayTemporaryFiles(), []);
});

test("flushAgentMessages persists synchronously and an older in-flight write cannot overwrite it", async (t) => {
  const realWriteFile = fs.promises.writeFile;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let signalWriteStarted;
  const writeStarted = new Promise((resolve) => { signalWriteStarted = resolve; });
  const writeFile = t.mock.method(fs.promises, "writeFile", async (...args) => {
    signalWriteStarted();
    await writeGate;
    return realWriteFile.apply(fs.promises, args);
  });

  const message = send("racing");
  // The debounce fires and the background write of this older snapshot stalls.
  // The writer's debounce timer is unref'd (it must not keep Electron alive),
  // so poll with timers instead of awaiting a bare promise: on Node 22 the
  // test runner cancels a test whose event loop drains while it awaits.
  await waitFor(() => writeFile.mock.callCount() > 0);
  await writeStarted;
  assert.equal(writeFile.mock.callCount(), 1);

  updateAgentMessageStatus(message.id, "output_seen");
  flushAgentMessages();
  // The flush is durable before it returns.
  assert.equal(savedMessages().find((entry) => entry.id === message.id).status, "output_seen");

  // Let the stale write finish; its snapshot still says "queued".
  releaseWrite();
  const staleWrite = writeFile.mock.calls[0].result;
  let staleWriteSettled = false;
  const markSettled = () => { staleWriteSettled = true; };
  staleWrite.then(markSettled, markSettled);
  await waitFor(() => staleWriteSettled);
  await delay(20);

  assert.equal(savedMessages().find((entry) => entry.id === message.id).status, "output_seen");
  assert.deepEqual(strayTemporaryFiles(), []);

  // Everything is persisted, so nothing is rescheduled.
  await delay(DEBOUNCE_MS * 2);
  assert.equal(writeFile.mock.callCount(), 1);
});

test("a flush with nothing pending does not rewrite the store", () => {
  const before = fs.statSync(store).mtimeMs;
  const content = fs.readFileSync(store, "utf8");
  flushAgentMessages();
  assert.equal(fs.statSync(store).mtimeMs, before);
  assert.equal(fs.readFileSync(store, "utf8"), content);
});

test("compact JSON round-trips through the existing read path", async () => {
  const raw = fs.readFileSync(store, "utf8");
  assert.doesNotMatch(raw, /\n/, "the store is written as compact JSON");

  // A fresh module instance has no cache, so it reads the file from disk.
  const fresh = await import(`../dist-electron/agent-messages.js?roundtrip=${Date.now()}`);
  assert.deepEqual(fresh.listAgentMessages(WORKSPACE, 500), listAgentMessages(WORKSPACE, 500));
  assert.deepEqual(fresh.listAgentMessages(null, 500), listAgentMessages(null, 500));
});

test("a failed write removes its partial temp file and backs off instead of spinning", async (t) => {
  const realWriteFile = fs.promises.writeFile;
  let diskFull = true;
  const writeFile = t.mock.method(fs.promises, "writeFile", async (filePath, ...rest) => {
    if (!diskFull) return realWriteFile.call(fs.promises, filePath, ...rest);
    fs.writeFileSync(filePath, "partial");
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });
  t.mock.method(console, "warn", () => undefined);

  const message = send("disk full");
  await waitFor(() => writeFile.mock.callCount() === 1);
  await delay(DEBOUNCE_MS * 2);
  assert.equal(writeFile.mock.callCount(), 1, "the retry waits for its backoff");
  assert.deepEqual(strayTemporaryFiles(), []);
  assert.ok(listAgentMessages(WORKSPACE).some((entry) => entry.id === message.id), "state stays in memory");

  // Space frees up; the backed-off retry persists without any new change.
  diskFull = false;
  await waitFor(() => fs.existsSync(store) && savedMessages().some((entry) => entry.id === message.id));
  assert.equal(writeFile.mock.callCount(), 2);
  assert.deepEqual(strayTemporaryFiles(), []);
});

function renameLock(t, isLocked) {
  const realRename = fs.renameSync;
  const rename = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === store && isLocked()) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
    }
    return realRename(from, to);
  });
  const storeDeletes = [];
  const realUnlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (target, ...rest) => {
    if (target === store) storeDeletes.push("unlinkSync");
    return realUnlink(target, ...rest);
  });
  const realRm = fs.rmSync;
  t.mock.method(fs, "rmSync", (target, ...rest) => {
    if (target === store) storeDeletes.push("rmSync");
    return realRm(target, ...rest);
  });
  return { rename, storeDeletes };
}

test("a transient Windows rename lock is retried and never deletes the store", async (t) => {
  let failures = 2;
  const { rename, storeDeletes } = renameLock(t, () => failures-- > 0);

  const message = send("locked briefly");
  flushAgentMessages();
  assert.equal(rename.mock.callCount(), 3, "two EPERM failures, then success");
  assert.ok(savedMessages().some((entry) => entry.id === message.id));

  // The background writer retries the same way.
  failures = 2;
  const next = send("locked briefly again");
  await waitFor(() => savedMessages().some((entry) => entry.id === next.id));
  assert.deepEqual(storeDeletes, []);
  assert.deepEqual(strayTemporaryFiles(), []);
});

test("a persistent rename lock keeps the previous store and the new snapshot until it clears", async (t) => {
  let locked = true;
  const { rename, storeDeletes } = renameLock(t, () => locked);
  t.mock.method(console, "warn", () => undefined);
  const before = fs.readFileSync(store, "utf8");

  const message = send("locked for good");
  await waitFor(() => rename.mock.callCount() >= 4);
  await delay(50);
  // Previous complete store untouched, never deleted; the snapshot is retained.
  assert.equal(fs.readFileSync(store, "utf8"), before);
  assert.deepEqual(storeDeletes, []);
  assert.equal(strayTemporaryFiles().length, 1);
  assert.ok(listAgentMessages(WORKSPACE).some((entry) => entry.id === message.id), "state stays in memory");

  // The shutdown flush also gives up without harming the store.
  flushAgentMessages();
  assert.equal(fs.readFileSync(store, "utf8"), before);

  locked = false;
  flushAgentMessages();
  assert.ok(savedMessages().some((entry) => entry.id === message.id));
  assert.deepEqual(storeDeletes, []);
  assert.deepEqual(strayTemporaryFiles(), [], "retained snapshots are cleaned up after a successful write");
});

test("legacy pretty-printed stores remain readable", async () => {
  const legacy = [{
    id: "legacy-1",
    threadId: "thread-1",
    at: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    workspace: WORKSPACE,
    from: "claude#1",
    fromTerminalId: null,
    to: "codex#1",
    toTerminalId: null,
    toKind: null,
    text: "from an older Athena build",
    preview: "from an older Athena build",
    status: "written",
    replyRequested: false,
    hopCount: 0,
    source: "electron-control",
    error: null,
  }];
  fs.writeFileSync(store, JSON.stringify(legacy, null, 2));
  const fresh = await import(`../dist-electron/agent-messages.js?legacy=${Date.now()}`);
  assert.deepEqual(fresh.listAgentMessages(WORKSPACE).map((message) => message.id), ["legacy-1"]);
});
