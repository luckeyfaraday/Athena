import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";
import type { WorkspacePath } from "./platform.js";
import type { DirectoryListing } from "./remote-fs.js";
import type { RemoteMachine, RemoteMachinesState } from "./remote-machines.js";
import type { AgentSession, RemoteSessionPage } from "./session-index-protocol.js";

// The viewing side of remote machines: keeps one event stream open to every
// other Athena that is ready for this one, and proxies their terminals into the
// same sequenced stream protocol local panes use, under namespaced ids
// ("remote:<machine>:<terminal>"). Kept free of any `electron` import (windows
// are passed in as plain subscribers) so it can be tested against a fake host.

export const REMOTE_TERMINAL_PREFIX = "remote:";

export type RemoteSubscriber = {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  on(event: "did-navigate" | "render-process-gone" | "destroyed", listener: () => void): unknown;
  removeListener(event: "did-navigate" | "render-process-gone" | "destroyed", listener: () => void): unknown;
};

export type RemoteConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type RemoteMachineView = RemoteMachine & {
  connection: RemoteConnectionStatus;
  connectionError: string | null;
  hasToken: boolean;
  /** Terminals on that machine, with namespaced ids. */
  sessions: EmbeddedTerminalSession[];
  workspaces: WorkspacePath[];
  activeWorkspace: WorkspacePath | null;
};

export type RemoteSnapshot = {
  tailscale: RemoteMachinesState["tailscale"];
  account: string | null;
  selfName: string | null;
  machines: RemoteMachineView[];
  refreshedAt: string | null;
};

export type RemoteAttention = {
  machineId: string;
  machineName: string;
  event: { id: string; kind: "action" | "update"; reason: string; message: string | null };
  session: EmbeddedTerminalSession | null;
};

export type RemoteSpawnRequest = {
  workspace: string;
  kind: string;
  count?: number;
  title?: string;
  resumeSessionId?: string;
  sessionLabel?: string;
};

export type RemoteStreamSnapshot = { id: string; epoch: string; buffer: string; throughSequence: number };

export type RemoteClientOptions = {
  discover: (fresh: boolean) => Promise<RemoteMachinesState>;
  tokenFor: (machineId: string) => string | null;
  /** Send to every window (session lists, exits, attention). */
  broadcast: (channel: string, payload: unknown) => void;
  selfName: () => string | null;
  refreshIntervalMs?: number;
};

export class RemoteRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null) {
    super(message);
    this.name = "RemoteRequestError";
  }
}

export function remoteTerminalId(machineId: string, terminalId: string): string {
  return `${REMOTE_TERMINAL_PREFIX}${machineId}:${terminalId}`;
}

export function isRemoteTerminalId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(REMOTE_TERMINAL_PREFIX);
}

export function parseRemoteTerminalId(id: string): { machineId: string; terminalId: string } | null {
  if (!isRemoteTerminalId(id)) return null;
  const rest = id.slice(REMOTE_TERMINAL_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { machineId: rest.slice(0, colon), terminalId: rest.slice(colon + 1) };
}

export type SseMessage = { event: string; data: string; id: string | null };

/** Incremental Server-Sent Events parser: feed it text chunks, get whole messages. */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | null = null;
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) onMessage({ event, data: data.join("\n"), id });
        event = "message";
        data = [];
        id = null;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  };
}

type SseHandle = { close(): void };

const SSE_IDLE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SPAWN_TIMEOUT_MS = 90_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RESYNC_INTERVAL_MS = 20_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const STREAM_REPLAY_MAX_CHARS = 64 * 1024;

function authHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** One JSON request to a remote Athena's control API. Non-2xx answers throw RemoteRequestError. */
export function requestJson(
  url: string,
  options: { method?: string; body?: unknown; token?: string | null; timeoutMs?: number; maxResponseBytes?: number; deadlineMs?: number } = {},
): Promise<Record<string, unknown>> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? "GET",
      agent: false,
      headers: {
        ...authHeaders(options.token ?? null),
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let text = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (options.maxResponseBytes && bytes > options.maxResponseBytes) {
          request.destroy(new Error("The remote history response exceeded its size limit."));
          return;
        }
        text += chunk;
      });
      response.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(text);
          body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        } catch {
          body = null;
        }
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(body ?? {});
          return;
        }
        const message = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `HTTP ${status}`;
        reject(new RemoteRequestError(message.replace(/^Error: /, ""), status, body));
      });
      response.on("error", reject);
    });
    request.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("The remote machine did not answer in time."));
    });
    request.on("error", reject);
    if (options.deadlineMs) {
      const deadline = setTimeout(() => request.destroy(new Error("The remote machine did not answer in time.")), options.deadlineMs);
      deadline.unref();
      request.on("close", () => clearTimeout(deadline));
    }
    request.end(payload);
  });
}

/** A long-lived Server-Sent Events request; handlers never fire after close(). */
export function openSse(
  url: string,
  token: string | null,
  handlers: { onMessage: (message: SseMessage) => void; onEnd: (error: Error | null) => void },
): SseHandle {
  let closed = false;
  let ended = false;
  const end = (error: Error | null) => {
    if (closed || ended) return;
    ended = true;
    handlers.onEnd(error);
  };
  const request = http.get(url, { agent: false, headers: { accept: "text/event-stream", ...authHeaders(token) } }, (response) => {
    if (response.statusCode !== 200) {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        const message = typeof body?.error === "string" ? body.error : `HTTP ${response.statusCode}`;
        end(new RemoteRequestError(message.replace(/^Error: /, ""), response.statusCode ?? 0, body));
      });
      return;
    }
    response.setEncoding("utf8");
    const parse = createSseParser((message) => {
      if (!closed) handlers.onMessage(message);
    });
    response.on("data", parse);
    response.on("end", () => end(null));
    response.on("aborted", () => end(new Error("The remote machine closed the stream.")));
    response.on("error", (error) => end(error));
  });
  // Heartbeats arrive every 15 s; a silent socket this long is dead.
  request.setTimeout(SSE_IDLE_TIMEOUT_MS, () => request.destroy(new Error("The remote stream went silent.")));
  request.on("error", (error) => end(error));
  return {
    close: () => {
      closed = true;
      request.destroy();
    },
  };
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is EmbeddedTerminalSession {
  return Boolean(value) && typeof value === "object" && typeof (value as EmbeddedTerminalSession).id === "string";
}

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["codex", "claude", "hermes", "opencode", "athena", "grok"].includes(String(row.provider))
    && ["historical", "running", "exited"].includes(String(row.status))
    && ["id", "workspace", "title", "createdAt", "updatedAt"].every((key) => typeof row[key] === "string")
    && ["branch", "model", "agent", "terminalId", "resumeCommand"].every((key) => row[key] === null || typeof row[key] === "string")
    && (row.pid === null || typeof row.pid === "number");
}

function isWorkspacePath(value: unknown): value is WorkspacePath {
  return Boolean(value) && typeof value === "object" && typeof (value as WorkspacePath).nativePath === "string";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The event stream and terminal list of one remote machine. */
class MachineConnection {
  status: RemoteConnectionStatus = "idle";
  error: string | null = null;
  readonly sessions = new Map<string, EmbeddedTerminalSession>();
  workspaces: WorkspacePath[] = [];
  activeWorkspace: WorkspacePath | null = null;
  private stream: SseHandle | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private retryDelay = RECONNECT_MIN_MS;
  private closed = false;

  constructor(
    public machine: RemoteMachine,
    private readonly token: () => string | null,
    private readonly hooks: {
      changed: () => void;
      attention: (connection: MachineConnection, event: Record<string, unknown>) => void;
      exit: (connection: MachineConnection, payload: Record<string, unknown>) => void;
    },
  ) {}

  get url(): string {
    return this.machine.url ?? "";
  }

  open(): void {
    if (this.closed || this.stream || !this.url) return;
    this.status = "connecting";
    this.hooks.changed();
    this.stream = openSse(`${this.url}/events`, this.token(), {
      onMessage: (message) => this.handle(message),
      onEnd: (error) => {
        this.stream = null;
        if (this.closed) return;
        this.status = "error";
        this.error = error ? errorText(error) : "The connection closed.";
        this.hooks.changed();
        this.scheduleReconnect();
      },
    });
    this.resyncTimer ??= setInterval(() => void this.resync(), RESYNC_INTERVAL_MS);
    this.resyncTimer.unref?.();
  }

  /** Point at a new address (the machine changed IP) and reconnect. */
  update(machine: RemoteMachine): void {
    const moved = machine.url !== this.machine.url;
    this.machine = machine;
    if (moved) this.reconnect();
  }

  reconnect(): void {
    this.stream?.close();
    this.stream = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = RECONNECT_MIN_MS;
    this.open();
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.retryTimer = null;
    this.resyncTimer = null;
  }

  /** Re-read the terminal list; catches kills, which arrive only as exits. */
  async resync(): Promise<void> {
    if (this.closed || this.status !== "connected") return;
    try {
      const body = await requestJson(`${this.url}/terminals`, { token: this.token() });
      this.replaceSessions(body.terminals);
      this.hooks.changed();
    } catch {
      // The event stream reports connection trouble; a failed resync is not news.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.retryDelay);
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
  }

  private handle(message: SseMessage): void {
    const payload = parseJson(message.data);
    if (!payload) return;
    switch (message.event) {
      case "hello":
        this.status = "connected";
        this.error = null;
        this.retryDelay = RECONNECT_MIN_MS;
        this.replaceSessions(payload.terminals);
        this.setWorkspaces(payload);
        break;
      case "session":
        if (isSession(payload)) this.sessions.set(payload.id, payload);
        break;
      case "exit": {
        const id = typeof payload.id === "string" ? payload.id : null;
        const session = id ? this.sessions.get(id) : undefined;
        if (session) {
          this.sessions.set(session.id, { ...session, status: "exited", exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null });
        }
        this.hooks.exit(this, payload);
        // A kill removes the terminal on the host; the next list read drops it here.
        setTimeout(() => void this.resync(), 300).unref?.();
        break;
      }
      case "attention":
        this.hooks.attention(this, payload);
        return;
      case "workspaces":
        this.setWorkspaces(payload);
        break;
      default:
        return;
    }
    this.hooks.changed();
  }

  private replaceSessions(value: unknown): void {
    this.sessions.clear();
    for (const session of Array.isArray(value) ? value : []) {
      if (isSession(session)) this.sessions.set(session.id, session);
    }
  }

  private setWorkspaces(payload: Record<string, unknown>): void {
    this.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces.filter(isWorkspacePath) : [];
    this.activeWorkspace = isWorkspacePath(payload.active) ? payload.active : null;
  }
}

/** One remote terminal's output stream, relayed to the windows showing it. */
class TerminalStream {
  private handle: SseHandle | null = null;
  private closed = false;
  private attached = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = RECONNECT_MIN_MS;
  private waiting: { resolve: (snapshot: RemoteStreamSnapshot) => void; reject: (error: Error) => void } | null = null;

  constructor(
    private readonly id: string,
    private readonly url: () => string,
    private readonly token: () => string | null,
    private readonly deliver: (channel: string, payload: unknown) => void,
  ) {}

  /** Open the stream; resolves with its first snapshot. Later snapshots are relayed as resets. */
  open(): Promise<RemoteStreamSnapshot> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.connect();
    });
  }

  close(): void {
    this.closed = true;
    this.handle?.close();
    this.handle = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.waiting?.reject(new Error("The terminal stream was closed."));
    this.waiting = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.handle = openSse(this.url(), this.token(), {
      onMessage: (message) => this.handleMessage(message),
      onEnd: (error) => {
        this.handle = null;
        if (this.closed) return;
        if (!this.attached) {
          this.closed = true;
          this.waiting?.reject(error ?? new Error("The remote terminal stream ended before it started."));
          this.waiting = null;
          return;
        }
        if (error instanceof RemoteRequestError && error.status >= 400 && error.status < 500) {
          // The terminal is gone on the host (or access was withdrawn): stop here.
          this.closed = true;
          this.deliver("embedded-terminal:exit", { id: this.id, exitCode: null });
          return;
        }
        // A dropped connection: reconnect and rebase the view from a fresh snapshot.
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, this.retryDelay);
        this.retryTimer.unref?.();
        this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
      },
    });
  }

  private handleMessage(message: SseMessage): void {
    const payload = parseJson(message.data);
    if (!payload || typeof payload.epoch !== "string") return;
    const epoch = payload.epoch;
    const data = typeof payload.data === "string" ? payload.data : "";
    if (message.event === "snapshot") {
      const throughSequence = Number(payload.throughSequence) || 0;
      this.retryDelay = RECONNECT_MIN_MS;
      if (!this.attached) {
        this.attached = true;
        this.waiting?.resolve({ id: this.id, epoch, buffer: data, throughSequence });
        this.waiting = null;
        return;
      }
      this.deliver("embedded-terminal:data", { id: this.id, epoch, fromSequence: 0, sequence: throughSequence, data, reset: true });
      return;
    }
    if (message.event === "data") {
      this.deliver("embedded-terminal:data", {
        id: this.id,
        epoch,
        fromSequence: Number(payload.fromSequence) || 0,
        sequence: Number(payload.sequence) || 0,
        data,
        reset: false,
      });
      return;
    }
    if (message.event === "exit") {
      this.deliver("embedded-terminal:exit", {
        id: this.id,
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
        epoch,
        throughSequence: Number(payload.throughSequence) || 0,
      });
      this.closed = true;
      this.handle?.close();
      this.handle = null;
    }
  }
}

/** Keystrokes for one remote terminal, sent one request at a time and in order, batched while one is in flight. */
class KeystrokeQueue {
  private pending = "";
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private inFlight = false;

  constructor(private readonly send: (data: string) => Promise<void>) {}

  write(data: string): Promise<void> {
    this.pending += data;
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    void this.flush();
    return done;
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.pending) return;
    this.inFlight = true;
    const data = this.pending;
    const waiters = this.waiters;
    this.pending = "";
    this.waiters = [];
    try {
      await this.send(data);
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.inFlight = false;
      void this.flush();
    }
  }
}

export class RemoteClient {
  private state: RemoteMachinesState | null = null;
  private readonly connections = new Map<string, MachineConnection>();
  private readonly streams = new Map<string, TerminalStream>();
  private readonly subscribers = new Map<string, Map<number, RemoteSubscriber>>();
  private readonly subscriberCleanups = new Map<number, () => void>();
  private readonly keystrokes = new Map<string, KeystrokeQueue>();
  private readonly resizes = new Map<string, { cols: number; rows: number; inFlight: boolean; dirty: boolean }>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<RemoteSnapshot> | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: RemoteClientOptions) {}

  /** Start periodic discovery; the first snapshot request calls this. */
  start(): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setInterval(() => void this.refresh(false).catch(() => undefined), this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    for (const stream of this.streams.values()) stream.close();
    for (const connection of this.connections.values()) connection.close();
    this.streams.clear();
    this.connections.clear();
    this.subscribers.clear();
    for (const cleanup of this.subscriberCleanups.values()) cleanup();
    this.subscriberCleanups.clear();
    this.keystrokes.clear();
    this.resizes.clear();
  }

  /** Re-run discovery and connect to every machine that is ready for this one. */
  refresh(fresh = true): Promise<RemoteSnapshot> {
    this.refreshInFlight ??= this.options.discover(fresh)
      .then((state) => {
        this.state = state;
        this.reconcile();
        this.scheduleUpdate();
        return this.snapshot();
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  snapshot(): RemoteSnapshot {
    const machines = (this.state?.machines ?? []).map((machine): RemoteMachineView => {
      const connection = this.connections.get(machine.id);
      return {
        // A healthy event stream is stronger evidence than one failed probe.
        ...(connection?.status === "connected" ? connection.machine : machine),
        connection: connection?.status ?? "idle",
        connectionError: connection?.error ?? null,
        hasToken: Boolean(this.options.tokenFor(machine.id)),
        sessions: connection ? [...connection.sessions.values()].map((session) => this.namespaced(machine.id, session)) : [],
        workspaces: connection?.workspaces ?? [],
        activeWorkspace: connection?.activeWorkspace ?? null,
      };
    });
    return {
      tailscale: this.state?.tailscale ?? "unavailable",
      account: this.state?.account ?? null,
      selfName: this.options.selfName(),
      machines,
      refreshedAt: this.state?.refreshedAt ?? null,
    };
  }

  // ---- terminal proxy (namespaced ids) ----

  subscribe(id: string, subscriber: RemoteSubscriber): void {
    if (!this.subscriberCleanups.has(subscriber.id)) {
      const drop = () => this.unsubscribeSubscriber(subscriber.id);
      const destroyed = () => {
        drop();
        cleanup();
        this.subscriberCleanups.delete(subscriber.id);
      };
      const cleanup = () => {
        subscriber.removeListener("did-navigate", drop);
        subscriber.removeListener("render-process-gone", drop);
        subscriber.removeListener("destroyed", destroyed);
      };
      subscriber.on("did-navigate", drop);
      subscriber.on("render-process-gone", drop);
      subscriber.on("destroyed", destroyed);
      this.subscriberCleanups.set(subscriber.id, cleanup);
    }
    let subscribers = this.subscribers.get(id);
    if (!subscribers) {
      subscribers = new Map();
      this.subscribers.set(id, subscribers);
    }
    subscribers.set(subscriber.id, subscriber);
  }

  unsubscribe(id: string, subscriberId: number): void {
    const subscribers = this.subscribers.get(id);
    subscribers?.delete(subscriberId);
    if (subscribers && subscribers.size === 0) {
      this.subscribers.delete(id);
      this.streams.get(id)?.close();
      this.streams.delete(id);
    }
  }

  private unsubscribeSubscriber(subscriberId: number): void {
    for (const id of this.subscribers.keys()) this.unsubscribe(id, subscriberId);
  }

  /** Attach a view: a fresh stream whose first snapshot is returned; output follows as data events. */
  async attach(id: string, subscriber: RemoteSubscriber): Promise<RemoteStreamSnapshot> {
    const { connection, terminalId } = this.resolve(id);
    this.subscribe(id, subscriber);
    this.streams.get(id)?.close();
    const stream = new TerminalStream(
      id,
      () => `${connection.url}/terminals/${encodeURIComponent(terminalId)}/stream?format=json&max_chars=${STREAM_REPLAY_MAX_CHARS}`,
      () => this.options.tokenFor(connection.machine.id),
      (channel, payload) => this.deliver(id, channel, payload),
    );
    this.streams.set(id, stream);
    try {
      return await stream.open();
    } catch (error) {
      if (this.streams.get(id) === stream) this.streams.delete(id);
      throw error;
    }
  }

  async write(id: string, data: string): Promise<EmbeddedTerminalSession> {
    const { connection, terminalId } = this.resolve(id);
    let queue = this.keystrokes.get(id);
    if (!queue) {
      queue = new KeystrokeQueue(async (batch) => {
        await requestJson(`${connection.url}/terminals/keys`, {
          method: "POST",
          body: { terminal_id: terminalId, data: batch },
          token: this.options.tokenFor(connection.machine.id),
        });
      });
      this.keystrokes.set(id, queue);
    }
    await queue.write(data);
    return this.session(id);
  }

  /** Resize, coalesced: a burst of resizes sends at most one request at a time and always ends on the last size. */
  async resize(id: string, cols: number, rows: number): Promise<EmbeddedTerminalSession> {
    const { connection, terminalId } = this.resolve(id);
    const state = this.resizes.get(id) ?? { cols, rows, inFlight: false, dirty: false };
    state.cols = cols;
    state.rows = rows;
    this.resizes.set(id, state);
    if (state.inFlight) {
      state.dirty = true;
      return this.session(id);
    }
    state.inFlight = true;
    try {
      do {
        state.dirty = false;
        await requestJson(`${connection.url}/terminals/resize`, {
          method: "POST",
          body: { terminal_id: terminalId, cols: state.cols, rows: state.rows },
          token: this.options.tokenFor(connection.machine.id),
        }).catch(() => undefined);
      } while (state.dirty);
    } finally {
      state.inFlight = false;
    }
    return this.session(id);
  }

  async rename(id: string, title: string): Promise<EmbeddedTerminalSession> {
    const { connection, terminalId } = this.resolve(id);
    const body = await requestJson(`${connection.url}/terminals/rename`, {
      method: "POST",
      body: { terminal_id: terminalId, title },
      token: this.options.tokenFor(connection.machine.id),
    });
    if (isSession(body.terminal)) connection.sessions.set(body.terminal.id, body.terminal);
    this.scheduleUpdate();
    return this.session(id);
  }

  async kill(id: string): Promise<EmbeddedTerminalSession> {
    const { connection, terminalId } = this.resolve(id);
    const session = this.session(id);
    await requestJson(`${connection.url}/terminals/kill`, {
      method: "POST",
      body: { terminal_id: terminalId },
      token: this.options.tokenFor(connection.machine.id),
    });
    connection.sessions.delete(terminalId);
    this.streams.get(id)?.close();
    this.streams.delete(id);
    this.keystrokes.delete(id);
    this.resizes.delete(id);
    this.scheduleUpdate();
    return { ...session, status: "exited", exitCode: null };
  }

  async buffer(id: string): Promise<string> {
    const { connection, terminalId } = this.resolve(id);
    const body = await requestJson(`${connection.url}/terminals/${encodeURIComponent(terminalId)}/buffer?max_chars=${STREAM_REPLAY_MAX_CHARS}`, {
      token: this.options.tokenFor(connection.machine.id),
    });
    return typeof body.buffer === "string" ? body.buffer : "";
  }

  // ---- machine actions ----

  async listAgentSessions(machineId: string, workspace: string, cursor?: string | null): Promise<RemoteSessionPage> {
    const connection = this.connection(machineId);
    const query = new URLSearchParams({ workspace });
    if (cursor) query.set("cursor", cursor);
    let body: Record<string, unknown>;
    try {
      body = await requestJson(`${connection.url}/agent-sessions?${query}`, {
        token: this.options.tokenFor(machineId), timeoutMs: 50_000, deadlineMs: 50_000, maxResponseBytes: 256 * 1024,
      });
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) {
        throw new Error("Update Athena on this device to enable session history.");
      }
      throw error;
    }
    if (!Array.isArray(body.sessions) || body.sessions.length > 100
      || !(body.nextCursor === null || typeof body.nextCursor === "string" && body.nextCursor.length < 128)
      || !(body.warning === null || typeof body.warning === "string" && body.warning.length < 1024)
      || !body.sessions.every(isAgentSession)) {
      throw new Error("The remote machine returned invalid session history.");
    }
    return {
      sessions: body.sessions.map((session: AgentSession) => ({
        ...session, metadata: {},
        terminalId: session.terminalId ? remoteTerminalId(machineId, session.terminalId) : null,
      })),
      nextCursor: body.nextCursor as string | null, warning: body.warning as string | null,
    };
  }

  async spawn(machineId: string, request: RemoteSpawnRequest): Promise<EmbeddedTerminalSession[]> {
    const connection = this.connection(machineId);
    const body = await requestJson(`${connection.url}/terminals/spawn`, {
      method: "POST",
      body: {
        project_dir: request.workspace,
        kind: request.kind,
        count: request.count ?? 1,
        title: request.title,
        resume_session_id: request.resumeSessionId,
        session_label: request.sessionLabel,
        // Open the tab there, but never yank the person at that machine to it.
        open_workspace: true,
        select_workspace: false,
      },
      token: this.options.tokenFor(machineId),
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter(isSession) : [];
    for (const session of sessions) connection.sessions.set(session.id, session);
    this.scheduleUpdate();
    return sessions.map((session) => this.namespaced(machineId, session));
  }

  async listDirectories(machineId: string, directory?: string | null): Promise<DirectoryListing> {
    const connection = this.connection(machineId);
    const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
    return await requestJson(`${connection.url}/fs/dirs${query}`, { token: this.options.tokenFor(machineId) }) as unknown as DirectoryListing;
  }

  async openWorkspace(machineId: string, workspace: string): Promise<WorkspacePath> {
    const connection = this.connection(machineId);
    const body = await requestJson(`${connection.url}/workspaces/open`, {
      method: "POST",
      body: { project_dir: workspace, select: false },
      token: this.options.tokenFor(machineId),
    });
    if (!isWorkspacePath(body.workspace)) throw new Error("The remote machine did not confirm the folder.");
    const opened = body.workspace;
    if (!connection.workspaces.some((item) => item.nativePath === opened.nativePath)) {
      connection.workspaces = [...connection.workspaces, opened];
      this.scheduleUpdate();
    }
    return opened;
  }

  async closeWorkspace(machineId: string, workspace: string): Promise<void> {
    const connection = this.connection(machineId);
    await requestJson(`${connection.url}/workspaces/close`, {
      method: "POST",
      body: { project_dir: workspace },
      token: this.options.tokenFor(machineId),
    });
    connection.workspaces = connection.workspaces.filter((item) => item.nativePath !== workspace);
    for (const [terminalId, session] of connection.sessions) {
      if (session.workspace === workspace) connection.sessions.delete(terminalId);
    }
    this.scheduleUpdate();
  }

  // ---- internals ----

  private reconcile(): void {
    const ready = new Map<string, RemoteMachine>();
    for (const machine of this.state?.machines ?? []) {
      const connection = this.connections.get(machine.id);
      if (machine.status === "ready") {
        ready.set(machine.id, machine);
      } else if (machine.online && connection?.status === "connected" && machine.url === connection.url
        && (machine.status === "no-athena" || machine.status === "unknown")) {
        // A slow /machine probe must not tear down a working stream. Explicit
        // authorization failures, offline peers and address changes still do.
        ready.set(machine.id, { ...connection.machine, online: machine.online, checkedAt: machine.checkedAt });
      }
    }
    for (const [machineId, connection] of this.connections) {
      if (!ready.has(machineId)) {
        connection.close();
        this.connections.delete(machineId);
        for (const id of this.streams.keys()) {
          if (parseRemoteTerminalId(id)?.machineId !== machineId) continue;
          this.streams.get(id)?.close();
          this.streams.delete(id);
          this.subscribers.delete(id);
          this.keystrokes.delete(id);
          this.resizes.delete(id);
        }
      }
    }
    for (const [machineId, machine] of ready) {
      const existing = this.connections.get(machineId);
      if (existing) {
        existing.update(machine);
        continue;
      }
      const connection = new MachineConnection(machine, () => this.options.tokenFor(machineId), {
        changed: () => this.scheduleUpdate(),
        attention: (source, event) => this.relayAttention(source, event),
        exit: (source, payload) => {
          if (typeof payload.id !== "string") return;
          this.options.broadcast("embedded-terminal:exit", { ...payload, id: remoteTerminalId(source.machine.id, payload.id) });
        },
      });
      this.connections.set(machineId, connection);
      connection.open();
    }
  }

  private relayAttention(connection: MachineConnection, event: Record<string, unknown>): void {
    if (typeof event.id !== "string" || (event.kind !== "action" && event.kind !== "update")) return;
    const session = connection.sessions.get(event.id);
    const attention: RemoteAttention = {
      machineId: connection.machine.id,
      machineName: connection.machine.name,
      event: {
        id: remoteTerminalId(connection.machine.id, event.id),
        kind: event.kind,
        reason: typeof event.reason === "string" ? event.reason : "notification",
        message: typeof event.message === "string" ? event.message : null,
      },
      session: session ? this.namespaced(connection.machine.id, session) : null,
    };
    this.options.broadcast("remote:attention", attention);
  }

  private deliver(id: string, channel: string, payload: unknown): void {
    if (channel === "embedded-terminal:exit") {
      this.options.broadcast(channel, payload);
      return;
    }
    const subscribers = this.subscribers.get(id);
    if (!subscribers) return;
    for (const [subscriberId, subscriber] of subscribers) {
      if (subscriber.isDestroyed()) {
        this.unsubscribe(id, subscriberId);
        continue;
      }
      try {
        subscriber.send(channel, payload);
      } catch {
        this.unsubscribe(id, subscriberId);
      }
    }
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || this.disposed) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.options.broadcast("remote:update", this.snapshot());
    }, 50);
    this.updateTimer.unref?.();
  }

  private connection(machineId: string): MachineConnection {
    const connection = this.connections.get(machineId);
    if (!connection) {
      const machine = this.state?.machines.find((candidate) => candidate.id === machineId);
      throw new Error(machine ? `${machine.name} is not ready for this machine.` : "Unknown machine.");
    }
    return connection;
  }

  private resolve(id: string): { connection: MachineConnection; terminalId: string } {
    const parsed = parseRemoteTerminalId(id);
    if (!parsed) throw new Error(`Not a remote terminal: ${id}`);
    return { connection: this.connection(parsed.machineId), terminalId: parsed.terminalId };
  }

  private session(id: string): EmbeddedTerminalSession {
    const { connection, terminalId } = this.resolve(id);
    const session = connection.sessions.get(terminalId);
    if (session) return this.namespaced(connection.machine.id, session);
    return {
      id,
      title: "Remote terminal",
      kind: "shell",
      workspace: "",
      pid: null,
      promptPath: null,
      initialTask: null,
      sessionLabel: null,
      providerSessionId: null,
      createdAt: new Date(0).toISOString(),
      status: "exited",
      exitCode: null,
      error: null,
    };
  }

  private namespaced(machineId: string, session: EmbeddedTerminalSession): EmbeddedTerminalSession {
    return { ...session, id: remoteTerminalId(machineId, session.id) };
  }
}

/** Access tokens for machines that need one, kept 0600 next to the other remote settings. */
export class RemoteTokenStore {
  private tokens: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  get(machineId: string): string | null {
    return this.load()[machineId] ?? null;
  }

  set(machineId: string, token: string | null): void {
    const tokens = { ...this.load() };
    const trimmed = token?.trim() ?? "";
    if (trimmed) tokens[machineId] = trimmed;
    else delete tokens[machineId];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
    this.tokens = tokens;
  }

  private load(): Record<string, string> {
    if (this.tokens) return this.tokens;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.tokens = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
    } catch {
      this.tokens = {};
    }
    return this.tokens;
  }
}
