// Shaping helpers for terminal buffer/stream responses on the control server.
// Kept free of any `electron` import so it can be unit tested in plain Node.

export const DEFAULT_TERMINAL_BUFFER_MAX_CHARS = 40_000;
export const MIN_TERMINAL_BUFFER_MAX_CHARS = 1_000;
export const MAX_TERMINAL_BUFFER_MAX_CHARS = 200_000;
export const DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS = 64_000;
// A replay that starts part-way through a VT stream cannot safely inherit the
// parser/cursor/style state that preceded it. Reset first and make the gap
// visible instead of silently presenting a corrupt tail as complete output.
export const TERMINAL_OUTPUT_TRUNCATED_NOTICE = "\x1bc\r\n\x1b[33m[Athena truncated terminal output backlog]\x1b[0m\r\n";

export type TerminalBufferResult = {
  buffer: string;
  chars: number;
  max_chars: number;
};

type TerminalReplayChunk = {
  data: string;
  safeRanges: Array<[start: number, end: number]>;
};

const TERMINAL_REPLAY_CHUNK_TARGET_CHARS = 4_096;

/**
 * Chunked rolling replay storage. Normal output appends are O(1); strings are
 * joined only when a renderer/control client explicitly requests a snapshot.
 * When the budget rolls over, the first retained code unit is moved to a VT
 * parser-safe boundary and the returned replay declares the gap/reset.
 */
export class BoundedTerminalReplayBuffer {
  private readonly chunks: TerminalReplayChunk[] = [];
  private chars = 0;
  private truncated = false;
  private parserState: AnsiParserState = "text";

  constructor(private readonly maxChars: number) {}

  append(data: string): number {
    if (!data) return 0;
    const safeRanges: Array<[start: number, end: number]> = [];
    let state = this.parserState;
    for (let index = 0; index <= data.length; index += 1) {
      if (
        state === "text"
        && isCodePointBoundary(data, index)
      ) {
        const lastRange = safeRanges.at(-1);
        if (lastRange && lastRange[1] === index - 1) lastRange[1] = index;
        else safeRanges.push([index, index]);
      }
      if (index < data.length) state = advanceAnsiParserState(state, data[index], data.charCodeAt(index));
    }
    this.parserState = state;
    const lastChunk = this.chunks.at(-1);
    if (lastChunk && lastChunk.data.length + data.length <= TERMINAL_REPLAY_CHUNK_TARGET_CHARS) {
      const offset = lastChunk.data.length;
      lastChunk.data += data;
      mergeSafeRanges(lastChunk.safeRanges, safeRanges, offset);
    } else {
      this.chunks.push({ data, safeRanges });
    }
    this.chars += data.length;

    const payloadBudget = Math.max(0, Math.floor(this.maxChars) - TERMINAL_OUTPUT_TRUNCATED_NOTICE.length);
    if (this.chars <= Math.floor(this.maxChars) && !this.truncated) return 0;
    this.truncated = true;
    const before = this.chars;
    this.trimToBudget(payloadBudget);
    return Math.max(0, before - this.chars);
  }

  value(): string {
    const value = this.chunks.map((chunk) => chunk.data).join("");
    if (!this.truncated) return value;
    const boundedMax = Math.max(0, Math.floor(this.maxChars));
    if (boundedMax < TERMINAL_OUTPUT_TRUNCATED_NOTICE.length) {
      return "[truncated]".slice(0, boundedMax);
    }
    return `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${value}`;
  }

  /**
   * Materialize a bounded replay using the VT/code-point boundaries indexed
   * during append. Unlike terminalReplayTail(raw), this does not rescan or join
   * the discarded prefix, so mounting a 64 KiB view stays proportional to the
   * replay it will actually parse rather than the full 200k retention budget.
   */
  replay(maxChars: number): string {
    const boundedMax = Math.max(0, Math.floor(maxChars));
    if (this.length <= boundedMax) return this.value();
    if (boundedMax < TERMINAL_OUTPUT_TRUNCATED_NOTICE.length) {
      return "[truncated]".slice(0, boundedMax);
    }

    const payloadBudget = boundedMax - TERMINAL_OUTPUT_TRUNCATED_NOTICE.length;
    const minimumStart = Math.max(0, this.chars - payloadBudget);
    let consumed = 0;
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex];
      const chunkEnd = consumed + chunk.data.length;
      if (chunkEnd < minimumStart) {
        consumed = chunkEnd;
        continue;
      }
      const localMinimum = Math.max(0, minimumStart - consumed);
      const safeOffset = firstOffsetInRanges(chunk.safeRanges, localMinimum);
      if (safeOffset == null) {
        consumed = chunkEnd;
        continue;
      }
      const parts = [chunk.data.slice(safeOffset)];
      for (let tailIndex = chunkIndex + 1; tailIndex < this.chunks.length; tailIndex += 1) {
        parts.push(this.chunks[tailIndex].data);
      }
      return `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${parts.join("")}`;
    }
    return TERMINAL_OUTPUT_TRUNCATED_NOTICE;
  }

  get length(): number {
    if (!this.truncated) return this.chars;
    return this.chars + Math.min(
      TERMINAL_OUTPUT_TRUNCATED_NOTICE.length,
      Math.max(0, Math.floor(this.maxChars)),
    );
  }

  private trimToBudget(payloadBudget: number): void {
    let toDrop = Math.max(0, this.chars - payloadBudget);
    while (this.chunks.length > 0 && toDrop > 0) {
      const chunk = this.chunks[0];
      if (toDrop >= chunk.data.length) {
        this.chunks.shift();
        this.chars -= chunk.data.length;
        toDrop -= chunk.data.length;
        continue;
      }
      const safeOffset = firstOffsetInRanges(chunk.safeRanges, Math.max(1, toDrop));
      if (safeOffset == null) {
        this.chunks.shift();
        this.chars -= chunk.data.length;
        toDrop = 0;
        continue;
      }
      chunk.data = chunk.data.slice(safeOffset);
      chunk.safeRanges = shiftedSafeRanges(chunk.safeRanges, safeOffset);
      this.chars -= safeOffset;
      toDrop = 0;
    }

    // If the desired cut consumed whole chunks, the next chunk can still have
    // begun inside a control sequence from its predecessor. Move to its first
    // known-safe boundary (or discard it) before exposing a replay.
    while (this.chunks.length > 0 && firstOffsetInRanges(this.chunks[0].safeRanges, 0) !== 0) {
      const chunk = this.chunks[0];
      const safeOffset = firstOffsetInRanges(chunk.safeRanges, 1);
      if (safeOffset == null) {
        this.chunks.shift();
        this.chars -= chunk.data.length;
        continue;
      }
      chunk.data = chunk.data.slice(safeOffset);
      chunk.safeRanges = shiftedSafeRanges(chunk.safeRanges, safeOffset);
      this.chars -= safeOffset;
    }
  }
}

function mergeSafeRanges(
  target: Array<[number, number]>,
  source: Array<[number, number]>,
  offset: number,
): void {
  for (const [sourceStart, sourceEnd] of source) {
    const start = sourceStart + offset;
    const end = sourceEnd + offset;
    const last = target.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else target.push([start, end]);
  }
}

function firstOffsetInRanges(ranges: Array<[number, number]>, minimum: number): number | null {
  for (const [start, end] of ranges) {
    if (end >= minimum) return Math.max(start, minimum);
  }
  return null;
}

function shiftedSafeRanges(ranges: Array<[number, number]>, offset: number): Array<[number, number]> {
  return ranges
    .filter(([, end]) => end >= offset)
    .map(([start, end]) => [Math.max(start, offset) - offset, end - offset]);
}

export function boundedTerminalBufferMaxChars(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_TERMINAL_BUFFER_MAX_CHARS);
  if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_BUFFER_MAX_CHARS;
  return Math.max(
    MIN_TERMINAL_BUFFER_MAX_CHARS,
    Math.min(Math.floor(parsed), MAX_TERMINAL_BUFFER_MAX_CHARS),
  );
}

export function terminalBufferTail(value: string, maxChars: number): string {
  const boundedMax = Math.max(0, Math.floor(maxChars));
  if (value.length <= boundedMax) return value;
  if (boundedMax === 0) return "";

  // Public control-buffer callers sometimes request tiny test/debug tails for
  // which the notice itself cannot fit. Keep those code-point safe. Production
  // terminal replay limits are >= 1,000 chars and always take the explicit-gap
  // branch below.
  if (boundedMax < TERMINAL_OUTPUT_TRUNCATED_NOTICE.length) {
    return codePointSafeTail(value, boundedMax);
  }
  return terminalReplayTail(value, boundedMax);
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
  if (boundedMax === 0) return "";
  if (boundedMax < TERMINAL_OUTPUT_TRUNCATED_NOTICE.length) {
    // This only applies to deliberately tiny callers/tests. Avoid returning a
    // partial ANSI control sequence even when the full colored notice cannot
    // fit.
    return "[truncated]".slice(0, boundedMax);
  }
  return terminalReplayTail(combined, boundedMax);
}

/**
 * Return a bounded, self-declaring terminal replay tail.
 *
 * The cut is moved forward until the ANSI parser is back in ordinary text, so
 * replay never begins inside CSI/OSC/DCS/APC/PM/SOS. A terminal reset precedes
 * the tail because styles, cursor position and modes before the cut are not
 * reconstructable from text alone. The first UTF-16 code unit is also never a
 * dangling low surrogate.
 */
export function terminalReplayTail(value: string, maxChars: number): string {
  const boundedMax = Math.max(0, Math.floor(maxChars));
  if (value.length <= boundedMax) return value;
  if (boundedMax < TERMINAL_OUTPUT_TRUNCATED_NOTICE.length) {
    return codePointSafeTail(value, boundedMax);
  }

  const availableChars = boundedMax - TERMINAL_OUTPUT_TRUNCATED_NOTICE.length;
  const minimumStart = Math.max(0, value.length - availableChars);
  const safeStart = firstSafeTerminalBoundaryAtOrAfter(value, minimumStart);
  if (safeStart == null) return TERMINAL_OUTPUT_TRUNCATED_NOTICE;
  return `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${value.slice(safeStart)}`;
}

function codePointSafeTail(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  let start = Math.max(0, value.length - maxChars);
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

type AnsiParserState = "text" | "escape" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape";

function firstSafeTerminalBoundaryAtOrAfter(value: string, minimumStart: number): number | null {
  let state: AnsiParserState = "text";
  for (let index = 0; index <= value.length; index += 1) {
    if (
      index >= minimumStart
      && state === "text"
      && isCodePointBoundary(value, index)
    ) {
      return index;
    }
    if (index === value.length) break;

    state = advanceAnsiParserState(state, value[index], value.charCodeAt(index));
  }
  return null;
}

function advanceAnsiParserState(state: AnsiParserState, char: string, code: number): AnsiParserState {
  if (state === "text") {
    if (code === 0x1b) return "escape";
    if (code === 0x9b) return "csi";
    if (code === 0x9d) return "osc";
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return "string";
    return "text";
  }
  if (state === "escape") {
    if (char === "[") return "csi";
    if (char === "]") return "osc";
    if (char === "P" || char === "X" || char === "^" || char === "_") return "string";
    return "text";
  }
  if (state === "csi") return code >= 0x40 && code <= 0x7e ? "text" : "csi";
  if (state === "osc") {
    if (code === 0x07 || code === 0x9c) return "text";
    return code === 0x1b ? "oscEscape" : "osc";
  }
  if (state === "oscEscape") return char === "\\" ? "text" : (code === 0x1b ? "oscEscape" : "osc");
  if (state === "string") {
    if (code === 0x9c) return "text";
    return code === 0x1b ? "stringEscape" : "string";
  }
  return char === "\\" ? "text" : (code === 0x1b ? "stringEscape" : "string");
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isCodePointBoundary(value: string, index: number): boolean {
  if (index < value.length && isLowSurrogate(value.charCodeAt(index))) return false;
  if (index === value.length && index > 0 && isHighSurrogate(value.charCodeAt(index - 1))) return false;
  return true;
}
