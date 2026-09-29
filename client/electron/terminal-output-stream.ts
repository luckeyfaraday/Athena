import { randomUUID } from "node:crypto";
import { ptyFlowControlSupported } from "./pty-host-protocol.js";
import { BoundedTerminalReplayBuffer } from "./terminal-buffer.js";
import {
  DEFAULT_OUTPUT_ACK_TIMEOUT_MS,
  OutputAckGate,
  type SequencedOutputBatch,
} from "./terminal-output-ack.js";

// A consumer that falls this far behind (pending, unsent chars) is rebased
// with an explicit reset snapshot. With PTY backpressure this is a last
// resort: it only triggers when a consumer stays stalled past the pause cap.
export const DEFAULT_CONSUMER_RESET_BACKLOG_CHARS = 1_000_000;
// At most one overflow reset per consumer per interval. Each reset replays a
// full snapshot, so an unthrottled slow consumer could otherwise loop on
// reset -> replay -> overflow -> reset and burn more CPU than the output.
export const DEFAULT_MIN_RESET_INTERVAL_MS = 2_000;

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

type TerminalState = {
  epoch: string;
  sequence: number;
  buffer: BoundedTerminalReplayBuffer;
  pendingHighSurrogate: string;
  consumers: Map<string, ConsumerState>;
};

type ConsumerState = {
  key: string;
  terminalId: string;
  consumerId: string;
  // Pending live output. Sequences are contiguous: pendingParts[i] carries
  // sequence pendingFirstSequence + i.
  pendingParts: string[];
  pendingFirstSequence: number;
  pendingChars: number;
  needsReset: boolean;
  lastResetAt: number;
  paused: boolean;
  replayMaxChars: number | null;
  maxBatchChars: number | null;
};

export type TerminalStreamAttachOptions = {
  replayMaxChars?: number;
  /** Cap one live delivery (always at least one sequence) for this consumer. */
  maxBatchChars?: number;
  paused?: boolean;
};

export type TerminalOutputStreamOptions = {
  maxSnapshotChars?: number;
  maxPendingChars?: number;
  ackTimeoutMs?: number;
  minResetIntervalMs?: number;
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
  private readonly minResetIntervalMs: number;
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
      Math.floor(options.maxPendingChars ?? DEFAULT_CONSUMER_RESET_BACKLOG_CHARS),
    );
    this.minResetIntervalMs = Math.max(0, options.minResetIntervalMs ?? DEFAULT_MIN_RESET_INTERVAL_MS);
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
      normalized = isLowSurrogate(data.charCodeAt(0))
        ? `${terminal.pendingHighSurrogate}${data}`
        : `�${data}`;
    }
    terminal.pendingHighSurrogate = "";
    if (normalized && isHighSurrogate(normalized.charCodeAt(normalized.length - 1))) {
      terminal.pendingHighSurrogate = normalized.charAt(normalized.length - 1);
      normalized = normalized.slice(0, -1);
    }
    if (!normalized) return terminal.sequence;
    this.counters.droppedOrTruncatedChars += terminal.buffer.append(normalized);
    terminal.sequence += 1;
    const sequence = terminal.sequence;

    for (const consumer of terminal.consumers.values()) {
      if (consumer.needsReset) continue;
      if (consumer.pendingChars + normalized.length > this.maxPendingChars) {
        consumer.pendingParts = [];
        consumer.pendingChars = 0;
        consumer.needsReset = true;
        continue;
      }
      if (consumer.pendingParts.length === 0) consumer.pendingFirstSequence = sequence;
      consumer.pendingParts.push(normalized);
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
    return this.append(terminalId, "�");
  }

  getBuffer(terminalId: string): string {
    return this.terminals.get(terminalId)?.buffer.value() ?? "";
  }

  /** Subscribe for future output without replaying history. */
  subscribe(
    terminalId: string,
    consumerId: string,
    options: Omit<TerminalStreamAttachOptions, "paused"> = {},
  ): void {
    if (this.consumers.has(this.consumerKey(consumerId, terminalId))) return;
    this.rebaseConsumer(terminalId, consumerId, false, options);
  }

  /** Atomically subscribe/rebase and return the replay cursor. */
  attach(
    terminalId: string,
    consumerId: string,
    options: TerminalStreamAttachOptions = {},
  ): TerminalStreamAttachSnapshot {
    const startedAt = process.hrtime.bigint();
    const terminal = this.terminal(terminalId);
    const consumer = this.rebaseConsumer(terminalId, consumerId, Boolean(options.paused), options);
    const buffer = this.replaySnapshot(terminal, consumer.replayMaxChars);
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
      for (const consumer of terminal.consumers.values()) {
        this.gate.clear(consumer.key);
        this.consumers.delete(consumer.key);
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
    const consumers: Iterable<ConsumerState> = onlyConsumerKey
      ? [this.consumers.get(onlyConsumerKey)].filter((item): item is ConsumerState => Boolean(item))
      : onlyTerminalId
        ? Array.from(this.terminals.get(onlyTerminalId)?.consumers.values() ?? [])
        : Array.from(this.consumers.values());

    for (const consumer of consumers) {
      if (consumer.paused) continue;
      const key = consumer.key;
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
        // Rate-limited: the deferred reset replays whatever is current when it
        // is finally sent, so waiting loses nothing further.
        if (now - consumer.lastResetAt < this.minResetIntervalMs) continue;
        this.counters.resets += 1;
        consumer.needsReset = false;
        consumer.lastResetAt = now;
        consumer.pendingParts = [];
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
      } else if (consumer.pendingParts.length > 0) {
        batch = this.takePendingBatch(consumer, terminal.epoch);
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

  /**
   * Delay until the next poll could make progress for any consumer: a lost-ACK
   * retry deadline, a rate-limited reset, or `pendingDelayMs` for consumers
   * that can send pending output right away. Null when nothing is waiting.
   */
  nextFlushDelayMs(now: number = Date.now(), pendingDelayMs = 0): number | null {
    let delay: number | null = null;
    for (const consumer of this.consumers.values()) {
      if (consumer.paused) continue;
      let candidate = this.gate.retryDelayMs(consumer.key, now);
      if (candidate == null) {
        if (consumer.needsReset) {
          candidate = Math.max(0, consumer.lastResetAt + this.minResetIntervalMs - now);
        } else if (consumer.pendingParts.length > 0) {
          candidate = pendingDelayMs;
        }
      }
      if (candidate != null) delay = Math.min(delay ?? Number.POSITIVE_INFINITY, candidate);
    }
    return delay;
  }

  hasPendingDeliveries(): boolean {
    for (const consumer of this.consumers.values()) {
      if (consumer.paused) continue;
      if (consumer.needsReset || consumer.pendingParts.length > 0) return true;
      if (this.gate.current(consumer.key)) return true;
    }
    return false;
  }

  hasPendingDeliveriesForTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;
    for (const consumer of terminal.consumers.values()) {
      if (consumer.needsReset || consumer.pendingParts.length > 0) return true;
      if (this.gate.current(consumer.key)) return true;
    }
    return false;
  }

  /**
   * True when some live consumer of the terminal could be sent output now.
   * Consumers waiting on an ACK are woken by that ACK (or their retry timer),
   * and a rate-limited reset by its own deadline, so neither needs a flush.
   */
  hasSendableConsumer(terminalId: string, now: number = Date.now()): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;
    for (const consumer of terminal.consumers.values()) {
      if (consumer.paused || !this.gate.canSend(consumer.key)) continue;
      if (consumer.needsReset && now - consumer.lastResetAt < this.minResetIntervalMs) continue;
      return true;
    }
    return false;
  }

  /**
   * Largest live backlog (pending + unacknowledged in-flight chars) among the
   * terminal's consumers. Paused consumers (not yet started) and consumers
   * already awaiting a reset snapshot do not hold back the producer.
   */
  backlogChars(terminalId: string): number {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return 0;
    let backlog = 0;
    for (const consumer of terminal.consumers.values()) {
      if (consumer.paused || consumer.needsReset) continue;
      const inFlight = this.gate.current(consumer.key)?.data.length ?? 0;
      backlog = Math.max(backlog, consumer.pendingChars + inFlight);
    }
    return backlog;
  }

  consumerCount(terminalId: string): number {
    return this.terminals.get(terminalId)?.consumers.size ?? 0;
  }

  /** Count consumer subscriptions across all terminals matching a predicate. */
  countConsumers(predicate: (consumerId: string) => boolean): number {
    let count = 0;
    for (const consumer of this.consumers.values()) {
      if (predicate(consumer.consumerId)) count += 1;
    }
    return count;
  }

  pendingChars(): number {
    let total = 0;
    for (const consumer of this.consumers.values()) {
      total += consumer.pendingChars;
      total += this.gate.current(consumer.key)?.data.length ?? 0;
    }
    return total;
  }

  bufferedChars(): number {
    let total = 0;
    for (const terminal of this.terminals.values()) total += terminal.buffer.length;
    return total;
  }

  terminalConsumerIds(terminalId: string): string[] {
    return Array.from(this.terminals.get(terminalId)?.consumers.keys() ?? []);
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

  private takePendingBatch(consumer: ConsumerState, epoch: string): TerminalStreamDelivery {
    const parts = consumer.pendingParts;
    const limit = consumer.maxBatchChars ?? Number.POSITIVE_INFINITY;
    let count = 1;
    let chars = parts[0].length;
    while (count < parts.length && chars + parts[count].length <= limit) {
      chars += parts[count].length;
      count += 1;
    }
    const fromSequence = consumer.pendingFirstSequence;
    let data: string;
    if (count === parts.length) {
      data = count === 1 ? parts[0] : parts.join("");
      consumer.pendingParts = [];
    } else {
      data = count === 1 ? parts[0] : parts.slice(0, count).join("");
      consumer.pendingParts = parts.slice(count);
    }
    consumer.pendingFirstSequence = fromSequence + count;
    consumer.pendingChars -= chars;
    return {
      id: consumer.terminalId,
      consumerId: consumer.consumerId,
      epoch,
      fromSequence,
      sequence: fromSequence + count - 1,
      data,
      reset: false,
    };
  }

  private rebaseConsumer(
    terminalId: string,
    consumerId: string,
    paused: boolean,
    options: Omit<TerminalStreamAttachOptions, "paused">,
  ): ConsumerState {
    const terminal = this.terminal(terminalId);
    const key = this.consumerKey(consumerId, terminalId);
    this.gate.clear(key);
    const consumer: ConsumerState = {
      key,
      terminalId,
      consumerId,
      pendingParts: [],
      pendingFirstSequence: terminal.sequence + 1,
      pendingChars: 0,
      needsReset: false,
      lastResetAt: Number.NEGATIVE_INFINITY,
      paused,
      replayMaxChars: boundedOption(options.replayMaxChars, 0),
      maxBatchChars: boundedOption(options.maxBatchChars, 1),
    };
    this.consumers.set(key, consumer);
    terminal.consumers.set(consumerId, consumer);
    return consumer;
  }

  private terminal(terminalId: string): TerminalState {
    let terminal = this.terminals.get(terminalId);
    if (!terminal) {
      terminal = {
        epoch: this.epochFactory(),
        sequence: 0,
        buffer: new BoundedTerminalReplayBuffer(this.maxSnapshotChars),
        pendingHighSurrogate: "",
        consumers: new Map(),
      };
      this.terminals.set(terminalId, terminal);
    }
    return terminal;
  }

  private replaySnapshot(terminal: TerminalState, replayMaxChars: number | null): string {
    return replayMaxChars == null ? terminal.buffer.value() : terminal.buffer.replay(replayMaxChars);
  }
}

export type TerminalFlowControlOptions = {
  /**
   * PTY pausing is disabled on win32 (see ptyFlowControlSupported): there the
   * controller never requests a pause and slow consumers fall back to the
   * rate-limited reset snapshot. Injectable for tests.
   */
  platform?: NodeJS.Platform;
  /** Pause the producer once a consumer's backlog exceeds this many chars. */
  highWaterChars?: number;
  /** Resume once every consumer's backlog is at or below this many chars. */
  lowWaterChars?: number;
  /**
   * Longest single pause. A consumer that cannot drain in this time (e.g. a
   * throttled background window) must not stall the agent: the producer is
   * resumed and backpressure is bypassed for `bypassMs`, letting the consumer
   * fall back to a rate-limited reset snapshot instead.
   */
  maxPauseMs?: number;
  bypassMs?: number;
  setPaused: (terminalId: string, paused: boolean) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const DEFAULT_FLOW_HIGH_WATER_CHARS = 256 * 1024;
export const DEFAULT_FLOW_LOW_WATER_CHARS = 64 * 1024;
export const DEFAULT_FLOW_MAX_PAUSE_MS = 2_000;
export const DEFAULT_FLOW_BYPASS_MS = 30_000;

type FlowState = {
  pausedAt: number | null;
  bypassUntil: number;
  timer: unknown;
};

/**
 * Hysteresis-based PTY backpressure. `update()` is fed the backlog after every
 * append/ACK/detach; it pauses above the high-water mark and resumes at the
 * low-water mark, with a hard per-pause cap so a stalled consumer can never
 * stall the producing process indefinitely.
 */
export class TerminalFlowController {
  private readonly states = new Map<string, FlowState>();
  private readonly enabled: boolean;
  private readonly highWaterChars: number;
  private readonly lowWaterChars: number;
  private readonly maxPauseMs: number;
  private readonly bypassMs: number;
  private readonly setPaused: (terminalId: string, paused: boolean) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly counters = { pauses: 0, forcedResumes: 0 };

  constructor(options: TerminalFlowControlOptions) {
    this.enabled = ptyFlowControlSupported(options.platform ?? process.platform);
    this.highWaterChars = Math.max(1, options.highWaterChars ?? DEFAULT_FLOW_HIGH_WATER_CHARS);
    this.lowWaterChars = Math.min(
      this.highWaterChars - 1,
      Math.max(0, options.lowWaterChars ?? DEFAULT_FLOW_LOW_WATER_CHARS),
    );
    this.maxPauseMs = Math.max(1, options.maxPauseMs ?? DEFAULT_FLOW_MAX_PAUSE_MS);
    this.bypassMs = Math.max(0, options.bypassMs ?? DEFAULT_FLOW_BYPASS_MS);
    this.setPaused = options.setPaused;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  update(terminalId: string, backlogChars: number): void {
    if (!this.enabled) return;
    const state = this.states.get(terminalId);
    if (state?.pausedAt != null) {
      if (backlogChars <= this.lowWaterChars) this.resume(terminalId, state, false);
      return;
    }
    if (backlogChars <= this.highWaterChars) {
      if (state && this.now() >= state.bypassUntil) this.states.delete(terminalId);
      return;
    }
    const now = this.now();
    if (state && now < state.bypassUntil) return;
    const next: FlowState = state ?? { pausedAt: null, bypassUntil: 0, timer: null };
    next.pausedAt = now;
    next.bypassUntil = 0;
    next.timer = this.setTimer(() => {
      const current = this.states.get(terminalId);
      if (current !== next || current.pausedAt == null) return;
      current.timer = null;
      this.resume(terminalId, current, true);
    }, this.maxPauseMs);
    this.states.set(terminalId, next);
    this.counters.pauses += 1;
    this.setPaused(terminalId, true);
  }

  /** Drop all flow state for a terminal, resuming its producer if paused. */
  forget(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    this.states.delete(terminalId);
    if (state.timer != null) this.clearTimer(state.timer);
    if (state.pausedAt != null) this.setPaused(terminalId, false);
  }

  isPaused(terminalId: string): boolean {
    return this.states.get(terminalId)?.pausedAt != null;
  }

  pausedTerminalIds(): string[] {
    const ids: string[] = [];
    for (const [terminalId, state] of this.states) {
      if (state.pausedAt != null) ids.push(terminalId);
    }
    return ids;
  }

  diagnostics(): { pausedTerminals: number; pauses: number; forcedResumes: number } {
    return {
      pausedTerminals: this.pausedTerminalIds().length,
      pauses: this.counters.pauses,
      forcedResumes: this.counters.forcedResumes,
    };
  }

  private resume(terminalId: string, state: FlowState, forced: boolean): void {
    if (state.timer != null) this.clearTimer(state.timer);
    state.timer = null;
    state.pausedAt = null;
    if (forced) {
      this.counters.forcedResumes += 1;
      state.bypassUntil = this.now() + this.bypassMs;
    } else {
      this.states.delete(terminalId);
    }
    this.setPaused(terminalId, false);
  }
}

function boundedOption(value: number | undefined, minimum: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(minimum, Math.floor(value));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
