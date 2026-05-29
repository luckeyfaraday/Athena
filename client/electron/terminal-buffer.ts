// Shaping helpers for terminal buffer/stream responses on the control server.
// Kept free of any `electron` import so it can be unit tested in plain Node.

export const DEFAULT_TERMINAL_BUFFER_MAX_CHARS = 40_000;
export const MIN_TERMINAL_BUFFER_MAX_CHARS = 1_000;
export const MAX_TERMINAL_BUFFER_MAX_CHARS = 200_000;

export type TerminalBufferResult = {
  buffer: string;
  chars: number;
  max_chars: number;
};

export function boundedTerminalBufferMaxChars(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_TERMINAL_BUFFER_MAX_CHARS);
  if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_BUFFER_MAX_CHARS;
  return Math.max(
    MIN_TERMINAL_BUFFER_MAX_CHARS,
    Math.min(Math.floor(parsed), MAX_TERMINAL_BUFFER_MAX_CHARS),
  );
}

export function terminalBufferTail(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

export function formatTerminalBuffer(value: string, maxChars: number): TerminalBufferResult {
  const buffer = terminalBufferTail(value, maxChars);
  return {
    buffer,
    chars: buffer.length,
    max_chars: maxChars,
  };
}
