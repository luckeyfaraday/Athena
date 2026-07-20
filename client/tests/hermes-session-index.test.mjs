import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { HermesSessionIndex } from "../dist-electron/hermes-session-index.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-hermes-index-"));
  const sessions = path.join(root, "sessions");
  const cachePath = path.join(root, "cache", "index.json");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(root, "state.db"), "fixture");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, sessions, cachePath };
}

function session(overrides = {}) {
  return {
    session_id: "session-1",
    model: "model-from-file",
    platform: "cli",
    session_start: "2026-01-01T00:00:00.000Z",
    last_updated: "2026-01-02T00:00:00.000Z",
    messages: [{ role: "user", content: "Indexed title" }],
    ...overrides,
  };
}

async function writeSession(sessionsDir, id, value) {
  await fs.writeFile(path.join(sessionsDir, `session_${id}.json`), JSON.stringify(value));
}

test("Hermes index filters before its result limit and preserves descendant workspace matching", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  const rows = [];
  for (let index = 0; index < 105; index += 1) {
    const id = `unrelated-${index}`;
    rows.push([id, "cli", "model", 2_000 + index, 3_000 + index, 1, `Unrelated ${index}`]);
    await writeSession(sessions, id, session({ session_id: id, workspace: `/other/${index}` }));
  }
  rows.push(["older-match", "cli", "db-model", 1_000, 1_001, 1, "Older matching session"]);
  await writeSession(sessions, "older-match", session({ session_id: "older-match", workspace: "/work/project/child" }));

  const index = new HermesSessionIndex({ cachePath, queryDatabase: async () => rows });
  const result = await index.list(["/work/project"], root);

  assert.deepEqual(result["/work/project"].map((entry) => entry.id), ["older-match"]);
  assert.equal(result["/work/project"][0].model, "db-model");
});

test("Hermes index includes root descendants and isolates case-distinct POSIX workspaces", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  await writeSession(sessions, "upper", session({ session_id: "upper", workspace: "/Work/Project" }));
  await writeSession(sessions, "lower", session({ session_id: "lower", workspace: "/work/project" }));
  const rows = [
    ["upper", "cli", "model", 2_000, 2_000, 1, "Upper"],
    ["lower", "cli", "model", 1_000, 1_000, 1, "Lower"],
  ];
  const index = new HermesSessionIndex({ cachePath, queryDatabase: async () => rows });

  const result = await index.list(["/", "/Work/Project", "/work/project"], root);

  assert.deepEqual(new Set(result["/"].map((entry) => entry.id)), new Set(["upper", "lower"]));
  assert.deepEqual(result["/Work/Project"].map((entry) => entry.id), ["upper"]);
  assert.deepEqual(result["/work/project"].map((entry) => entry.id), ["lower"]);
});

test("Hermes index preserves embedded-path fallback without persisting transcript search text", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  const secretTranscript = "DO_NOT_RETAIN_THIS_TRANSCRIPT_PAYLOAD";
  await writeSession(sessions, "embedded", session({
    session_id: "embedded",
    system_prompt: "The active project is /work/context-workspace and its descendants.",
    messages: [
      { role: "user", content: "Embedded path title" },
      { role: "assistant", content: secretTranscript },
    ],
  }));
  const rows = [["embedded", "cli", "model", 1_000, 2_000, 1, null]];
  const index = new HermesSessionIndex({ cachePath, queryDatabase: async () => rows });

  const result = await index.list(["/work/context-workspace"], root);
  assert.deepEqual(result["/work/context-workspace"].map((entry) => entry.id), ["embedded"]);

  const persisted = await fs.readFile(cachePath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(secretTranscript));
  assert.doesNotMatch(persisted, /searchText/);
  const persistedEntry = JSON.parse(persisted).entries[0];
  assert.ok(Buffer.byteLength(persistedEntry.workspaceHints.join(""), "utf8") <= 16_384);
});

test("Hermes index retains last-known-good metadata when a changed file is temporarily corrupt", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  const filePath = path.join(sessions, "session-stable.json");
  await writeSession(sessions, "stable", session({ session_id: "stable", workspace: "/work/stable" }));
  const rows = [["stable", "cli", null, 1_000, null, 1, null]];
  const index = new HermesSessionIndex({ cachePath, queryDatabase: async () => rows });

  const first = await index.list(["/work/stable"], root);
  assert.equal(first["/work/stable"][0].title, "Indexed title");

  await fs.writeFile(filePath, "{ corrupt and incomplete json payload");
  const future = new Date(Date.now() + 2_000);
  await fs.utimes(filePath, future, future);
  const second = await index.list(["/work/stable"], root);

  assert.equal(second["/work/stable"][0].title, "Indexed title");
  assert.equal(second["/work/stable"][0].model, "model-from-file");
});

test("Hermes index classifies a newly requested workspace without losing prior matches", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  await writeSession(sessions, "shared", session({
    session_id: "shared",
    system_prompt: "Handoff between /work/first-project and /work/second-project. Active path: /home/alan/My Project with spaces",
  }));
  const rows = [["shared", "cli", "model", 1_000, 2_000, 1, null]];
  let sessionFileReads = 0;
  const index = new HermesSessionIndex({
    cachePath,
    queryDatabase: async () => rows,
    readSessionFile: async (filePath) => {
      sessionFileReads += 1;
      return fs.readFile(filePath, "utf8");
    },
  });

  const first = await index.list(["/work/first-project"], root);
  assert.equal(sessionFileReads, 1);
  assert.equal(index.getDiagnostics().filesParsed, 1);
  assert.ok(index.getDiagnostics().bytesParsed > 0);
  sessionFileReads = 0;
  const second = await index.list(["/work/second-project"], root);
  const warmDiagnostics = index.getDiagnostics();
  const both = await index.list(["/work/first-project", "/work/second-project", "/home/alan/My Project"], root);

  assert.equal(first["/work/first-project"][0].id, "shared");
  assert.equal(second["/work/second-project"][0].id, "shared");
  assert.equal(both["/work/first-project"][0].id, "shared");
  assert.equal(both["/work/second-project"][0].id, "shared");
  assert.equal(both["/home/alan/My Project"][0].id, "shared");
  assert.equal(sessionFileReads, 0, "unchanged files must be classified from persisted path hints");
  assert.equal(warmDiagnostics.filesParsed, 0);
  assert.equal(warmDiagnostics.bytesParsed, 0);
  assert.equal(warmDiagnostics.cacheHits, 1);
});

test("Hermes index keeps database metadata across a transient empty query", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  await writeSession(sessions, "db-stable", session({ session_id: "db-stable", workspace: "/work/db-stable" }));
  let calls = 0;
  const index = new HermesSessionIndex({
    cachePath,
    queryDatabase: async () => {
      calls += 1;
      return calls === 1 ? [["db-stable", "cli", "db-model", 1_000, 2_000, 1, "Database title"]] : [];
    },
  });

  const first = await index.list(["/work/db-stable"], root);
  const second = await index.list(["/work/db-stable"], root);

  assert.equal(first["/work/db-stable"][0].title, "Database title");
  assert.equal(second["/work/db-stable"][0].title, "Database title");
  assert.equal(second["/work/db-stable"][0].model, "db-model");
});

test("overlapping list calls wait for one complete persisted-index load before refreshing", async (t) => {
  const { root, sessions, cachePath } = await fixture(t);
  await writeSession(sessions, "overlap", session({ session_id: "overlap", workspace: "/work/overlap" }));
  let startCacheRead;
  const cacheReadStarted = new Promise((resolve) => {
    startCacheRead = resolve;
  });
  let releaseCacheRead;
  const cacheReadGate = new Promise((resolve) => {
    releaseCacheRead = resolve;
  });
  let databaseQueries = 0;
  const index = new HermesSessionIndex({
    cachePath,
    readCacheFile: async () => {
      startCacheRead();
      await cacheReadGate;
      return JSON.stringify({ version: 2, hermesDir: root, entries: [] });
    },
    queryDatabase: async () => {
      databaseQueries += 1;
      return [["overlap", "cli", "model", 1_000, 2_000, 1, "Overlapping session"]];
    },
  });

  const first = index.list(["/work/overlap"], root);
  await cacheReadStarted;
  const second = index.list(["/work/overlap"], root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(databaseQueries, 0, "refresh must not race an incomplete cache load");

  releaseCacheRead();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(databaseQueries, 1, "overlapping lists must share the refresh after loading");
  assert.deepEqual(firstResult["/work/overlap"].map((entry) => entry.id), ["overlap"]);
  assert.deepEqual(secondResult["/work/overlap"].map((entry) => entry.id), ["overlap"]);
});

test("session-index host returns compact results over IPC and exits when idle", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "athena-session-host-"));
  const sessions = path.join(home, ".hermes", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await writeSession(sessions, "ipc", session({ session_id: "ipc", workspace: "/work/ipc-project" }));
  const child = fork(path.resolve(testsDir, "../dist-electron/session-index-host.js"), [], {
    execPath: process.execPath,
    execArgv: [],
    env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await fs.rm(home, { recursive: true, force: true });
  });

  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session-index host response timed out")), 5_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  child.send({ type: "list-hermes", requestId: "request-1", workspaces: ["/work/ipc-project"] });
  const response = await responsePromise;

  assert.equal(response.ok, true);
  assert.deepEqual(response.sessions["/work/ipc-project"].map((entry) => entry.id), ["ipc"]);
  assert.equal(response.diagnostics.filesParsed, 1);
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
});
