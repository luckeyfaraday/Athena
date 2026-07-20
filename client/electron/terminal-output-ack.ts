// Default window after which an unacknowledged terminal output batch is
// retried. The exact same retained batch is sent again; the renderer discards
// an already-applied sequence and ACKs it without writing twice.
export const DEFAULT_OUTPUT_ACK_TIMEOUT_MS = 2_000;

export type SequencedOutputBatch = {
  epoch: string;
  fromSequence: number;
  sequence: number;
  data: string;
  reset: boolean;
};

type InFlightBatch<T extends SequencedOutputBatch> = {
  batch: T;
  sentAt: number;
};

/**
 * Single-batch-in-flight backpressure with payload retention.
 *
 * The old gate remembered only a sequence number. Once main emitted a batch it
 * deleted the bytes, so its timeout could send later output but could not
 * actually recover the missing batch. This gate owns the in-flight payload
 * until a matching epoch/sequence ACK arrives and only ever retries that same
 * payload. Gates are keyed by consumer+terminal, keeping slow panes isolated.
 */
export class OutputAckGate<T extends SequencedOutputBatch = SequencedOutputBatch> {
  private readonly inFlight = new Map<string, InFlightBatch<T>>();

  constructor(private readonly ackTimeoutMs: number = DEFAULT_OUTPUT_ACK_TIMEOUT_MS) {}

  canSend(key: string): boolean {
    return !this.inFlight.has(key);
  }

  markSent(key: string, batch: T, now: number = Date.now()): void {
    if (this.inFlight.has(key)) throw new Error(`Output already in flight for ${key}`);
    this.inFlight.set(key, { batch, sentAt: now });
  }

  current(key: string): T | null {
    return this.inFlight.get(key)?.batch ?? null;
  }

  /**
   * Return the retained payload once its ACK deadline expires and restart the
   * deadline. Callers may safely emit it again because the renderer deduplicates
   * the epoch/sequence before writing.
   */
  retry(key: string, now: number = Date.now()): T | null {
    const inFlight = this.inFlight.get(key);
    if (!inFlight || now - inFlight.sentAt < this.ackTimeoutMs) return null;
    inFlight.sentAt = now;
    return inFlight.batch;
  }

  retryDelayMs(key: string, now: number = Date.now()): number | null {
    const inFlight = this.inFlight.get(key);
    if (!inFlight) return null;
    return Math.max(0, this.ackTimeoutMs - (now - inFlight.sentAt));
  }

  acknowledge(key: string, epoch: string, sequence: number): boolean {
    const inFlight = this.inFlight.get(key);
    if (!inFlight) return false;
    if (inFlight.batch.epoch !== epoch || inFlight.batch.sequence !== sequence) return false;
    this.inFlight.delete(key);
    return true;
  }

  clear(key: string): void {
    this.inFlight.delete(key);
  }

  clearMatching(predicate: (key: string) => boolean): void {
    for (const key of this.inFlight.keys()) {
      if (predicate(key)) this.inFlight.delete(key);
    }
  }
}
