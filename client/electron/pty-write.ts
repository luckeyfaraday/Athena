// On Windows the PTY child runs behind ConPTY (conhost), whose console input
// buffer is bounded. A single large write to the `conin` pipe overflows that
// buffer and conhost silently drops the overflow, truncating injected prompts.
// There is no error and no backpressure surfaced to us. Feeding the write in
// small chunks with a short pause between them lets conhost drain the buffer
// between reads — the same mitigation xterm.js/VS Code use for Windows paste.
// Unix PTYs write to a real tty master with proper flow control and don't need
// this, so chunking is only applied on win32.

/** Maximum UTF-16 code units per chunk fed to ConPTY's input pipe. */
export const PTY_WRITE_CHUNK_SIZE = 512;

/** Pause between chunks so conhost can drain its bounded console input buffer. */
export const PTY_WRITE_CHUNK_DELAY_MS = 8;

/**
 * Split `data` into chunks of at most `size` UTF-16 code units without ever
 * splitting a surrogate pair across a boundary. Keeping pairs intact means each
 * chunk re-encodes to valid UTF-8, and because byte order is preserved across
 * reads, ConPTY's stateful VT parser reassembles escape sequences and
 * bracketed-paste markers exactly as if they had arrived in one write.
 */
export function chunkPtyWrite(data: string, size: number = PTY_WRITE_CHUNK_SIZE): string[] {
  if (size <= 0) throw new Error(`PTY write chunk size must be positive, got ${size}`);
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + size, data.length);
    // Don't end a chunk on a lone high surrogate; defer it to the next chunk so
    // the pair stays together. Guard against a 1-unit chunk so we always make
    // progress (a size of 1 would otherwise loop forever on a surrogate pair).
    if (end < data.length && end - start > 1) {
      const code = data.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}
