// Shaping helpers for terminal buffer/stream responses on the control server.
// Kept free of any `electron` import so it can be unit tested in plain Node.

export const DEFAULT_TERMINAL_BUFFER_MAX_CHARS = 40_000;
export const MIN_TERMINAL_BUFFER_MAX_CHARS = 1_000;
export const MAX_TERMINAL_BUFFER_MAX_CHARS = 200_000;
// Size of one PTY host -> main output batch. Batches are flushed early when the
// next chunk would exceed this; output is never truncated to fit it.
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

// VT parser states. Numeric so the hot scan loop compares small integers.
const TEXT = 0;
const ESCAPE = 1;
const CSI = 2;
const OSC = 3;
const OSC_ESCAPE = 4;
const STRING = 5;
const STRING_ESCAPE = 6;
const UNKNOWN_STATE = -1;
type AnsiParserState = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type TerminalReplayChunk = {
  data: string;
  // Parser state at the first code unit of `data`, or UNKNOWN_STATE until a
  // trim/replay actually needs it. chunks[0] always has a known state.
  startState: AnsiParserState | typeof UNKNOWN_STATE;
};

const TERMINAL_REPLAY_CHUNK_TARGET_CHARS = 4_096;

/**
 * Chunked rolling replay storage. Appends are O(1) and do not parse the VT
 * stream: parser state is computed lazily, only for the regions a trim or a
 * bounded replay actually cuts into, and memoized per chunk so every code unit
 * is scanned at most once as it moves through the buffer. Terminals whose
 * output never reaches the retention budget therefore pay no parsing cost.
 * When the budget rolls over, the first retained code unit is moved to a VT
 * parser-safe boundary and the returned replay declares the gap/reset.
 */
export class BoundedTerminalReplayBuffer {
  private readonly chunks: TerminalReplayChunk[] = [];
  private chars = 0;
  private truncated = false;
  // Stream parser state at the next appended code unit when every chunk has
  // been trimmed away (e.g. an unterminated OSC string consumed the budget).
  private stateWhenEmpty: AnsiParserState = TEXT;

  constructor(private readonly maxChars: number) {}

  append(data: string): number {
    if (!data) return 0;
    const lastChunk = this.chunks.length > 0 ? this.chunks[this.chunks.length - 1] : null;
    if (lastChunk && lastChunk.data.length + data.length <= TERMINAL_REPLAY_CHUNK_TARGET_CHARS) {
      lastChunk.data += data;
    } else {
      this.chunks.push({
        data,
        startState: this.chunks.length === 0 ? this.stateWhenEmpty : UNKNOWN_STATE,
      });
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
   * Materialize a bounded replay starting at the first VT/code-point safe
   * boundary inside the budget. Equivalent to terminalReplayTail(value()) but
   * only scans from the chunk containing the cut, never the discarded prefix,
   * so mounting a 64 KiB view stays proportional to the replay it will parse.
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
    let chunkIndex = 0;
    for (; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunkEnd = consumed + this.chunks[chunkIndex].data.length;
      if (chunkEnd >= minimumStart) break;
      consumed = chunkEnd;
    }
    if (chunkIndex >= this.chunks.length) return TERMINAL_OUTPUT_TRUNCATED_NOTICE;

    let state = this.startStateOf(chunkIndex);
    let localMinimum = minimumStart - consumed;
    for (; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex];
      const safeOffset = firstSafeOffset(chunk.data, state, localMinimum);
      if (safeOffset >= 0) {
        const parts = [chunk.data.slice(safeOffset)];
        for (let tailIndex = chunkIndex + 1; tailIndex < this.chunks.length; tailIndex += 1) {
          parts.push(this.chunks[tailIndex].data);
        }
        return `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${parts.join("")}`;
      }
      state = lastScanEndState;
      const next = this.chunks[chunkIndex + 1];
      if (next && next.startState === UNKNOWN_STATE) next.startState = state;
      localMinimum = 0;
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

  /** Resolve (and memoize) the parser state at the start of chunks[index]. */
  private startStateOf(index: number): AnsiParserState {
    let known = index;
    while (known > 0 && this.chunks[known].startState === UNKNOWN_STATE) known -= 1;
    let state = this.chunks[known].startState as AnsiParserState;
    for (let cursor = known; cursor < index; cursor += 1) {
      const data = this.chunks[cursor].data;
      state = scanAnsiParserState(data, state, 0, data.length);
      this.chunks[cursor + 1].startState = state;
    }
    return state;
  }

  private trimToBudget(payloadBudget: number): void {
    let toDrop = Math.max(0, this.chars - payloadBudget);
    while (this.chunks.length > 0 && toDrop >= this.chunks[0].data.length) {
      toDrop -= this.chunks[0].data.length;
      this.dropFirstChunk(null);
    }

    // Cut the first retained chunk at its first safe boundary at/after the
    // budget. If the cut lands inside a control string that runs to the end of
    // the chunk, discard the chunk and continue at the next chunk's first safe
    // boundary, so a replay never begins mid-sequence.
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const safeOffset = firstSafeOffset(chunk.data, chunk.startState as AnsiParserState, toDrop);
      if (safeOffset >= 0) {
        if (safeOffset > 0) {
          chunk.data = chunk.data.slice(safeOffset);
          this.chars -= safeOffset;
        }
        chunk.startState = TEXT;
        return;
      }
      this.dropFirstChunk(lastScanEndState);
      toDrop = 0;
    }
  }

  private dropFirstChunk(knownEndState: AnsiParserState | null): void {
    const chunk = this.chunks.shift();
    if (!chunk) return;
    this.chars -= chunk.data.length;
    const next = this.chunks[0];
    if (next && next.startState !== UNKNOWN_STATE) return;
    const endState = knownEndState
      ?? scanAnsiParserState(chunk.data, chunk.startState as AnsiParserState, 0, chunk.data.length);
    if (next) next.startState = endState;
    else this.stateWhenEmpty = endState;
  }
}

/**
 * Coalesces PTY output into bounded batches without ever discarding output.
 * A pending batch is emitted early as soon as the next chunk would push it past
 * `maxBatchChars`; a single oversized chunk is split at UTF-16 code point
 * boundaries. Replaces the old truncate-and-reset batching, which dropped the
 * head of any 16ms window that exceeded the cap and injected a terminal reset.
 */
export class TerminalOutputBatcher {
  private readonly pending = new Map<string, string>();
  private readonly maxBatchChars: number;

  constructor(
    private readonly emit: (id: string, data: string) => void,
    maxBatchChars: number = DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  ) {
    this.maxBatchChars = Math.max(2, Math.floor(maxBatchChars));
  }

  /** Buffer output; returns true while output remains pending a timed flush. */
  push(id: string, data: string): boolean {
    if (!data) return this.pending.has(id);
    const max = this.maxBatchChars;
    const existing = this.pending.get(id);
    if (existing !== undefined) {
      if (existing.length + data.length < max) {
        this.pending.set(id, existing + data);
        return true;
      }
      if (existing.length + data.length === max) {
        this.pending.delete(id);
        this.emit(id, existing + data);
        return false;
      }
      // Flush what we have before it would overflow; never truncate.
      this.pending.delete(id);
      this.emit(id, existing);
    }
    let offset = 0;
    while (data.length - offset >= max) {
      let end = offset + max;
      if (
        end < data.length
        && isHighSurrogate(data.charCodeAt(end - 1))
        && isLowSurrogate(data.charCodeAt(end))
      ) {
        end -= 1;
      }
      this.emit(id, data.slice(offset, end));
      offset = end;
    }
    if (offset >= data.length) return false;
    this.pending.set(id, offset === 0 ? data : data.slice(offset));
    return true;
  }

  flush(id: string): void {
    const data = this.pending.get(id);
    if (data === undefined) return;
    this.pending.delete(id);
    if (data) this.emit(id, data);
  }

  flushAll(): void {
    for (const id of Array.from(this.pending.keys())) this.flush(id);
  }

  clear(): void {
    this.pending.clear();
  }
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
  const safeStart = firstSafeOffset(value, TEXT, minimumStart);
  if (safeStart < 0) return TERMINAL_OUTPUT_TRUNCATED_NOTICE;
  return `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${value.slice(safeStart)}`;
}

function codePointSafeTail(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  let start = Math.max(0, value.length - maxChars);
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

// End state of the most recent unsuccessful firstSafeOffset() scan. A module
// scratch value keeps the scan allocation-free; callers read it immediately.
let lastScanEndState: AnsiParserState = TEXT;

/**
 * First index >= minimum where the parser is in ordinary text and the index is
 * not the second half of a surrogate pair, scanning `data` from `startState`.
 * Returns -1 when no such index exists before the end of `data`, leaving the
 * end-of-data parser state in lastScanEndState.
 */
function firstSafeOffset(data: string, startState: AnsiParserState, minimum: number): number {
  const length = data.length;
  let index = Math.max(0, minimum);
  let state = index > 0
    ? scanAnsiParserState(data, startState, 0, Math.min(index, length))
    : startState;
  while (index < length) {
    const code = data.charCodeAt(index);
    if (state === TEXT && !isLowSurrogate(code)) return index;
    state = advanceAnsiParserState(state, code);
    index += 1;
  }
  lastScanEndState = state;
  return -1;
}

/** Parser state after consuming data[start, end) from `state`. */
function scanAnsiParserState(data: string, state: AnsiParserState, start: number, end: number): AnsiParserState {
  let index = start;
  while (index < end) {
    let code = data.charCodeAt(index);
    if (state === TEXT) {
      // Fast path: ordinary text cannot change state until an ESC or a C1
      // introducer, so skip it without per-character transitions.
      while (code !== 0x1b && (code < 0x90 || code > 0x9f)) {
        index += 1;
        if (index >= end) return TEXT;
        code = data.charCodeAt(index);
      }
    }
    state = advanceAnsiParserState(state, code);
    index += 1;
  }
  return state;
}

function advanceAnsiParserState(state: AnsiParserState, code: number): AnsiParserState {
  switch (state) {
    case TEXT:
      if (code === 0x1b) return ESCAPE;
      if (code === 0x9b) return CSI;
      if (code === 0x9d) return OSC;
      if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return STRING;
      return TEXT;
    case ESCAPE:
      if (code === 0x5b /* [ */) return CSI;
      if (code === 0x5d /* ] */) return OSC;
      if (code === 0x50 /* P */ || code === 0x58 /* X */ || code === 0x5e /* ^ */ || code === 0x5f /* _ */) {
        return STRING;
      }
      return TEXT;
    case CSI:
      return code >= 0x40 && code <= 0x7e ? TEXT : CSI;
    case OSC:
      if (code === 0x07 || code === 0x9c) return TEXT;
      return code === 0x1b ? OSC_ESCAPE : OSC;
    case OSC_ESCAPE:
      if (code === 0x5c /* \ */) return TEXT;
      return code === 0x1b ? OSC_ESCAPE : OSC;
    case STRING:
      if (code === 0x9c) return TEXT;
      return code === 0x1b ? STRING_ESCAPE : STRING;
    default:
      if (code === 0x5c /* \ */) return TEXT;
      return code === 0x1b ? STRING_ESCAPE : STRING;
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
