type TerminalActivity = {
  lastInputAt: number | null;
  lastOutputAt: number | null;
  outputAfterInput: boolean;
};

export const TERMINAL_IDLE_SETTLE_MS = 5_000;
export const TERMINAL_INPUT_TIMEOUT_MS = 120_000;

const activity = new Map<string, TerminalActivity>();

export function recordTerminalInputActivity(terminalId: string, at = Date.now()): void {
  const current = activity.get(terminalId);
  activity.set(terminalId, {
    lastInputAt: at,
    lastOutputAt: current?.lastOutputAt ?? null,
    outputAfterInput: false,
  });
}

/** Hot path (every PTY batch): mutates the existing record in place. */
export function recordTerminalOutputActivity(terminalId: string, at = Date.now()): void {
  const current = activity.get(terminalId);
  if (!current) {
    activity.set(terminalId, { lastInputAt: null, lastOutputAt: at, outputAfterInput: false });
    return;
  }
  current.lastOutputAt = at;
  if (current.lastInputAt != null) current.outputAfterInput = true;
}

export function isTerminalActive(terminalId: string, at = Date.now()): boolean {
  const current = activity.get(terminalId);
  if (!current) return false;
  if (current.lastOutputAt != null && at - current.lastOutputAt < TERMINAL_IDLE_SETTLE_MS) return true;
  return current.lastInputAt != null
    && !current.outputAfterInput
    && at - current.lastInputAt < TERMINAL_INPUT_TIMEOUT_MS;
}

export function clearTerminalActivity(terminalId: string): void {
  activity.delete(terminalId);
}

export function resetTerminalActivityForTests(): void {
  activity.clear();
}
