import * as pty from "node-pty";
import {
  PtyFlowGate,
  afterOutputQuiet,
  type PtyHostInbound,
  type PtyHostMessage,
  type PtyHostSpawnRequest,
} from "./pty-host-protocol.js";
import { DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS, TerminalOutputBatcher } from "./terminal-buffer.js";
import { PTY_WRITE_CHUNK_DELAY_MS, PTY_WRITE_CHUNK_SIZE, chunkPtyWrite } from "./pty-write.js";

const terminals = new Map<string, pty.IPty>();
// Tail of the in-flight write for each terminal, so chunked Windows writes
// never interleave with a later write to the same PTY (see enqueueWrite).
const writeChains = new Map<string, Promise<void>>();
const FLUSH_INTERVAL_MS = 16;
// Output is coalesced for up to FLUSH_INTERVAL_MS, but a batch is sent early
// as soon as the next chunk would exceed the cap. Nothing is ever truncated.
const output = new TerminalOutputBatcher(
  (id, data) => send({ type: "data", id, data }),
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
);
// Backpressure requested by main when a consumer of this terminal's output is
// far behind (POSIX only; the gate ignores pause requests on Windows). Pausing
// stops reading the PTY, so the child blocks on its own writes instead of main
// dropping output. While paused, process liveness is polled so a child that
// exits mid-pause is resumed before node-pty destroys the unread socket.
const flow = new PtyFlowGate({
  pause: (id) => {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    terminal.pause();
    return true;
  },
  resume: (id) => {
    try {
      terminals.get(id)?.resume();
    } catch {
      // A socket already torn down has nothing left to read.
    }
  },
  isAlive: (id) => {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    try {
      process.kill(terminal.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
});
// Terminals released from a pause and awaiting kill/shutdown: last output time.
const drainingOutputAt = new Map<string, number>();
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
    flow.release(payload.id);
    output.flush(payload.id);
    terminals.delete(payload.id);
    writeChains.delete(payload.id);
    send({ type: "exit", id: payload.id, exitCode });
  });
  return terminal.pid;
}

function queueOutput(id: string, data: string): void {
  if (drainingOutputAt.has(id)) drainingOutputAt.set(id, Date.now());
  if (output.push(id, data)) scheduleFlush();
}

/**
 * Release a paused PTY and wait for its buffered output to drain (no output
 * for ~50ms, capped at ~300ms) before `done`, so a kill never discards the
 * backlog that built up while paused. Immediate when nothing was paused, which
 * is always the case on Windows.
 */
function releaseAndDrain(ids: string[], done: () => void): void {
  const paused = ids.filter((id) => flow.isPaused(id));
  if (paused.length === 0) {
    done();
    return;
  }
  const startedAt = Date.now();
  for (const id of paused) {
    drainingOutputAt.set(id, startedAt);
    flow.release(id);
  }
  afterOutputQuiet(
    () => Math.max(...paused.map((id) => drainingOutputAt.get(id) ?? startedAt)),
    () => {
      for (const id of paused) drainingOutputAt.delete(id);
      done();
    },
  );
}

function killTerminal(id: string, terminal: pty.IPty): void {
  output.flush(id);
  flow.release(id);
  // The child may have exited on its own while its output drained.
  if (terminals.get(id) === terminal) {
    terminal.kill();
    terminals.delete(id);
    writeChains.delete(id);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    output.flushAll();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
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

process.on("message", (message: PtyHostInbound) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "flow") {
    try {
      if (typeof message.id === "string") flow.apply(message.id, message.paused === true);
    } catch {
      // A PTY torn down between main's decision and this message is harmless;
      // flow control is advisory and never worth failing the host over.
    }
    return;
  }
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
      const { requestId, id } = message;
      const terminal = requireTerminal(id);
      // Never kill a paused PTY: resume it and let the backlog drain first.
      releaseAndDrain([id], () => {
        try {
          killTerminal(id, terminal);
          response(requestId, true, null);
        } catch (error) {
          const detail = String(error);
          send({ type: "error", id, error: detail });
          response(requestId, false, detail);
        }
      });
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
  const finish = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    output.flushAll();
    try {
      flow.releaseAll();
    } catch {
      // Best effort: every PTY is killed next regardless.
    }
    for (const terminal of terminals.values()) terminal.kill();
    terminals.clear();
    output.clear();
    writeChains.clear();
    setTimeout(() => process.exit(exitCode), 0).unref?.();
  };
  // With main still connected, give paused PTYs their bounded drain first;
  // otherwise there is nobody left to receive the output.
  if (process.connected) releaseAndDrain(flow.pausedIds(), finish);
  else finish();
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
