import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_OUTPUT_TRUNCATED_NOTICE,
  appendBoundedTerminalOutput,
  boundedTerminalBufferMaxChars,
  formatTerminalBuffer,
  terminalBufferTail,
} from "../dist-electron/terminal-buffer.js";

test("terminal buffer max chars uses default and clamps bounds", () => {
  assert.equal(boundedTerminalBufferMaxChars(null), 40_000);
  assert.equal(boundedTerminalBufferMaxChars("not-a-number"), 40_000);
  assert.equal(boundedTerminalBufferMaxChars("10"), 1_000);
  assert.equal(boundedTerminalBufferMaxChars("250000"), 200_000);
  assert.equal(boundedTerminalBufferMaxChars("1234.9"), 1_234);
});

test("terminal buffer tail keeps the end of long output", () => {
  assert.equal(terminalBufferTail("abcdef", 10), "abcdef");
  assert.equal(terminalBufferTail("abcdef", 3), "def");
});

test("format terminal buffer reports returned char count and limit", () => {
  assert.deepEqual(formatTerminalBuffer("abcdef", 4), {
    buffer: "cdef",
    chars: 4,
    max_chars: 4,
  });
});

test("pending terminal output is capped to the newest text", () => {
  const maxChars = TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 4;
  const output = "abcdefghij".repeat(10);
  const capped = appendBoundedTerminalOutput("", output, maxChars);

  assert.equal(capped.length, maxChars);
  assert.equal(capped, `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${output.slice(-4)}`);
});

test("pending terminal output handles caps smaller than the truncation notice", () => {
  const capped = appendBoundedTerminalOutput("abc", "defghi", 8);

  assert.equal(capped.length, 8);
  assert.equal(capped, TERMINAL_OUTPUT_TRUNCATED_NOTICE.slice(0, 8));
});

test("pending terminal output uses the default cap", () => {
  const capped = appendBoundedTerminalOutput("", "x".repeat(DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS + 1));

  assert.equal(capped.length, DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS);
  assert.equal(capped.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
});
