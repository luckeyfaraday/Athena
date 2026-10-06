import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import type { AgentSession, RemoteSessionPage } from "./session-index-protocol.js";

const TTL_MS = 30_000;
const RETRY_MS = 5_000;
const PAGE_ROWS = 100;
const PAGE_BYTES = 256 * 1024;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_ENTRIES = 8;

type Snapshot = { id: string; rows: AgentSession[]; sizes: number[]; bytes: number; at: number; warning: string | null; unavailable: boolean };

export class SessionHistoryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** On-demand metadata only. The supplied scanner MUST run in the index worker. */
export class RemoteSessionHistory {
  private cache = new Map<string, Snapshot>();
  private pending: { workspace: string; promise: Promise<Snapshot> } | null = null;
  private retryAfter = 0;

  constructor(
    private scan: (workspace: string) => Promise<AgentSession[] | null>,
    private now: () => number = Date.now,
  ) {}

  async list(workspace: string, cursor?: string | null): Promise<RemoteSessionPage> {
    let snapshot = this.cache.get(workspace);
    let offset = 0;
    if (cursor) {
      const match = /^([a-f0-9-]{36}):(\d{1,5})$/.exec(cursor);
      if (!match || !snapshot || match[1] !== snapshot.id || Number(match[2]) >= snapshot.rows.length) {
        throw new SessionHistoryError("This history page expired. Refresh sessions to continue.", 409);
      }
      offset = Number(match[2]);
    } else if (!snapshot || this.now() - snapshot.at >= TTL_MS) {
      try {
        snapshot = await this.refresh(workspace);
      } catch (error) {
        if (!snapshot) throw error;
        snapshot.unavailable = true;
        return this.page(snapshot, 0);
      }
    }
    // Touch the bounded LRU without extending freshness or a page's snapshot.
    this.cache.delete(workspace);
    this.cache.set(workspace, snapshot!);
    return this.page(snapshot!, offset);
  }

  private refresh(workspace: string): Promise<Snapshot> {
    if (this.pending?.workspace === workspace) return this.pending.promise;
    if (this.pending || this.now() < this.retryAfter) {
      return Promise.reject(new SessionHistoryError("Session history is busy. Try Refresh again shortly.", 503));
    }
    const promise = this.build(workspace).finally(() => { this.pending = null; });
    this.pending = { workspace, promise };
    return promise;
  }

  private async build(workspace: string): Promise<Snapshot> {
    try {
      const sessions = await this.scan(workspace);
      if (!sessions) throw new SessionHistoryError("Session history is temporarily unavailable. Try Refresh again shortly.", 503);
      const snapshot: Snapshot = { id: randomUUID(), rows: [], sizes: [], bytes: 0, at: this.now(), warning: null, unavailable: false };
      // The worker already bounds discovery. Bound retained metadata and wire size too.
      const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const session of sorted) {
        if (session.id.length > 256 || session.workspace.length > 4096) {
          snapshot.warning = "Some sessions exceed the remote history size limit.";
          continue;
        }
        const row: AgentSession = {
          id: session.id, provider: session.provider, workspace: session.workspace,
          title: session.title.slice(0, 512), branch: session.branch?.slice(0, 128) ?? null,
          model: session.model?.slice(0, 128) ?? null, agent: session.agent?.slice(0, 128) ?? null,
          createdAt: session.createdAt.slice(0, 40), updatedAt: session.updatedAt.slice(0, 40),
          status: "historical", terminalId: null, pid: null,
          resumeCommand: session.resumeCommand?.slice(0, 1024) ?? null, metadata: {},
        };
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (snapshot.rows.length >= 6000 || snapshot.bytes + bytes > SNAPSHOT_BYTES) {
          snapshot.warning = "Showing the most recent sessions; older history exceeds the remote history limit.";
          break;
        }
        snapshot.rows.push(row);
        snapshot.sizes.push(bytes);
        snapshot.bytes += bytes;
        // Formatting a large worker result must also leave time for PTY input/output.
        if (snapshot.rows.length % PAGE_ROWS === 0) await yieldToEvents();
      }
      snapshot.at = this.now();
      this.cache.delete(workspace);
      this.cache.set(workspace, snapshot);
      let bytes = [...this.cache.values()].reduce((total, entry) => total + entry.bytes, 0);
      while (this.cache.size > CACHE_ENTRIES || bytes > CACHE_BYTES) {
        const key = this.cache.keys().next().value!;
        bytes -= this.cache.get(key)!.bytes;
        this.cache.delete(key);
      }
      return snapshot;
    } catch (error) {
      this.retryAfter = this.now() + RETRY_MS;
      throw error;
    }
  }

  private page(snapshot: Snapshot, offset: number): RemoteSessionPage {
    let end = offset;
    let bytes = 0;
    while (end < snapshot.rows.length && end - offset < PAGE_ROWS && bytes + snapshot.sizes[end] <= PAGE_BYTES - 4096) {
      bytes += snapshot.sizes[end++];
    }
    return {
      sessions: snapshot.rows.slice(offset, end),
      nextCursor: end < snapshot.rows.length ? `${snapshot.id}:${end}` : null,
      warning: snapshot.unavailable ? "Showing cached history; the session index is temporarily unavailable." : snapshot.warning,
    };
  }
}
