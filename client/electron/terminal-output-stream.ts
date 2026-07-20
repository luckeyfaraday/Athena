import { randomUUID } from "node:crypto";
import {
  BoundedTerminalReplayBuffer,
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
} from "./terminal-buffer.js";
import {
  DEFAULT_OUTPUT_ACK_TIMEOUT_MS,
  OutputAckGate,
  type SequencedOutputBatch,
} from "./terminal-output-ack.js";

export type TerminalStreamAttachSnapshot = {
  id: string;
  epoch: string;
  buffer: string;
  throughSequence: number;
};

export type TerminalStreamDelivery = SequencedOutputBatch & {
  id: string;
  consumerId: string;
};

type OutputChunk = {
  sequence: number;
  data: string;
};

type TerminalState = {
  epoch: string;
  sequence: number;
  buffer: BoundedTerminalReplayBuffer;
  pendingHighSurrogate: string;
  consumers: Set<string>;
};

type ConsumerState = {
  terminalId: string;
  consumerId: string;
  pending: OutputChunk[];
  pendingChars: number;
  needsReset: boolean;
  paused: boolean;
  replayMaxChars: number | null;
};

export type TerminalStreamAttachOptions = {
  replayMaxChars?: number;
  paused?: boolean;
};

export type TerminalOutputStreamOptions = {
  maxSnapshotChars?: number;
  maxPendingChars?: number;
  ackTimeoutMs?: number;
  epochFactory?: () => string;
};

export type TerminalOutputStreamDiagnostics = {
  subscribers: number;
  retries: number;
  resets: number;
  droppedOrTruncatedChars: number;
  deliveredChars: number;
  acknowledgedChars: number;
  replayCount: number;
  replayBytes: number;
  replayDurationMs: number;
  maxReplayDurationMs: number;
};

/**
 * A bounded, consumer-aware terminal stream protocol.
 *
 * PTY output is retained once in a rolling replay snapshot. Only explicitly
 * subscribed consumers receive live chunks, and each consumer has independent
 * pending/in-flight state. Overflow converts into an explicit reset snapshot;
 * it never splices together an undeclared arbitrary tail. Attach synchronously
 * rebases a consumer at the snapshot cursor, making snapshot + later live
 * sequences atomic from the main-process point of view.
 */
export class TerminalOutputStreamHub {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly gate: OutputAckGate<TerminalStreamDelivery>;
  private readonly maxSnapshotChars: number;
  private readonly maxPendingChars: number;
  private readonly epochFactory: () => string;
  private readonly counters = {
    retries: 0,
    resets: 0,
    droppedOrTruncatedChars: 0,
    deliveredChars: 0,
    acknowledgedChars: 0,
    replayCount: 0,
    replayBytes: 0,
    replayDurationMs: 0,
    maxReplayDurationMs: 0,
  };

  constructor(options: TerminalOutputStreamOptions = {}) {
    this.maxSnapshotChars = Math.max(1, Math.floor(options.maxSnapshotChars ?? 200_000));
    this.maxPendingChars = Math.max(
      1,
      Math.floor(options.maxPendingChars ?? DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS),
    );
    this.epochFactory = options.epochFactory ?? randomUUID;
    this.gate = new OutputAckGate<TerminalStreamDelivery>(
      options.ackTimeoutMs ?? DEFAULT_OUTPUT_ACK_TIMEOUT_MS,
    );
  }

  append(terminalId: string, data: string): number {
    const terminal = this.terminal(terminalId);
    if (!data) return terminal.sequence;
    let normalized = data;
    if (terminal.pendingHighSurrogate) {
      normalized = data && isLowSurrogate(data.charCodeAt(0))
        ? `${terminal.pendingHighSurrogate}${data}`
        : `\ufffd${data}`;
    }
    terminal.pendingHighSurrogate = "";
    if (normalized && isHighSurrogate(normalized.charCodeAt(normalized.length - 1))) {
      terminal.pendingHighSurrogate = normalized.at(-1) ?? "";
      normalized = normalized.slice(0, -1);
    }
    if (!normalized) return terminal.sequence;
    this.counters.droppedOrTruncatedChars += terminal.buffer.append(normalized);
    terminal.sequence += 1;
    const sequence = terminal.sequence;

    for (const consumerId of terminal.consumers) {
      const consumer = this.consumers.get(this.consumerKey(consumerId, terminalId));
      if (!consumer || consumer.needsReset) continue;
      if (consumer.pendingChars + normalized.length > this.maxPendingChars) {
        consumer.pending = [];
        consumer.pendingChars = 0;
        consumer.needsReset = true;
        continue;
      }
      consumer.pending.push({ sequence, data: normalized });
      consumer.pendingChars += normalized.length;
    }
    return sequence;
  }

  /**
   * Finish a producer stream before publishing its exit cursor.
   *
   * A PTY chunk can end between the two UTF-16 code units of a supplementary
   * character. While the process is alive we retain that leading surrogate so
   * the next chunk can complete it. At EOF there is no next chunk, so publish a
   * replacement character as ordinary sequenced output instead of silently
   * dropping the final code unit or exposing malformed UTF-16 to xterm.
   */
  finalize(terminalId: string): number {
    const terminal = this.terminals.get(terminalId);
    if (!terminal?.pendingHighSurrogate) return terminal?.sequence ?? 0;
    terminal.pendingHighSurrogate = "";
    return this.append(terminalId, "\ufffd");
  }

  getBuffer(terminalId: string): string {
    return this.terminals.get(terminalId)?.buffer.value() ?? "";
  }

  /** Subscribe for future output without replaying history. */
  subscribe(terminalId: string, consumerId: string): void {
    if (this.consumers.has(this.consumerKey(consumerId, terminalId))) return;
    this.rebaseConsumer(terminalId, consumerId);
  }

  /** Atomically subscribe/rebase and return the replay cursor. */
  attach(
    terminalId: string,
    consumerId: string,
    options: TerminalStreamAttachOptions = {},
  ): TerminalStreamAttachSnapshot {
    const startedAt = process.hrtime.bigint();
    const terminal = this.terminal(terminalId);
    const replayMaxChars = options.replayMaxChars == null
      ? null
      : Math.max(0, Math.floor(options.replayMaxChars));
    this.rebaseConsumer(terminalId, consumerId, Boolean(options.paused), replayMaxChars);
    const buffer = replayMaxChars == null
      ? terminal.buffer.value()
      : terminal.buffer.replay(replayMaxChars);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.counters.replayCount += 1;
    this.counters.replayBytes += Buffer.byteLength(buffer);
    this.counters.replayDurationMs += durationMs;
    this.counters.maxReplayDurationMs = Math.max(this.counters.maxReplayDurationMs, durationMs);
    return {
      id: terminalId,
      epoch: terminal.epoch,
      buffer,
      throughSequence: terminal.sequence,
    };
  }

  pauseConsumer(terminalId: string, consumerId: string): boolean {
    const consumer = this.consumers.get(this.consumerKey(consumerId, terminalId));
    if (!consumer) return false;
    consumer.paused = true;
    return true;
  }

  resumeConsumer(terminalId: string, consumerId: string): boolean {
    const consumer = this.consumers.get(this.consumerKey(consumerId, terminalId));
    if (!consumer) return false;
    consumer.paused = false;
    return true;
  }

  detach(terminalId: string, consumerId: string): void {
    const key = this.consumerKey(consumerId, terminalId);
    this.gate.clear(key);
    this.consumers.delete(key);
    const terminal = this.terminals.get(terminalId);
    terminal?.consumers.delete(consumerId);
    // A late attach after an exited terminal's tombstone was cleared creates a
    // temporary empty epoch so the renderer can resolve its stale exit. Do not
    // retain that phantom indefinitely after its final view goes away. The same
    // rule is safe for a live PTY before first output: its next chunk simply
    // creates the authoritative epoch then.
    if (
      terminal
      && terminal.consumers.size === 0
      && terminal.sequence === 0
      && terminal.buffer.length === 0
      && !terminal.pendingHighSurrogate
    ) {
      this.terminals.delete(terminalId);
    }
  }

  detachConsumer(consumerId: string): void {
    for (const consumer of Array.from(this.consumers.values())) {
      if (consumer.consumerId === consumerId) this.detach(consumer.terminalId, consumerId);
    }
  }

  clearTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      for (const consumerId of terminal.consumers) {
        const key = this.consumerKey(consumerId, terminalId);
        this.gate.clear(key);
        this.consumers.delete(key);
      }
    }
    this.terminals.delete(terminalId);
  }

  poll(
    now: number = Date.now(),
    onlyConsumerKey?: string,
    onlyTerminalId?: string,
  ): TerminalStreamDelivery[] {
    const deliveries: TerminalStreamDelivery[] = [];
    const consumers = onlyConsumerKey
      ? [this.consumers.get(onlyConsumerKey)].filter((item): item is ConsumerState => Boolean(item))
      : onlyTerminalId
        ? Array.from(this.terminals.get(onlyTerminalId)?.consumers ?? [])
            .map((consumerId) => this.consumers.get(this.consumerKey(consumerId, onlyTerminalId)))
            .filter((item): item is ConsumerState => Boolean(item))
        : Array.from(this.consumers.values());

    for (const consumer of consumers) {
      if (consumer.paused) continue;
      const key = this.consumerKey(consumer.consumerId, consumer.terminalId);
      const retry = this.gate.retry(key, now);
      if (retry) {
        this.counters.retries += 1;
        this.counters.deliveredChars += retry.data.length;
        deliveries.push(retry);
        continue;
      }
      if (!this.gate.canSend(key)) continue;

      const terminal = this.terminals.get(consumer.terminalId);
      if (!terminal) continue;
      let batch: TerminalStreamDelivery | null = null;
      if (consumer.needsReset) {
        this.counters.resets += 1;
        consumer.needsReset = false;
        consumer.pending = [];
        consumer.pendingChars = 0;
        batch = {
          id: consumer.terminalId,
          consumerId: consumer.consumerId,
          epoch: terminal.epoch,
          fromSequence: 0,
          sequence: terminal.sequence,
          data: this.replaySnapshot(terminal, consumer.replayMaxChars),
          reset: true,
        };
      } else if (consumer.pending.length > 0) {
        const chunks = consumer.pending;
        consumer.pending = [];
        consumer.pendingChars = 0;
        batch = {
          id: consumer.terminalId,
          consumerId: consumer.consumerId,
          epoch: terminal.epoch,
          fromSequence: chunks[0].sequence,
          sequence: chunks[chunks.length - 1].sequence,
          data: chunks.map((chunk) => chunk.data).join(""),
          reset: false,
        };
      }

      if (batch) {
        this.gate.markSent(key, batch, now);
        this.counters.deliveredChars += batch.data.length;
        deliveries.push(batch);
      }
    }
    return deliveries;
  }

  pollTerminal(terminalId: string, now: number = Date.now()): TerminalStreamDelivery[] {
    return this.poll(now, undefined, terminalId);
  }

  acknowledge(
    terminalId: string,
    consumerId: string,
    epoch: string,
    sequence: number,
  ): boolean {
    const key = this.consumerKey(consumerId, terminalId);
    const current = this.gate.current(key);
    const acknowledged = this.gate.acknowledge(key, epoch, sequence);
    if (acknowledged && current) this.counters.acknowledgedChars += current.data.length;
    return acknowledged;
  }

  consumerKey(consumerId: string, terminalId: string): string {
    return `${consumerId}\u0000${terminalId}`;
  }

  nextRetryDelayMs(now: number = Date.now()): number | null {
    let delay: number | null = null;
    for (const consumer of this.consumers.values()) {
      const candidate = this.gate.retryDelayMs(
        this.consumerKey(consumer.consumerId, consumer.terminalId),
        now,
      );
      if (candidate != null) delay = Math.min(delay ?? Number.POSITIVE_INFINITY, candidate);
    }
    return delay;
  }

  hasPendingDeliveries(): boolean {
    for (const consumer of this.consumers.values()) {
      if (consumer.needsReset || consumer.pending.length > 0) return true;
      if (this.gate.current(this.consumerKey(consumer.consumerId, consumer.terminalId))) return true;
    }
    return false;
  }

  hasPendingDeliveriesForTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;
    for (const consumerId of terminal.consumers) {
      const key = this.consumerKey(consumerId, terminalId);
      const consumer = this.consumers.get(key);
      if (consumer?.needsReset || (consumer?.pending.length ?? 0) > 0) return true;
      if (this.gate.current(key)) return true;
    }
    return false;
  }

  pendingChars(): number {
    let total = 0;
    for (const consumer of this.consumers.values()) {
      total += consumer.pendingChars;
      total += this.gate.current(this.consumerKey(consumer.consumerId, consumer.terminalId))?.data.length ?? 0;
    }
    return total;
  }

  bufferedChars(): number {
    let total = 0;
    for (const terminal of this.terminals.values()) total += terminal.buffer.length;
    return total;
  }

  terminalConsumerIds(terminalId: string): string[] {
    return Array.from(this.terminals.get(terminalId)?.consumers ?? []);
  }

  terminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  cursor(terminalId: string): { epoch: string; sequence: number } {
    const terminal = this.terminal(terminalId);
    return { epoch: terminal.epoch, sequence: terminal.sequence };
  }

  diagnostics(): TerminalOutputStreamDiagnostics {
    return {
      subscribers: this.consumers.size,
      retries: this.counters.retries,
      resets: this.counters.resets,
      droppedOrTruncatedChars: this.counters.droppedOrTruncatedChars,
      deliveredChars: this.counters.deliveredChars,
      acknowledgedChars: this.counters.acknowledgedChars,
      replayCount: this.counters.replayCount,
      replayBytes: this.counters.replayBytes,
      replayDurationMs: Math.round(this.counters.replayDurationMs * 100) / 100,
      maxReplayDurationMs: Math.round(this.counters.maxReplayDurationMs * 100) / 100,
    };
  }

  private rebaseConsumer(
    terminalId: string,
    consumerId: string,
    paused = false,
    replayMaxChars: number | null = null,
  ): void {
    const terminal = this.terminal(terminalId);
    const key = this.consumerKey(consumerId, terminalId);
    this.gate.clear(key);
    this.consumers.set(key, {
      terminalId,
      consumerId,
      pending: [],
      pendingChars: 0,
      needsReset: false,
      paused,
      replayMaxChars,
    });
    terminal.consumers.add(consumerId);
  }

  private terminal(terminalId: string): TerminalState {
    let terminal = this.terminals.get(terminalId);
    if (!terminal) {
      terminal = {
        epoch: this.epochFactory(),
        sequence: 0,
        buffer: new BoundedTerminalReplayBuffer(this.maxSnapshotChars),
        pendingHighSurrogate: "",
        consumers: new Set(),
      };
      this.terminals.set(terminalId, terminal);
    }
    return terminal;
  }

  private replaySnapshot(terminal: TerminalState, replayMaxChars: number | null): string {
    return replayMaxChars == null ? terminal.buffer.value() : terminal.buffer.replay(replayMaxChars);
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
