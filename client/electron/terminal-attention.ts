export type TerminalAttentionKind = "action" | "update";

export const TERMINAL_ATTENTION_SCAN_MAX_CHARS = 4_000;
// At most one attention scan per terminal per interval (leading + trailing),
// instead of a regex pass over a 4KB tail for every PTY batch.
export const TERMINAL_ATTENTION_THROTTLE_MS = 250;
const TERMINAL_ATTENTION_CARRY_CHARS = 96;

const attentionCuePattern = /\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue|waiting|needs?|requesting|press|select|task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i;

/**
 * Classify a bounded tail of a PTY chunk in main so hidden terminals do not
 * need raw renderer IPC merely to update workspace attention badges.
 */
export function classifyTerminalAttention(data: string): TerminalAttentionKind | null {
  const bounded = data.length > TERMINAL_ATTENTION_SCAN_MAX_CHARS
    ? data.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS)
    : data;
  if (!attentionCuePattern.test(bounded)) return null;
  const text = bounded.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue)\b/i.test(text)) {
    if (/\b(waiting|needs?|requires?|requesting|press|select|confirm|approve|allow|permission)\b/i.test(text)) {
      return "action";
    }
  }
  if (/\b(task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i.test(text)) {
    return "update";
  }
  return null;
}

export type TerminalAttentionTrackerOptions = {
  throttleMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type AttentionState = {
  // Tail of already-scanned text so cue words split across batches match.
  carry: string;
  // Newest text not yet scanned, bounded to the scan window.
  unscanned: string;
  lastScanAt: number;
  timer: unknown;
};

/**
 * Per-terminal attention classification over new output only (plus a tiny
 * carried suffix), throttled so a chatty terminal is scanned at most once per
 * `throttleMs`. A trailing scan always covers output that arrived during the
 * quiet window, so the final prompt of a burst is never missed.
 */
export class TerminalAttentionTracker {
  private readonly states = new Map<string, AttentionState>();
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly onAttention?: (id: string, kind: TerminalAttentionKind) => void,
    options: TerminalAttentionTrackerOptions = {},
  ) {
    this.throttleMs = Math.max(0, options.throttleMs ?? TERMINAL_ATTENTION_THROTTLE_MS);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Record output; scans now or on the trailing edge, reporting via onAttention. */
  observe(id: string, data: string): void {
    if (!data) return;
    const state = this.state(id);
    appendUnscanned(state, data);
    if (state.timer != null) return;
    const now = this.now();
    const waitMs = state.lastScanAt + this.throttleMs - now;
    if (waitMs <= 0) {
      this.scanAndReport(id, state, now);
      return;
    }
    state.timer = this.setTimer(() => {
      state.timer = null;
      if (this.states.get(id) !== state) return;
      this.scanAndReport(id, state, this.now());
    }, waitMs);
  }

  /** Unthrottled: record output and classify it immediately. */
  classify(id: string, data: string): TerminalAttentionKind | null {
    const state = this.state(id);
    appendUnscanned(state, data);
    return this.scan(state, this.now());
  }

  clear(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    if (state.timer != null) this.clearTimer(state.timer);
    this.states.delete(id);
  }

  private state(id: string): AttentionState {
    let state = this.states.get(id);
    if (!state) {
      state = { carry: "", unscanned: "", lastScanAt: Number.NEGATIVE_INFINITY, timer: null };
      this.states.set(id, state);
    }
    return state;
  }

  private scanAndReport(id: string, state: AttentionState, now: number): void {
    const kind = this.scan(state, now);
    if (kind) this.onAttention?.(id, kind);
  }

  private scan(state: AttentionState, now: number): TerminalAttentionKind | null {
    state.lastScanAt = now;
    if (!state.unscanned) return null;
    const text = `${state.carry}${state.unscanned}`;
    state.unscanned = "";
    state.carry = text.slice(-TERMINAL_ATTENTION_CARRY_CHARS);
    return classifyTerminalAttention(text);
  }
}

function appendUnscanned(state: AttentionState, data: string): void {
  if (data.length >= TERMINAL_ATTENTION_SCAN_MAX_CHARS) {
    state.unscanned = data.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS);
    return;
  }
  const combined = `${state.unscanned}${data}`;
  // Amortized trim: let the rope grow to twice the window before flattening.
  state.unscanned = combined.length > TERMINAL_ATTENTION_SCAN_MAX_CHARS * 2
    ? combined.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS)
    : combined;
}
