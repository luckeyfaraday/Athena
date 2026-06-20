// Shaping helpers for terminal buffer/stream responses on the control server.
// Kept free of any `electron` import so it can be unit tested in plain Node.

export const DEFAULT_TERMINAL_BUFFER_MAX_CHARS = 40_000;
export const MIN_TERMINAL_BUFFER_MAX_CHARS = 1_000;
export const MAX_TERMINAL_BUFFER_MAX_CHARS = 200_000;
export const DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS = 64_000;
export const TERMINAL_OUTPUT_TRUNCATED_NOTICE = "\r\n\x1b[33m[Athena truncated terminal output backlog]\x1b[0m\r\n";

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

export function appendBoundedTerminalOutput(
  existing: string,
  data: string,
  maxChars: number = DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
): string {
  const combined = `${existing}${data}`;
  if (combined.length <= maxChars) return combined;

  const boundedMax = Math.max(0, Math.floor(maxChars));
  const notice = TERMINAL_OUTPUT_TRUNCATED_NOTICE.slice(0, boundedMax);
  const tailChars = Math.max(0, boundedMax - notice.length);
  return `${notice}${tailChars > 0 ? combined.slice(-tailChars) : ""}`;
}
