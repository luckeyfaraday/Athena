import assert from "node:assert/strict";
import test from "node:test";

import {
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
