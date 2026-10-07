import * as path from "node:path";
import * as os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentSession,
  HermesIndexDiagnostics,
  HermesIndexedSession,
  SessionIndexRequest,
  SessionIndexRequestKind,
  SessionIndexResponse,
} from "./session-index-protocol.js";

type WaitingCall = {
  allowStale: boolean;
  kind: SessionIndexRequestKind;
  workspace: string;
  resolve: (sessions: unknown[] | null) => void;
};

type PendingRequest = {
  kind: SessionIndexRequestKind;
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
const REQUEST_KINDS: readonly SessionIndexRequestKind[] = ["list-hermes", "list-agent-sessions"];

/**
 * Main-process side of the session-index worker.
 *
 * All native session discovery (JSONL parsing, sqlite reads, Hermes JSON) runs
 * in a long-lived Electron-as-Node child so the main thread only forwards a
 * request and receives compact results. Calls queued in the same tick are
 * coalesced into one request per kind.
 */
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
  private lastKnown = new Map<string, unknown[]>();
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
    return this.enqueue("list-hermes", workspace).then((sessions) => (sessions ?? []) as HermesIndexedSession[]);
  }

  /**
   * Historical sessions from every native provider (Codex, OpenCode, Athena
   * Code, Claude, Hermes, Grok), scanned in the index child. Resolves null
   * only when the child cannot answer and no earlier result is known, so the
   * caller decides how to degrade. Remote history owns a bounded cache and
   * passes allowStale=false to surface failures without retaining another copy.
   */
  listAgentSessions(workspace: string, allowStale = true): Promise<AgentSession[] | null> {
    return this.enqueue("list-agent-sessions", workspace, allowStale) as Promise<AgentSession[] | null>;
  }

  getDiagnostics(): HermesIndexDiagnostics | null {
    return this.diagnostics ? { ...this.diagnostics } : null;
  }

  dispose(): void {
    if (this.flushTimer) this.cancel(this.flushTimer);
    this.flushTimer = null;
    this.resolveFromLastKnown(this.queued.splice(0));
    if (this.child) this.retireChild(this.child);
    this.lastKnown.clear();
  }

  private enqueue(kind: SessionIndexRequestKind, workspace: string, allowStale = true): Promise<unknown[] | null> {
    return new Promise((resolve) => {
      this.queued.push({ kind, workspace, resolve, allowStale });
      if (this.flushTimer) return;
      this.flushTimer = this.schedule(() => this.flush(), 0);
      this.flushTimer.unref?.();
    });
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
    for (const kind of REQUEST_KINDS) {
      const kindCalls = calls.filter((call) => call.kind === kind);
      if (kindCalls.length === 0) continue;
      if (this.child !== child) {
        // An earlier send in this flush already retired the worker.
        this.resolveFromLastKnown(kindCalls);
        continue;
      }
      this.sendRequest(child, kind, kindCalls);
    }
  }

  private sendRequest(child: ChildProcess, kind: SessionIndexRequestKind, calls: WaitingCall[]): void {
    const requestId = String(this.nextRequestId++);
    const workspaces = Array.from(new Set(calls.map((call) => call.workspace)));
    const request: SessionIndexRequest = { type: kind, requestId, workspaces };
    const timer = this.schedule(() => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.child !== child) return;
      this.retireChild(child);
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { kind, calls, child, timer });
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
    child.on("message", (message) => this.handleMessage(child, message as SessionIndexResponse<unknown>));
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

  private handleMessage(child: ChildProcess, message: SessionIndexResponse<unknown>): void {
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
      const sessions = message.sessions?.[call.workspace] ?? [];
      if (call.allowStale) {
        this.lastKnown.delete(lastKnownKey(call));
        this.lastKnown.set(lastKnownKey(call), sessions);
        while (this.lastKnown.size > 32) this.lastKnown.delete(this.lastKnown.keys().next().value!);
      }
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
    for (const call of calls) call.resolve(call.allowStale ? this.lastKnown.get(lastKnownKey(call)) ?? null : null);
  }
}

function lastKnownKey(call: WaitingCall): string {
  return `${call.kind}\u0000${call.workspace}`;
}

function positiveDuration(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

export const sessionIndexClient = new SessionIndexClient();
