import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRemotePort } from "./remote-access.js";

export type ServerOptions = {
  command: "run" | "token" | "status" | "service-file" | "help";
  dataDir: string;
  port: number | null;
  localOnly: boolean;
  backend: boolean;
  restore: boolean;
  workspaces: string[];
};

export function parseServerOptions(args: string[]): ServerOptions {
  const result: ServerOptions = {
    command: "run", dataDir: path.join(os.homedir(), ".context-workspace", "server"),
    port: null, localOnly: false, backend: true, restore: false, workspaces: [],
  };
  const rest = [...args];
  if (rest[0] && !rest[0].startsWith("-")) {
    const command = rest.shift()!;
    if (!["run", "token", "status", "service-file"].includes(command)) throw new Error(`Unknown server command: ${command}`);
    result.command = command as ServerOptions["command"];
  }
  while (rest.length) {
    const flag = rest.shift()!;
    if (flag === "--help" || flag === "-h") { result.command = "help"; continue; }
    if (flag === "--local-only") { result.localOnly = true; continue; }
    if (flag === "--no-backend") { result.backend = false; continue; }
    if (flag === "--restore") { result.restore = true; continue; }
    if (!["--data-dir", "--port", "--workspace"].includes(flag)) throw new Error(`Unknown server option: ${flag}`);
    const value = rest.shift();
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--data-dir") result.dataDir = path.resolve(value);
    if (flag === "--port") result.port = normalizeRemotePort(value);
    if (flag === "--workspace") result.workspaces.push(path.resolve(value));
  }
  return result;
}

/** Hold one instance per data directory. Never change an existing live instance. */
export function acquireServerLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "server.lock");
  const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, owner, { flag: "wx", mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(file, "utf8") === owner) fs.unlinkSync(file); } catch { /* Already removed. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: unknown;
      try { pid = JSON.parse(fs.readFileSync(file, "utf8")).pid; } catch { /* A concurrently starting owner may be writing. */ }
      if (!Number.isInteger(pid) || Number(pid) <= 0) throw new Error(`Server lock cannot be read: ${file}`);
      try {
        process.kill(Number(pid), 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") { fs.unlinkSync(file); continue; }
      }
      throw new Error(`Athena server is already running for ${dataDir} (PID ${pid}).`);
    }
  }
  throw new Error(`Could not acquire the server lock in ${dataDir}.`);
}

export function serverServiceFile(options: ServerOptions, entry: string, python: string): string {
  const quote = (value: string) => {
    if (/[\r\n\0]/.test(value)) throw new Error("Service paths and environment must be single-line values.");
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  };
  const args = [process.execPath, entry, "run", "--data-dir", options.dataDir];
  if (options.port != null) args.push("--port", String(options.port));
  if (options.restore) args.push("--restore");
  if (options.localOnly) args.push("--local-only");
  if (!options.backend) args.push("--no-backend");
  for (const workspace of options.workspaces) args.push("--workspace", workspace);
  return [
    "[Unit]", "Description=Athena agent and terminal server", "After=network-online.target", "",
    "[Service]", "Type=simple", `ExecStart=${args.map((arg) => quote(arg).replace(/\$/g, "$$$$")).join(" ")}`,
    `Environment=${quote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}`,
    `Environment=${quote(`CONTEXT_WORKSPACE_PYTHON=${python}`)}`,
    "Restart=on-failure", "RestartSec=5", "TimeoutStopSec=35", "KillMode=control-group", "UMask=0077", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}
