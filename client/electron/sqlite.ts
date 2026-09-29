import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as NodeSqlite from "node:sqlite";

export type SqliteValue = string | number | null;

export type SqliteQuery = {
  dbPath: string;
  sql: string;
  params: string[];
};

/** A Python interpreter invocation: `command ...args -c <script> ...`. */
export type PythonCommand = {
  command: string;
  args: string[];
};

const PYTHON_QUERY_TIMEOUT_MS = 2500;
// Busy timeout for the in-process driver. node:sqlite is synchronous, so a
// wait on a locked database blocks the calling thread: the Electron main
// process fails fast (callers poll/retry anyway), the session-index child may
// wait briefly. Either way a locked database degrades to "no rows" as before.
const NODE_SQLITE_BUSY_TIMEOUT_MS = 100;
const MAIN_PROCESS_BUSY_TIMEOUT_MS = 0;

export type SqliteQueryOptions = {
  /** node:sqlite busy timeout; defaults to 0 on the Electron main thread. */
  busyTimeoutMs?: number;
};
// After every interpreter candidate failed, do not re-probe on every query.
const PYTHON_NEGATIVE_CACHE_MS = 5 * 60_000;

/**
 * Run a read-only query against a sqlite database. Any failure (locked or
 * malformed database, missing driver) yields an empty result set so callers
 * degrade gracefully instead of breaking the surrounding feature.
 *
 * Electron 36 (Node 22) ships `node:sqlite`, which answers in-process in a few
 * milliseconds. Runtimes without it fall back to a cached system Python.
 */
export async function querySqlite(dbPath: string, sql: string, params: string[], options: SqliteQueryOptions = {}): Promise<SqliteValue[][]> {
  return (await querySqliteBatch([{ dbPath, sql, params }], options))[0] ?? [];
}

/**
 * Run several read-only queries, possibly against different databases, with
 * at most one interpreter process. Results are positional; a failed query
 * yields [] without affecting its neighbours.
 */
export async function querySqliteBatch(queries: readonly SqliteQuery[], options: SqliteQueryOptions = {}): Promise<SqliteValue[][][]> {
  if (queries.length === 0) return [];
  const sqlite = loadNodeSqlite();
  if (sqlite) {
    const busyTimeoutMs = busyTimeout(options.busyTimeoutMs);
    return queries.map((query) => queryWithNodeSqlite(sqlite, query, busyTimeoutMs));
  }
  return defaultPythonRunner().run(queries);
}

/** Which driver querySqlite uses in this process (for diagnostics and tests). */
export function sqliteBackend(): "node:sqlite" | "python" {
  return loadNodeSqlite() ? "node:sqlite" : "python";
}

type NodeSqliteModule = typeof NodeSqlite;
let nodeSqlite: NodeSqliteModule | null | undefined;

function loadNodeSqlite(): NodeSqliteModule | null {
  if (nodeSqlite !== undefined) return nodeSqlite;
  nodeSqlite = null;
  if (process.env.ATHENA_SQLITE_DRIVER === "python") return nodeSqlite;
  try {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltinModule !== "function") return nodeSqlite;
    const loaded = withoutSqliteExperimentalWarning(() => getBuiltinModule.call(process, "node:sqlite")) as NodeSqliteModule | undefined;
    // Array rows (setReturnArrays) keep duplicate column names positional,
    // matching the Python driver's row shape.
    if (loaded
      && typeof loaded.DatabaseSync === "function"
      && typeof loaded.StatementSync?.prototype?.setReturnArrays === "function"
      && typeof loaded.StatementSync?.prototype?.setReadBigInts === "function") {
      nodeSqlite = loaded;
    }
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite;
}

function withoutSqliteExperimentalWarning<T>(load: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (typeof message === "string" && message.startsWith("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = original;
  }
}

function busyTimeout(requested: number | undefined): number {
  if (requested !== undefined && Number.isFinite(requested) && requested >= 0) return Math.floor(requested);
  // process.type is "browser" only in the Electron main process (undefined in
  // ELECTRON_RUN_AS_NODE children and plain Node).
  return (process as { type?: string }).type === "browser" ? MAIN_PROCESS_BUSY_TIMEOUT_MS : NODE_SQLITE_BUSY_TIMEOUT_MS;
}

function queryWithNodeSqlite(sqlite: NodeSqliteModule, query: SqliteQuery, busyTimeoutMs: number): SqliteValue[][] {
  let database: NodeSqlite.DatabaseSync | null = null;
  try {
    database = new sqlite.DatabaseSync(query.dbPath, { readOnly: true, timeout: busyTimeoutMs });
    const statement = database.prepare(query.sql);
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    const rows = statement.all(...query.params) as unknown as unknown[][];
    return rows.map((row) => row.map(normalizeSqliteValue));
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a database that failed to open is best-effort.
    }
  }
}

function normalizeSqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  // Python's json.dumps -> JSON.parse rounds 64-bit integers to the nearest
  // double; Number(bigint) rounds identically.
  if (typeof value === "bigint") return Number(value);
  // Python's json.dumps rejects BLOBs, failing the whole query; mirror that.
  throw new Error("Unsupported sqlite value type");
}

// ---------------------------------------------------------------------------
// Python fallback
// ---------------------------------------------------------------------------

const PYTHON_BATCH_SCRIPT = [
  "import json, sqlite3, sys",
  "results = []",
  "for q in json.loads(sys.argv[1]):",
  "    try:",
  "        con = sqlite3.connect('file:' + q['db'] + '?mode=ro', uri=True, timeout=0.25)",
  "        try:",
  "            con.row_factory = lambda cursor, row: list(row)",
  "            rows = con.execute(q['sql'], q['params']).fetchall()",
  "            json.dumps(rows)",
  "            results.append(rows)",
  "        finally:",
  "            con.close()",
  "    except Exception:",
  "        results.append(None)",
  "print(json.dumps({'athena_sqlite': 1, 'results': results}))",
].join("\n");

export type PythonExec = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

export type PythonSqliteRunnerOptions = {
  candidates?: () => PythonCommand[];
  exec?: PythonExec;
  now?: () => number;
};

/**
 * Runs sqlite queries through a system Python, resolving the interpreter once.
 *
 * Candidates are tried in order until one produces the script's JSON envelope;
 * that interpreter is then reused for every later batch. Interpreters that
 * cannot start (ENOENT, the Windows Store alias stub's exit 9009, ...) are
 * never retried, and when all fail the runner stays quiet for a while instead
 * of re-probing on every query.
 */
export class PythonSqliteRunner {
  private readonly candidates: () => PythonCommand[];
  private readonly exec: PythonExec;
  private readonly now: () => number;
  private resolved: PythonCommand | null = null;
  private readonly rejected = new Set<string>();
  private unavailableUntil = 0;

  constructor(options: PythonSqliteRunnerOptions = {}) {
    this.candidates = options.candidates ?? (() => pythonCandidates());
    this.exec = options.exec ?? defaultPythonExec;
    this.now = options.now ?? Date.now;
  }

  get resolvedCommand(): PythonCommand | null {
    return this.resolved ? { command: this.resolved.command, args: [...this.resolved.args] } : null;
  }

  async run(queries: readonly SqliteQuery[]): Promise<SqliteValue[][][]> {
    const empty = queries.map((): SqliteValue[][] => []);
    if (queries.length === 0) return empty;
    const payload = JSON.stringify(queries.map((query) => ({ db: query.dbPath, sql: query.sql, params: query.params })));

    if (this.resolved) {
      const attempt = await this.tryCommand(this.resolved, payload, queries.length);
      // A resolved interpreter that stops working (uninstalled, broken) is
      // re-resolved on the next batch; this batch degrades to no rows.
      if (attempt.status === "unusable") this.resolved = null;
      return attempt.status === "ok" ? attempt.results : empty;
    }
    if (this.now() < this.unavailableUntil) return empty;
    if (this.unavailableUntil > 0) {
      // The negative cache expired: allow a fresh probe (Python may have been
      // installed meanwhile).
      this.rejected.clear();
      this.unavailableUntil = 0;
    }

    for (const candidate of this.candidates()) {
      const key = commandKey(candidate);
      if (this.rejected.has(key)) continue;
      const attempt = await this.tryCommand(candidate, payload, queries.length);
      if (attempt.status === "ok") {
        this.resolved = candidate;
        return attempt.results;
      }
      // Timeouts are not evidence that the interpreter is unusable.
      if (attempt.status === "unusable") this.rejected.add(key);
    }
    this.unavailableUntil = this.now() + PYTHON_NEGATIVE_CACHE_MS;
    return empty;
  }

  private async tryCommand(
    command: PythonCommand,
    payload: string,
    count: number,
  ): Promise<{ status: "ok"; results: SqliteValue[][][] } | { status: "unusable" | "transient" }> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(command.command, [...command.args, "-c", PYTHON_BATCH_SCRIPT, payload], {
        timeout: PYTHON_QUERY_TIMEOUT_MS,
      }));
    } catch (error) {
      const failure = error as { killed?: boolean; signal?: string | null } | null;
      return { status: failure?.killed || failure?.signal ? "transient" : "unusable" };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return { status: "unusable" };
    }
    if (!envelope || typeof envelope !== "object" || (envelope as { athena_sqlite?: unknown }).athena_sqlite !== 1) {
      return { status: "unusable" };
    }
    const results = (envelope as { results?: unknown }).results;
    if (!Array.isArray(results)) return { status: "unusable" };
    return {
      status: "ok",
      results: Array.from({ length: count }, (_unused, index) => {
        const rows = results[index];
        return Array.isArray(rows) ? rows.filter(Array.isArray) as SqliteValue[][] : [];
      }),
    };
  }
}

function commandKey(command: PythonCommand): string {
  return [command.command, ...command.args].join("\u0000");
}

function defaultPythonExec(command: string, args: string[], options: { timeout: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: options.timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

export type PythonCandidateOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (filePath: string) => boolean;
};

/**
 * Ordered interpreter candidates. POSIX keeps the historical python3, python
 * order. On Windows the PATH is resolved up front so `python3`/`python` never
 * hit the Microsoft Store alias stub in %LOCALAPPDATA%\Microsoft\WindowsApps
 * (≈700 ms to print an install hint and exit 9009) while a real interpreter or
 * the `py -3` launcher exists; WindowsApps aliases are kept only as a last
 * resort because they do work when the Store Python is installed.
 */
export function pythonCandidates(options: PythonCandidateOptions = {}): PythonCommand[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const override = env.CONTEXT_WORKSPACE_PYTHON?.trim();
  const candidates: PythonCommand[] = [];
  const add = (candidate: PythonCommand): void => {
    if (!candidates.some((existing) => commandKey(existing) === commandKey(candidate))) candidates.push(candidate);
  };
  if (override) add({ command: override, args: [] });
  if (platform !== "win32") {
    add({ command: "python3", args: [] });
    add({ command: "python", args: [] });
    return candidates;
  }

  const isFile = options.isFile ?? defaultIsFile;
  const pathValue = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = pathValue.split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const stubs: PythonCommand[] = [];
  for (const [name, args] of [["python", []], ["py", ["-3"]], ["python3", []]] as const) {
    let found = false;
    for (const directory of directories) {
      const candidate = path.win32.join(directory, `${name}.exe`);
      if (!isFile(candidate)) continue;
      if (isWindowsAppsAlias(candidate)) {
        stubs.push({ command: candidate, args: [...args] });
        continue;
      }
      add({ command: candidate, args: [...args] });
      found = true;
      break;
    }
    // `py` also lives in %WINDIR% even when that directory is not on PATH.
    if (!found && name === "py" && env.WINDIR) {
      const launcher = path.win32.join(env.WINDIR, "py.exe");
      if (isFile(launcher)) add({ command: launcher, args: [...args] });
    }
  }
  for (const stub of stubs) add(stub);
  return candidates;
}

export function isWindowsAppsAlias(executablePath: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(executablePath);
}

function defaultIsFile(filePath: string): boolean {
  try {
    // App execution aliases are zero-byte reparse points; lstat still reports
    // them as present, which is all this ordering needs.
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

let pythonRunner: PythonSqliteRunner | null = null;

function defaultPythonRunner(): PythonSqliteRunner {
  pythonRunner ??= new PythonSqliteRunner();
  return pythonRunner;
}
