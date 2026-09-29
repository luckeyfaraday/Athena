import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isWindowsAppsAlias,
  PythonSqliteRunner,
  pythonCandidates,
  querySqlite,
  querySqliteBatch,
  sqliteBackend,
} from "../dist-electron/sqlite.js";

const STUB_DIR = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps";

test("Windows interpreter candidates put Store alias stubs last and prefer python / py -3", () => {
  const realDir = "C:\\Python311";
  const files = new Set([
    `${STUB_DIR}\\python.exe`,
    `${STUB_DIR}\\python3.exe`,
    `${realDir}\\python.exe`,
    "C:\\Windows\\py.exe",
  ]);
  const candidates = pythonCandidates({
    platform: "win32",
    // The stub directory comes first on PATH, as it does on stock Windows.
    env: { PATH: `${STUB_DIR};${realDir}`, WINDIR: "C:\\Windows" },
    isFile: (candidate) => files.has(candidate),
  });
  assert.deepEqual(candidates, [
    { command: `${realDir}\\python.exe`, args: [] },
    { command: "C:\\Windows\\py.exe", args: ["-3"] },
    { command: `${STUB_DIR}\\python.exe`, args: [] },
    { command: `${STUB_DIR}\\python3.exe`, args: [] },
  ]);
  assert.equal(isWindowsAppsAlias(`${STUB_DIR}\\python3.exe`), true);
  assert.equal(isWindowsAppsAlias(`${realDir}\\python.exe`), false);
});

test("POSIX interpreter candidates keep the historical python3, python order", () => {
  assert.deepEqual(pythonCandidates({ platform: "linux", env: {} }), [
    { command: "python3", args: [] },
    { command: "python", args: [] },
  ]);
  assert.deepEqual(pythonCandidates({ platform: "darwin", env: { CONTEXT_WORKSPACE_PYTHON: "/opt/py/bin/python3" } })[0], {
    command: "/opt/py/bin/python3",
    args: [],
  });
});

function fakePython(behaviour) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(command);
    const outcome = behaviour[command];
    if (outcome instanceof Error) throw outcome;
    const queries = JSON.parse(args.at(-1));
    return { stdout: JSON.stringify({ athena_sqlite: 1, results: queries.map((query) => [[query.db, query.sql]]) }) };
  };
  return { calls, exec };
}

const query = (dbPath) => ({ dbPath, sql: "select 1", params: [] });

test("the Python runner resolves an interpreter once, batches queries, and never re-spawns a stub", async () => {
  const stubFailure = Object.assign(new Error("Python was not found; run without arguments to install from the Microsoft Store"), { code: 9009 });
  const { calls, exec } = fakePython({ stub: stubFailure });
  const runner = new PythonSqliteRunner({
    candidates: () => [{ command: "stub", args: [] }, { command: "real", args: [] }],
    exec,
  });

  assert.deepEqual(await runner.run([query("a.db"), query("b.db")]), [[["a.db", "select 1"]], [["b.db", "select 1"]]]);
  assert.deepEqual(calls, ["stub", "real"], "two queries cost one interpreter process once resolved");
  assert.deepEqual(await runner.run([query("c.db")]), [[["c.db", "select 1"]]]);
  assert.deepEqual(calls, ["stub", "real", "real"], "the resolved interpreter is reused and the stub never re-spawned");
  assert.deepEqual(runner.resolvedCommand, { command: "real", args: [] });
});

test("the Python runner caches total unavailability and treats timeouts as transient", async () => {
  let now = 0;
  const missing = Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" });
  const timeout = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
  const behaviour = { missing, slow: timeout };
  const { calls, exec } = fakePython(behaviour);
  const runner = new PythonSqliteRunner({
    candidates: () => [{ command: "missing", args: [] }, { command: "slow", args: [] }],
    exec,
    now: () => now,
  });

  assert.deepEqual(await runner.run([query("a.db")]), [[]]);
  assert.deepEqual(calls, ["missing", "slow"]);
  assert.deepEqual(await runner.run([query("a.db")]), [[]]);
  assert.deepEqual(calls, ["missing", "slow"], "no re-probe while the negative cache is fresh");

  now += 5 * 60_000 + 1;
  behaviour.slow = undefined;
  assert.deepEqual(await runner.run([query("b.db")]), [[["b.db", "select 1"]]]);
  assert.deepEqual(calls, ["missing", "slow", "missing", "slow"], "an expired negative cache re-probes every candidate");
});

async function nodeSqlite() {
  try {
    return process.getBuiltinModule?.("node:sqlite") ?? null;
  } catch {
    return null;
  }
}

test("querySqlite answers in-process with positional rows and degrades to no rows", async (t) => {
  const sqlite = await nodeSqlite();
  if (!sqlite || sqliteBackend() !== "node:sqlite") return t.skip("node:sqlite is not available in this runtime");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-sqlite-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "state.db");
  const database = new sqlite.DatabaseSync(dbPath);
  try {
    database.exec("create table t (id text, n integer, big integer, payload blob)");
    database.prepare("insert into t values (?, ?, ?, ?)").run("x", 1, 9007199254740993n, null);
    database.prepare("insert into t values (?, ?, ?, ?)").run("y", 2, 3, Buffer.from("blob"));
  } finally {
    database.close();
  }

  // Duplicate column names stay positional, like the Python driver's rows.
  assert.deepEqual(await querySqlite(dbPath, "select id, n, id from t where id = ?", ["x"]), [["x", 1, "x"]]);
  assert.deepEqual(await querySqlite(dbPath, "select big from t where id = ?", ["x"]), [[9007199254740992]]);
  assert.deepEqual(await querySqlite(dbPath, "select payload from t where id = ?", ["y"]), [], "BLOBs fail the query like Python's JSON encoder");
  assert.deepEqual(await querySqlite(dbPath, "select nope from t", []), []);
  assert.deepEqual(await querySqlite(path.join(root, "missing.db"), "select 1", []), []);
  assert.deepEqual(await querySqlite(dbPath, "insert into t values ('z', 3, 3, null)", []), [], "connections are read-only");
  assert.deepEqual(await querySqlite(dbPath, "select count(*) from t", []), [[2]]);

  assert.deepEqual(
    await querySqliteBatch([
      { dbPath, sql: "select id from t order by n", params: [] },
      { dbPath: path.join(root, "missing.db"), sql: "select 1", params: [] },
    ]),
    [[["x"], ["y"]], []],
  );
});

test("a locked database fails fast with busyTimeoutMs 0 (Electron main-thread callers)", async (t) => {
  const sqlite = await nodeSqlite();
  if (!sqlite || sqliteBackend() !== "node:sqlite") return t.skip("node:sqlite is not available in this runtime");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-sqlite-lock-"));
  const dbPath = path.join(root, "locked.db");
  const writer = new sqlite.DatabaseSync(dbPath);
  t.after(async () => {
    try {
      writer.close();
    } catch {
      // Already closed.
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  writer.exec("create table session (id text)");
  writer.exec("begin exclusive");
  try {
    let started = performance.now();
    assert.deepEqual(await querySqlite(dbPath, "select count(*) from session", [], { busyTimeoutMs: 0 }), []);
    assert.ok(performance.now() - started < 80, "no busy wait on the calling thread");
    started = performance.now();
    assert.deepEqual(await querySqlite(dbPath, "select count(*) from session", [], { busyTimeoutMs: 150 }), []);
    assert.ok(performance.now() - started >= 100, "an explicit busy timeout still waits (session-index child)");
  } finally {
    writer.exec("rollback");
  }
  assert.deepEqual(await querySqlite(dbPath, "select count(*) from session", [], { busyTimeoutMs: 0 }), [[0]]);
});
