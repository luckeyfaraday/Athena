// Default window after which an unacknowledged terminal output batch is treated
// as lost. Comfortably above a normal IPC round-trip (sub-millisecond) so it
// only fires when an ack genuinely never arrives.
export const DEFAULT_OUTPUT_ACK_TIMEOUT_MS = 2_000;

type InFlightBatch = { sequence: number; sentAt: number };

/**
 * Single-batch-in-flight backpressure gate for embedded terminal output.
 *
 * `flushOutput` sends at most one unacknowledged batch per terminal so the
 * renderer can't be flooded faster than it drains; the renderer acknowledges
 * each batch by sequence, and until then the gate holds further sends.
 *
 * Without a timeout this wedges: if the renderer reloads or crashes after a
 * batch is emitted but before it acks, the in-flight entry is never cleared and
 * every later flush skips that terminal forever — its live output silently
 * freezes until the process exits. A send left unacknowledged for longer than
 * `ackTimeoutMs` is therefore treated as lost, so the next flush re-sends and
 * the terminal recovers on its own. The dropped batch's bytes are still in the
 * rolling buffer, so a remounting renderer re-renders them from the snapshot.
 */
export class OutputAckGate {
  private readonly inFlight = new Map<string, InFlightBatch>();
  private nextSequence = 1;

  constructor(private readonly ackTimeoutMs: number = DEFAULT_OUTPUT_ACK_TIMEOUT_MS) {}

  /** Whether a fresh batch may be sent for this terminal right now. */
  canSend(id: string, now: number = Date.now()): boolean {
    const inFlight = this.inFlight.get(id);
    if (!inFlight) return true;
    return now - inFlight.sentAt >= this.ackTimeoutMs;
  }

  /** Milliseconds until a blocked terminal should be retried, or null if unblocked. */
  retryDelayMs(id: string, now: number = Date.now()): number | null {
    const inFlight = this.inFlight.get(id);
    if (!inFlight) return null;
    return Math.max(0, this.ackTimeoutMs - (now - inFlight.sentAt));
  }

  /** Record that a batch was just sent; returns its sequence number. */
  markSent(id: string, now: number = Date.now()): number {
    const sequence = this.nextSequence++;
    this.inFlight.set(id, { sequence, sentAt: now });
    return sequence;
  }

  /** Clear the gate when the ack matches the outstanding batch. Returns whether it cleared. */
  acknowledge(id: string, sequence: number): boolean {
    if (this.inFlight.get(id)?.sequence !== sequence) return false;
    this.inFlight.delete(id);
    return true;
  }

  clear(id: string): void {
    this.inFlight.delete(id);
  }
}
