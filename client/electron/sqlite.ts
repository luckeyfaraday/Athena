import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SqliteValue = string | number | null;

/**
 * Run a read-only query against a sqlite database via the system Python, which
 * ships a sqlite3 module everywhere we run. Any failure (missing Python,
 * locked or malformed database) yields an empty result set so callers degrade
 * gracefully instead of breaking the surrounding feature.
 */
export async function querySqlite(dbPath: string, sql: string, params: string[]): Promise<SqliteValue[][]> {
  const script = [
    "import json, sqlite3, sys",
    "db, sql, params = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])",
    "con = sqlite3.connect('file:' + db + '?mode=ro', uri=True, timeout=0.25)",
    "con.row_factory = lambda cursor, row: list(row)",
    "print(json.dumps(con.execute(sql, params).fetchall()))",
  ].join("\n");
  for (const executable of ["python3", "python"]) {
    try {
      const { stdout } = await execFileAsync(executable, ["-c", script, dbPath, sql, JSON.stringify(params)], {
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout) as SqliteValue[][];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Try the next Python executable, then gracefully return no rows.
    }
  }
  return [];
}
