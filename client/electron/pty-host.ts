import * as pty from "node-pty";
import type { PtyHostMessage, PtyHostRequest, PtyHostSpawnRequest } from "./pty-host-protocol.js";

const terminals = new Map<string, pty.IPty>();

function send(message: PtyHostMessage): void {
  if (process.send) process.send(message);
}

function response(requestId: string, ok: true, pid?: number | null): void;
function response(requestId: string, ok: false, error: string): void;
function response(requestId: string, ok: boolean, value?: number | string | null): void {
  if (ok) {
    send({ requestId, ok: true, pid: typeof value === "number" ? value : null });
  } else {
    send({ requestId, ok: false, error: String(value ?? "PTY host request failed.") });
  }
}

function spawnTerminal(payload: PtyHostSpawnRequest): number {
  if (terminals.has(payload.id)) throw new Error(`PTY already exists: ${payload.id}`);
  const terminal = pty.spawn(payload.command, payload.args, {
    name: "xterm-256color",
    cwd: payload.cwd,
    cols: payload.cols,
    rows: payload.rows,
    env: payload.env,
  });
  terminals.set(payload.id, terminal);
  terminal.onData((data) => send({ type: "data", id: payload.id, data }));
  terminal.onExit(({ exitCode }) => {
    terminals.delete(payload.id);
    send({ type: "exit", id: payload.id, exitCode });
  });
  return terminal.pid;
}

function requireTerminal(id: string): pty.IPty {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error(`PTY not found: ${id}`);
  return terminal;
}

process.on("message", (message: PtyHostRequest) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  try {
    if (message.type === "spawn") {
      response(message.requestId, true, spawnTerminal(message.payload));
      return;
    }
    if (message.type === "write") {
      requireTerminal(message.id).write(message.data);
      response(message.requestId, true, null);
      return;
    }
    if (message.type === "resize") {
      requireTerminal(message.id).resize(Math.max(20, Math.floor(message.cols)), Math.max(6, Math.floor(message.rows)));
      response(message.requestId, true, null);
      return;
    }
    if (message.type === "kill") {
      requireTerminal(message.id).kill();
      terminals.delete(message.id);
      response(message.requestId, true, null);
      return;
    }
    if (message.type === "shutdown") {
      for (const terminal of terminals.values()) terminal.kill();
      terminals.clear();
      response(message.requestId, true, null);
      process.exit(0);
    }
  } catch (error) {
    const id = "id" in message && typeof message.id === "string" ? message.id : null;
    const detail = String(error);
    send({ type: "error", id, error: detail });
    response(message.requestId, false, detail);
  }
});

process.on("uncaughtException", (error) => {
  send({ type: "error", id: null, error: String(error) });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  send({ type: "error", id: null, error: String(error) });
  process.exit(1);
});
