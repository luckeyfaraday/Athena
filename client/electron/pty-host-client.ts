import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PtyHostMessage, PtyHostRequest, PtyHostSpawnRequest } from "./pty-host-protocol.js";

type PendingRequest = {
  resolve: (value: number | null) => void;
  reject: (error: Error) => void;
};

type PtyHostClientRequest =
  | { type: "spawn"; payload: PtyHostSpawnRequest }
  | { type: "write"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "kill"; id: string }
  | { type: "shutdown" };

type PtyHostClientEvents = {
  data: [{ id: string; data: string }];
  exit: [{ id: string; exitCode: number | null }];
  error: [{ id: string | null; error: string }];
  crash: [{ ids: string[]; error: string }];
};

class TypedEventEmitter extends EventEmitter {
  override on<K extends keyof PtyHostClientEvents>(event: K, listener: (...args: PtyHostClientEvents[K]) => void): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof PtyHostClientEvents>(event: K, ...args: PtyHostClientEvents[K]): boolean {
    return super.emit(event, ...args);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_FORCE_KILL_MS = 1_500;

export class PtyHostClient extends TypedEventEmitter {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private terminalIds = new Set<string>();
  private nextRequestId = 1;
  private stopping = false;
  private shutdownPromise: Promise<void> | null = null;

  async spawn(payload: PtyHostSpawnRequest): Promise<number> {
    const pid = await this.request({ type: "spawn", payload });
    if (typeof pid !== "number") throw new Error("PTY host did not return a PID.");
    this.terminalIds.add(payload.id);
    return pid;
  }

  async write(id: string, data: string): Promise<void> {
    await this.request({ type: "write", id, data });
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: "resize", id, cols, rows });
  }

  async kill(id: string): Promise<void> {
    await this.request({ type: "kill", id }).catch((error) => {
      if (!String(error).includes("PTY not found")) throw error;
    });
    this.terminalIds.delete(id);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (!this.child || this.child.killed) return Promise.resolve();
    const child = this.child;
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let fallbackTimer: NodeJS.Timeout | null = null;
      let forceTimer: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const onError = (error: Error) => finish(error);
      forceTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        // ChildProcess normally emits exit after kill. Do not hang application
        // shutdown forever if the platform fails to deliver that event, but do
        // reject so launch state is not falsely marked clean.
        fallbackTimer = setTimeout(
          () => finish(new Error("PTY host did not confirm exit after forced shutdown.")),
          250,
        );
        fallbackTimer.unref?.();
      }, SHUTDOWN_FORCE_KILL_MS);
      forceTimer.unref?.();
      child.once("exit", onExit);
      child.once("error", onError);
      // The host flushes its pending output, kills every owned PTY and exits.
      // A request rejection merely accelerates the forced-kill fallback.
      void this.request({ type: "shutdown" }).catch(() => {
        if (!child.killed) child.kill("SIGKILL");
      });
    });
    return this.shutdownPromise;
  }

  private request(request: PtyHostClientRequest): Promise<number | null> {
    const child = this.ensureChild();
    const requestId = String(this.nextRequestId++);
    const payload = { ...request, requestId } as PtyHostRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`PTY host request timed out: ${request.type}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send?.(payload, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        pending?.reject(error);
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    if (this.stopping) throw new Error("PTY host is shutting down.");
    const hostPath = path.join(__dirname, "pty-host.js");
    const child = fork(hostPath, [], {
      execPath: process.execPath,
      execArgv: [],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    this.stopping = false;
    child.stdout?.on("data", (chunk) => process.stdout.write(`[pty-host] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[pty-host] ${chunk}`));
    child.on("message", (message) => this.handleMessage(message as PtyHostMessage));
    child.on("exit", (_code, signal) => this.handleExit(signal ? `PTY host exited with ${signal}` : "PTY host exited."));
    child.on("error", (error) => this.handleExit(`PTY host failed: ${String(error)}`));
    return child;
  }

  private handleMessage(message: PtyHostMessage): void {
    if (!message || typeof message !== "object") return;
    if ("requestId" in message) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.pid ?? null);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "data") {
      this.emit("data", { id: message.id, data: message.data });
      return;
    }
    if (message.type === "exit") {
      this.terminalIds.delete(message.id);
      this.emit("exit", { id: message.id, exitCode: message.exitCode });
      return;
    }
    if (message.type === "error") {
      this.emit("error", { id: message.id, error: message.error });
    }
  }

  private handleExit(error: string): void {
    const crashedIds = Array.from(this.terminalIds);
    this.child = null;
    this.terminalIds.clear();
    for (const pending of this.pending.values()) pending.reject(new Error(error));
    this.pending.clear();
    if (!this.stopping && crashedIds.length > 0) this.emit("crash", { ids: crashedIds, error });
  }
}

export const ptyHost = new PtyHostClient();
