import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRawTerminalInputRequest,
  rawInputPreview,
} from "../dist-electron/terminal-input.js";

test("raw terminal input preserves meaningful bytes", () => {
  assert.deepEqual(parseRawTerminalInputRequest({ target: "term-1", data: " " }), {
    target: "term-1",
    data: " ",
  });
  assert.deepEqual(parseRawTerminalInputRequest({ terminal_id: "term-1", data: "\r" }), {
    target: "term-1",
    data: "\r",
  });
  assert.deepEqual(parseRawTerminalInputRequest({ sessionId: "term-1", data: "\x1b[A" }), {
    target: "term-1",
    data: "\x1b[A",
  });
  assert.deepEqual(parseRawTerminalInputRequest({ target: "term-1", data: "text \n\t" }), {
    target: "term-1",
    data: "text \n\t",
  });
});

test("raw terminal input rejects missing target or empty data", () => {
  assert.throws(() => parseRawTerminalInputRequest({ data: "x" }), /terminal_id, session_id, or target is required/);
  assert.throws(() => parseRawTerminalInputRequest({ target: "term-1", data: "" }), /data is required/);
});

test("raw terminal input diagnostics redact content and report byte count", () => {
  const preview = rawInputPreview("secret\n");
  assert.equal(preview, "<raw PTY input: 7 bytes>");
  assert.equal(preview.includes("secret"), false);
  assert.equal(rawInputPreview("🔒"), "<raw PTY input: 4 bytes>");
});
