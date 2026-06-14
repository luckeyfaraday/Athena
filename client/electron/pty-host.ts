import * as pty from "node-pty";
import type { PtyHostMessage, PtyHostRequest, PtyHostSpawnRequest } from "./pty-host-protocol.js";
import { PTY_WRITE_CHUNK_DELAY_MS, PTY_WRITE_CHUNK_SIZE, chunkPtyWrite } from "./pty-write.js";

const terminals = new Map<string, pty.IPty>();
const pendingOutput = new Map<string, string>();
// Tail of the in-flight write for each terminal, so chunked Windows writes
// never interleave with a later write to the same PTY (see enqueueWrite).
const writeChains = new Map<string, Promise<void>>();
const FLUSH_INTERVAL_MS = 16;
const MAX_BATCH_CHARS = 64_000;
let flushTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function send(message: PtyHostMessage): void {
  if (!process.send || !process.connected) {
    shutdown(0);
    return;
  }
  try {
    process.send(message);
  } catch {
    shutdown(1);
  }
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
  terminal.onData((data) => queueOutput(payload.id, data));
  terminal.onExit(({ exitCode }) => {
    flushOutput(payload.id);
    terminals.delete(payload.id);
    writeChains.delete(payload.id);
    send({ type: "exit", id: payload.id, exitCode });
  });
  return terminal.pid;
}

function queueOutput(id: string, data: string): void {
  const next = (pendingOutput.get(id) ?? "") + data;
  if (next.length >= MAX_BATCH_CHARS) {
    pendingOutput.set(id, next);
    flushOutput(id);
    return;
  }
  pendingOutput.set(id, next);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAllOutput();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

function flushOutput(id: string): void {
  const data = pendingOutput.get(id);
  if (!data) return;
  pendingOutput.delete(id);
  send({ type: "data", id, data });
}

function flushAllOutput(): void {
  for (const id of Array.from(pendingOutput.keys())) flushOutput(id);
}

function requireTerminal(id: string): pty.IPty {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error(`PTY not found: ${id}`);
  return terminal;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

// On Windows, large single writes overflow ConPTY's bounded console input
// buffer and get silently truncated, so we feed them in small chunks with a
// short pause between each. Unix PTYs have real flow control and write in one
// shot. The terminal is re-resolved before every chunk because it can be killed
// during the inter-chunk delays. See pty-write.ts for the full rationale.
async function writeTerminal(id: string, data: string): Promise<void> {
  if (process.platform !== "win32" || data.length <= PTY_WRITE_CHUNK_SIZE) {
    requireTerminal(id).write(data);
    return;
  }
  const chunks = chunkPtyWrite(data, PTY_WRITE_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await delay(PTY_WRITE_CHUNK_DELAY_MS);
    requireTerminal(id).write(chunks[i]);
  }
}

// Serialize writes per terminal so a chunked Windows write never has its chunks
// interleaved with a later write to the same PTY (the synchronous write path
// was previously atomic). The promise stored in the chain swallows rejections
// so one failed write doesn't break the ordering of the writes behind it; the
// caller still observes the real outcome through the returned promise.
function enqueueWrite(id: string, data: string): Promise<void> {
  const prior = writeChains.get(id) ?? Promise.resolve();
  const result = prior.then(() => writeTerminal(id, data));
  writeChains.set(
    id,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

process.on("message", (message: PtyHostRequest) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  try {
    if (message.type === "spawn") {
      response(message.requestId, true, spawnTerminal(message.payload));
      return;
    }
    if (message.type === "write") {
      const { requestId, id } = message;
      enqueueWrite(id, message.data).then(
        () => response(requestId, true, null),
        (error) => {
          const detail = String(error);
          send({ type: "error", id, error: detail });
          response(requestId, false, detail);
        },
      );
      return;
    }
    if (message.type === "resize") {
      requireTerminal(message.id).resize(Math.max(20, Math.floor(message.cols)), Math.max(6, Math.floor(message.rows)));
      response(message.requestId, true, null);
      return;
    }
    if (message.type === "kill") {
      flushOutput(message.id);
      requireTerminal(message.id).kill();
      terminals.delete(message.id);
      writeChains.delete(message.id);
      response(message.requestId, true, null);
      return;
    }
    if (message.type === "shutdown") {
      shutdown(0);
      response(message.requestId, true, null);
    }
  } catch (error) {
    const id = "id" in message && typeof message.id === "string" ? message.id : null;
    const detail = String(error);
    send({ type: "error", id, error: detail });
    response(message.requestId, false, detail);
  }
});

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushAllOutput();
  for (const terminal of terminals.values()) terminal.kill();
  terminals.clear();
  pendingOutput.clear();
  writeChains.clear();
  setTimeout(() => process.exit(exitCode), 0).unref?.();
}

process.on("disconnect", () => {
  shutdown(0);
});

process.on("uncaughtException", (error) => {
  send({ type: "error", id: null, error: String(error) });
  shutdown(1);
});

process.on("unhandledRejection", (error) => {
  send({ type: "error", id: null, error: String(error) });
  shutdown(1);
});
