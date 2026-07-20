import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedTerminalReplayBuffer,
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_OUTPUT_TRUNCATED_NOTICE,
  appendBoundedTerminalOutput,
  boundedTerminalBufferMaxChars,
  formatTerminalBuffer,
  terminalBufferTail,
  terminalReplayTail,
} from "../dist-electron/terminal-buffer.js";
import {
  TERMINAL_ATTENTION_SCAN_MAX_CHARS,
  classifyTerminalAttention,
} from "../dist-electron/terminal-attention.js";

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
  assert.equal(capped, "[truncat");
});

test("pending terminal output uses the default cap", () => {
  const capped = appendBoundedTerminalOutput("", "x".repeat(DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS + 1));

  assert.equal(capped.length, DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS);
  assert.equal(capped.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
});

test("replay truncation never starts on a dangling UTF-16 low surrogate", () => {
  const maxChars = TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 2;
  const capped = terminalReplayTail(`${"x".repeat(100)}😀Z`, maxChars);
  const tail = capped.slice(TERMINAL_OUTPUT_TRUNCATED_NOTICE.length);
  assert.equal(tail, "Z");
  assert.equal(tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff, false);
});

test("replay truncation advances past an OSC control string boundary", () => {
  const value = `${"x".repeat(100)}\x1b]0;unsafe-title\x07SAFE`;
  const capped = terminalReplayTail(value, TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 8);
  assert.equal(capped.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  assert.equal(capped.endsWith("SAFE"), true);
  assert.equal(capped.includes("unsafe-title"), false);
});

test("an unterminated control string is dropped instead of replayed mid-sequence", () => {
  const value = `${"x".repeat(100)}\x1b]0;${"y".repeat(100)}`;
  assert.equal(
    terminalReplayTail(value, TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 20),
    TERMINAL_OUTPUT_TRUNCATED_NOTICE,
  );
});

test("chunked replay storage stays bounded across fragmented ANSI and Unicode output", () => {
  const maxChars = TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 64;
  const replay = new BoundedTerminalReplayBuffer(maxChars);
  replay.append(`${"old\r\n".repeat(40)}\x1b]0;frag`);
  replay.append("mented-title\x07😀new\r\n");
  for (let index = 0; index < 100; index += 1) replay.append(`line-${index}\r\n`);
  const value = replay.value();
  assert.ok(value.length <= maxChars);
  assert.equal(value.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  const tail = value.slice(TERMINAL_OUTPUT_TRUNCATED_NOTICE.length);
  assert.equal(tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff, false);
  assert.equal(tail.includes("mented-title"), false);
  assert.equal(tail.endsWith("line-99\r\n"), true);
});

test("indexed replay matches VT-safe tail semantics without materializing the discarded prefix", () => {
  const replay = new BoundedTerminalReplayBuffer(200_000);
  const chunks = [
    "old\r\n".repeat(5_000),
    "\x1b]0;split-",
    "title\x07😀\x1b[31mRED\x1b[0m\r\n",
    "new\r\n".repeat(2_000),
  ];
  for (const chunk of chunks) replay.append(chunk);
  const raw = chunks.join("");
  for (const limit of [TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 20, 1_000, 64 * 1024]) {
    assert.equal(replay.replay(limit), terminalReplayTail(raw, limit));
  }
});

test("indexed replay preserves safe-tail semantics after authoritative retention truncates", () => {
  const replay = new BoundedTerminalReplayBuffer(2_000);
  for (let index = 0; index < 1_000; index += 1) replay.append(`row-${index}\r\n`);
  const retained = replay.value();
  assert.equal(retained.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  for (const limit of [500, 1_000]) {
    assert.equal(replay.replay(limit), terminalReplayTail(retained, limit));
  }
});

test("main-side attention classification remains bounded to the newest 4k chars", () => {
  assert.equal(classifyTerminalAttention("Waiting for approval to continue"), "action");
  assert.equal(classifyTerminalAttention("Task completed and ready for review"), "update");
  assert.equal(
    classifyTerminalAttention(`approval ${"x".repeat(TERMINAL_ATTENTION_SCAN_MAX_CHARS + 10)}`),
    null,
  );
});
