export const TERMINAL_OUTPUT_CLEANUP_INTERVAL_MS = 30_000;
export const TERMINAL_OUTPUT_MAX_GRACE_MS = 120_000;

export type TerminalOutputCleanupDecision = {
  clear: boolean;
  delayMs: number;
};

/** Pure deadline policy for deterministic tests and bounded exit tombstones. */
export function terminalOutputCleanupDecision(
  now: number,
  deadline: number,
  hasPendingDelivery: boolean,
): TerminalOutputCleanupDecision {
  if (!hasPendingDelivery || now >= deadline) return { clear: true, delayMs: 0 };
  return {
    clear: false,
    delayMs: Math.max(1, Math.min(TERMINAL_OUTPUT_CLEANUP_INTERVAL_MS, deadline - now)),
  };
}
