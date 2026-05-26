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

export class PtyHostClient extends TypedEventEmitter {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private terminalIds = new Set<string>();
  private nextRequestId = 1;
  private stopping = false;

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

  shutdown(): void {
    this.stopping = true;
    if (!this.child || this.child.killed) return;
    const child = this.child;
    void this.request({ type: "shutdown" }).finally(() => {
      child.kill();
    });
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
