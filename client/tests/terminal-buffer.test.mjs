import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedTerminalReplayBuffer,
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_OUTPUT_TRUNCATED_NOTICE,
  TerminalOutputBatcher,
  boundedTerminalBufferMaxChars,
  formatTerminalBuffer,
  terminalBufferTail,
  terminalReplayTail,
} from "../dist-electron/terminal-buffer.js";
import {
  TERMINAL_ATTENTION_SCAN_MAX_CHARS,
  createTerminalScanState,
  matchAttentionPrompt,
  scanTerminalOutput,
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

function collectBatches(maxChars) {
  const batches = [];
  const batcher = new TerminalOutputBatcher((id, data) => batches.push({ id, data }), maxChars);
  return { batcher, batches };
}

test("PTY output bursts just over the batch cap flush early instead of truncating", () => {
  const { batcher, batches } = collectBatches(DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS);
  const first = "a".repeat(40_000);
  const second = "b".repeat(24_001); // one 16ms window totals cap + 1
  assert.equal(batcher.push("t", first), true);
  assert.equal(batcher.push("t", second), true);
  assert.deepEqual(batches.map((batch) => batch.data.length), [40_000], "pending batch flushed before overflow");
  batcher.flushAll();
  assert.deepEqual(batches.map((batch) => batch.data), [first, second]);
  assert.equal(batches.some((batch) => batch.data.includes(TERMINAL_OUTPUT_TRUNCATED_NOTICE)), false);
});

test("small PTY chunks coalesce up to exactly the cap and never exceed it", () => {
  const { batcher, batches } = collectBatches(64_000);
  const chunks = Array.from({ length: 65 }, (_, index) => String(index % 10).repeat(1_000));
  for (const chunk of chunks) batcher.push("t", chunk);
  batcher.flushAll();
  assert.deepEqual(batches.map((batch) => batch.data.length), [64_000, 1_000]);
  assert.equal(batches.map((batch) => batch.data).join(""), chunks.join(""));
});

test("an oversized PTY chunk is split at code point boundaries without loss", () => {
  const { batcher, batches } = collectBatches(10);
  const data = `${"x".repeat(9)}😀${"y".repeat(15)}\x1b[31mred\x1b[0m`;
  assert.equal(batcher.push("t", data), true);
  batcher.flushAll();
  assert.equal(batches.map((batch) => batch.data).join(""), data);
  for (const { data: batch } of batches) {
    assert.ok(batch.length <= 10);
    assert.equal(batch.charCodeAt(0) >= 0xdc00 && batch.charCodeAt(0) <= 0xdfff, false, "no dangling low surrogate");
  }
});

test("PTY output batches stay per-terminal and flush independently", () => {
  const { batcher, batches } = collectBatches(100);
  batcher.push("one", "first");
  batcher.push("two", "second");
  batcher.flush("one");
  assert.deepEqual(batches, [{ id: "one", data: "first" }]);
  batcher.flushAll();
  assert.deepEqual(batches, [{ id: "one", data: "first" }, { id: "two", data: "second" }]);
  batcher.flushAll();
  assert.equal(batches.length, 2, "flushing an empty batcher emits nothing");
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

// Independent oracle: the original per-character VT scanner over the whole
// stream. The replay buffer computes parser state lazily per chunk and must
// cut at exactly the same boundaries.
function oracleAdvance(state, char, code) {
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

function oracleFirstSafe(stream, minimum) {
  let state = "text";
  for (let index = 0; index < stream.length; index += 1) {
    const code = stream.charCodeAt(index);
    if (index >= minimum && state === "text" && !(code >= 0xdc00 && code <= 0xdfff)) return index;
    state = oracleAdvance(state, stream[index], code);
  }
  return stream.length;
}

function oracleRetained(appends, maxChars) {
  const payloadBudget = maxChars - TERMINAL_OUTPUT_TRUNCATED_NOTICE.length;
  let stream = "";
  let start = 0;
  let truncated = false;
  for (const data of appends) {
    stream += data;
    if (stream.length - start <= maxChars && !truncated) continue;
    truncated = true;
    start = oracleFirstSafe(stream, Math.max(start, stream.length - payloadBudget));
  }
  return truncated ? `${TERMINAL_OUTPUT_TRUNCATED_NOTICE}${stream.slice(start)}` : stream;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 2 ** 32;
  };
}

const FUZZ_FRAGMENTS = [
  "plain text ", "\r\n", "\x1b[31m", "\x1b[0m", "\x1b[38;2;10;20;30m", "\x1b]0;title\x07",
  "\x1b]8;;https://example.com\x1b\\", "\x1bP1;2|payload\x1b\\", "\x9b1;2H", "\x9dosc\x9c", "😀",
  "\ud83d", "\ude00", "\x1b", "[", "]", "\\", "\x07", "\x1b_apc", "x".repeat(700),
];

test("lazy VT-safe trimming and replay match a full-stream oracle on fuzzed output", () => {
  const random = seededRandom(0x5eed);
  for (let round = 0; round < 60; round += 1) {
    const maxChars = TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 200 + Math.floor(random() * 6_000);
    const buffer = new BoundedTerminalReplayBuffer(maxChars);
    const appends = [];
    const appendCount = 20 + Math.floor(random() * 200);
    for (let index = 0; index < appendCount; index += 1) {
      let data = "";
      const parts = 1 + Math.floor(random() * 12);
      for (let part = 0; part < parts; part += 1) {
        data += FUZZ_FRAGMENTS[Math.floor(random() * FUZZ_FRAGMENTS.length)];
      }
      appends.push(data);
      buffer.append(data);
    }
    const expected = oracleRetained(appends, maxChars);
    const retained = buffer.value();
    assert.equal(retained, expected, `round ${round}: retained value`);
    assert.ok(retained.length <= maxChars, `round ${round}: bounded`);
    for (const limit of [TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 20, 300, 1_000, 4_000]) {
      assert.equal(buffer.replay(limit), terminalReplayTail(retained, limit), `round ${round}: replay ${limit}`);
    }
  }
});

test("main-side attention scanning remains bounded to the newest 4k chars", () => {
  const scanned = (data) => scanTerminalOutput(createTerminalScanState(), data).text;
  const promptThenFlood = scanned(`Do you want to proceed? ${"x".repeat(TERMINAL_ATTENTION_SCAN_MAX_CHARS + 10)}`);
  assert.equal(promptThenFlood.length, TERMINAL_ATTENTION_SCAN_MAX_CHARS);
  assert.equal(matchAttentionPrompt(promptThenFlood), null);
  const floodThenPrompt = scanned(`${"x".repeat(TERMINAL_ATTENTION_SCAN_MAX_CHARS * 3)} Do you want to proceed?`);
  assert.equal(matchAttentionPrompt(floodThenPrompt)?.reason, "approval");
});
