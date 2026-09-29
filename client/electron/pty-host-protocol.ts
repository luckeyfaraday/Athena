export type PtyHostSpawnRequest = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
};

export type PtyHostRequest =
  | { requestId: string; type: "spawn"; payload: PtyHostSpawnRequest }
  | { requestId: string; type: "write"; id: string; data: string }
  | { requestId: string; type: "resize"; id: string; cols: number; rows: number }
  | { requestId: string; type: "kill"; id: string }
  | { requestId: string; type: "shutdown" };

/**
 * Fire-and-forget output backpressure (no requestId, no response). Main sends
 * `paused: true` when a consumer of the terminal's output is far behind and
 * `paused: false` once it catches up; the host pauses/resumes reading the PTY
 * so the producing process blocks on its own writes instead of main dropping
 * output. The host also auto-resumes after a failsafe timeout.
 */
export type PtyHostFlowControl = { type: "flow"; id: string; paused: boolean };

export type PtyHostInbound = PtyHostRequest | PtyHostFlowControl;

export type PtyHostResponse =
  | { requestId: string; ok: true; pid?: number | null }
  | { requestId: string; ok: false; error: string };

export type PtyHostEvent =
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number | null }
  | { type: "error"; id: string | null; error: string };

export type PtyHostMessage = PtyHostResponse | PtyHostEvent;

// Host-side failsafe: a pause main forgets to lift (e.g. a bug or a lost
// update) must never block an agent's output forever. Main's own policy
// resumes well before this (see TerminalFlowController.maxPauseMs).
export const PTY_HOST_MAX_PAUSE_MS = 15_000;
// While a PTY is paused, check that its process is still alive this often.
// node-pty tears the output socket down ~200ms (Unix) after the child exits;
// resuming before then lets the unread tail reach the ring buffer.
export const PTY_PAUSE_LIVENESS_POLL_MS = 50;
// Before killing a PTY that was paused, let its buffered output drain: kill
// once no output arrived for the quiet window, or at the cap regardless.
export const PTY_KILL_DRAIN_QUIET_MS = 50;
export const PTY_KILL_DRAIN_MAX_MS = 300;

/**
 * PTY read pausing is POSIX-only. On Windows, node-pty's conout worker pipes
 * with backpressure, so a paused socket leaves ConPTY's output pipe full and
 * ClosePseudoConsole (kill/shutdown) can block the host's main thread forever
 * on Windows 10 / pre-24H2 builds. Windows relies on no-truncation batching
 * plus the rate-limited reset snapshot instead.
 */
export function ptyFlowControlSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export type PtyFlowTarget = {
  /** Pause reading the PTY; false when the terminal no longer exists. */
  pause: (id: string) => boolean;
  resume: (id: string) => void;
  /** Whether the PTY's process still exists (polled only while paused). */
  isAlive?: (id: string) => boolean;
};

export type PtyFlowGateOptions = {
  platform?: NodeJS.Platform;
  maxPauseMs?: number;
  livenessPollMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type PausedPty = {
  failsafeTimer: unknown;
  livenessTimer: unknown;
};

/** Host-side enforcement of PtyHostFlowControl messages. */
export class PtyFlowGate {
  private readonly paused = new Map<string, PausedPty>();
  private readonly enabled: boolean;
  private readonly maxPauseMs: number;
  private readonly livenessPollMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly target: PtyFlowTarget, options: PtyFlowGateOptions = {}) {
    this.enabled = ptyFlowControlSupported(options.platform ?? process.platform);
    this.maxPauseMs = Math.max(1, options.maxPauseMs ?? PTY_HOST_MAX_PAUSE_MS);
    this.livenessPollMs = Math.max(1, options.livenessPollMs ?? PTY_PAUSE_LIVENESS_POLL_MS);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  apply(id: string, paused: boolean): void {
    if (!paused) {
      this.release(id);
      return;
    }
    // Second guard behind main's controller: never pause on Windows.
    if (!this.enabled || this.paused.has(id)) return;
    if (!this.target.pause(id)) return;
    const state: PausedPty = { failsafeTimer: null, livenessTimer: null };
    state.failsafeTimer = this.setTimer(() => {
      if (this.paused.get(id) !== state) return;
      state.failsafeTimer = null;
      this.release(id);
    }, this.maxPauseMs);
    this.paused.set(id, state);
    this.scheduleLivenessCheck(id, state);
  }

  /** Resume a paused PTY (on request, on exit, and before kill/shutdown). */
  release(id: string): void {
    const state = this.paused.get(id);
    if (!state) return;
    this.clearTimers(state);
    this.paused.delete(id);
    this.target.resume(id);
  }

  /** Drop state for a PTY that no longer exists, without touching it. */
  forget(id: string): void {
    const state = this.paused.get(id);
    if (!state) return;
    this.clearTimers(state);
    this.paused.delete(id);
  }

  releaseAll(): void {
    for (const id of Array.from(this.paused.keys())) this.release(id);
  }

  isPaused(id: string): boolean {
    return this.paused.has(id);
  }

  pausedIds(): string[] {
    return Array.from(this.paused.keys());
  }

  private scheduleLivenessCheck(id: string, state: PausedPty): void {
    const isAlive = this.target.isAlive;
    if (!isAlive) return;
    state.livenessTimer = this.setTimer(() => {
      if (this.paused.get(id) !== state) return;
      state.livenessTimer = null;
      if (!isAlive(id)) {
        this.release(id);
        return;
      }
      this.scheduleLivenessCheck(id, state);
    }, this.livenessPollMs);
  }

  private clearTimers(state: PausedPty): void {
    if (state.failsafeTimer != null) this.clearTimer(state.failsafeTimer);
    if (state.livenessTimer != null) this.clearTimer(state.livenessTimer);
    state.failsafeTimer = null;
    state.livenessTimer = null;
  }
}

export type OutputQuietOptions = {
  quietMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
};

/**
 * Invoke `done` once no output has been observed for `quietMs` (measured from
 * the later of the call and `lastOutputAt()`), or after `maxMs` regardless.
 */
export function afterOutputQuiet(
  lastOutputAt: () => number,
  done: () => void,
  options: OutputQuietOptions = {},
): void {
  const quietMs = Math.max(1, options.quietMs ?? PTY_KILL_DRAIN_QUIET_MS);
  const maxMs = Math.max(quietMs, options.maxMs ?? PTY_KILL_DRAIN_MAX_MS);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const startedAt = now();
  const check = () => {
    const current = now();
    const elapsedMs = current - startedAt;
    const quietForMs = current - Math.max(startedAt, lastOutputAt());
    if (quietForMs >= quietMs || elapsedMs >= maxMs) {
      done();
      return;
    }
    setTimer(check, Math.max(1, Math.min(quietMs - quietForMs, maxMs - elapsedMs)));
  };
  setTimer(check, quietMs);
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as NodeJS.Timeout);
}
