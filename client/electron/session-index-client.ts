import * as path from "node:path";
import * as os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HermesIndexDiagnostics, HermesIndexedSession, SessionIndexRequest, SessionIndexResponse } from "./session-index-protocol.js";

type WaitingCall = {
  workspace: string;
  resolve: (sessions: HermesIndexedSession[]) => void;
};

type PendingRequest = {
  calls: WaitingCall[];
  child: ChildProcess;
  timer: TimerHandle;
};

type TimerHandle = {
  unref?: () => void;
};

export type SessionIndexClientOptions = {
  spawnChild?: () => ChildProcess;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
  requestTimeoutMs?: number;
  restartBackoffMs?: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REQUEST_TIMEOUT_MS = 45_000;
const RESTART_BACKOFF_MS = 5_000;
const MAX_RESTART_BACKOFF_MS = 30_000;

export class SessionIndexClient {
  private readonly spawnChild: () => ChildProcess;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (timer: TimerHandle) => void;
  private readonly requestTimeoutMs: number;
  private readonly restartBackoffMs: number;
  private child: ChildProcess | null = null;
  private queued: WaitingCall[] = [];
  private flushTimer: TimerHandle | null = null;
  private pending = new Map<string, PendingRequest>();
  private lastKnown = new Map<string, HermesIndexedSession[]>();
  private nextRequestId = 1;
  private restartAfter = 0;
  private diagnostics: HermesIndexDiagnostics | null = null;

  constructor(options: SessionIndexClientOptions = {}) {
    this.spawnChild = options.spawnChild ?? (() => fork(path.join(__dirname, "session-index-host.js"), [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }));
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
    this.restartBackoffMs = positiveDuration(options.restartBackoffMs, RESTART_BACKOFF_MS, MAX_RESTART_BACKOFF_MS);
  }

  listHermes(workspace: string): Promise<HermesIndexedSession[]> {
    return new Promise((resolve) => {
      this.queued.push({ workspace, resolve });
      if (this.flushTimer) return;
      this.flushTimer = this.schedule(() => this.flush(), 0);
      this.flushTimer.unref?.();
    });
  }

  getDiagnostics(): HermesIndexDiagnostics | null {
    return this.diagnostics ? { ...this.diagnostics } : null;
  }

  private flush(): void {
    this.flushTimer = null;
    const calls = this.queued.splice(0);
    if (calls.length === 0) return;
    if (this.now() < this.restartAfter) {
      this.resolveFromLastKnown(calls);
      return;
    }
    let child: ChildProcess;
    try {
      child = this.ensureChild();
    } catch {
      this.startRestartBackoff();
      this.resolveFromLastKnown(calls);
      return;
    }
    const requestId = String(this.nextRequestId++);
    const workspaces = Array.from(new Set(calls.map((call) => call.workspace)));
    const request: SessionIndexRequest = { type: "list-hermes", requestId, workspaces };
    const timer = this.schedule(() => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.child !== child) return;
      this.retireChild(child);
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { calls, child, timer });
    try {
      if (!child.send) throw new Error("Session index child has no IPC channel");
      child.send(request, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending || pending.child !== child) return;
        this.retireChild(child);
      });
    } catch {
      this.retireChild(child);
    }
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.connected && !this.child.killed) return this.child;
    const child = this.spawnChild();
    this.child = child;
    child.on("message", (message) => this.handleMessage(child, message as SessionIndexResponse));
    child.on("exit", (code, signal) => this.handleExit(child, code === 0 && signal === null));
    child.on("error", () => this.retireChild(child));
    if (child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Priority adjustment is best-effort (some platforms require privileges).
      }
    }
    child.unref();
    child.channel?.unref();
    return child;
  }

  private handleMessage(child: ChildProcess, message: SessionIndexResponse): void {
    if (!message || message.type !== "response") return;
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.child !== child) return;
    this.cancel(pending.timer);
    this.pending.delete(message.requestId);
    if (!message.ok) {
      this.resolveFromLastKnown(pending.calls);
      return;
    }
    this.diagnostics = { ...message.diagnostics };
    for (const call of pending.calls) {
      const sessions = message.sessions[call.workspace] ?? [];
      this.lastKnown.set(call.workspace, sessions);
      call.resolve(sessions);
    }
  }

  private handleExit(child: ChildProcess, clean: boolean): void {
    const wasCurrent = this.child === child;
    const hadPending = Array.from(this.pending.values()).some((pending) => pending.child === child);
    if (wasCurrent) {
      this.child = null;
      if (clean && !hadPending) this.restartAfter = 0;
      else this.startRestartBackoff();
    }
    this.resolvePendingForChild(child);
  }

  private retireChild(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.startRestartBackoff();
    }
    this.resolvePendingForChild(child);
    try {
      if (!child.killed) child.kill();
    } catch {
      // The exact worker may already have exited between the failure and kill.
    }
    try {
      if (child.connected) child.disconnect();
    } catch {
      // Disconnect is best-effort after the worker has been retired.
    }
  }

  private resolvePendingForChild(child: ChildProcess): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.child !== child) continue;
      this.cancel(pending.timer);
      this.pending.delete(requestId);
      this.resolveFromLastKnown(pending.calls);
    }
  }

  private startRestartBackoff(): void {
    this.restartAfter = this.now() + this.restartBackoffMs;
  }

  private resolveFromLastKnown(calls: WaitingCall[]): void {
    for (const call of calls) call.resolve(this.lastKnown.get(call.workspace) ?? []);
  }
}

function positiveDuration(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

export const sessionIndexClient = new SessionIndexClient();
