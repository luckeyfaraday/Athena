import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_PROMPT_SUBMIT_DELAY_MS,
  promptWritesForKind,
  writePromptSequence,
} from "../src/chat-mode.ts";

test("all agent prompts use bracketed paste followed by a separate enter", () => {
  for (const kind of ["codex", "claude", "opencode", "athena", "hermes", "grok"]) {
    assert.deepEqual(promptWritesForKind(kind, "review the diff\nkeep the formatting"), ["\x1b[200~review the diff\nkeep the formatting\x1b[201~", "\r"]);
  }
});

test("shell prompts submit with a trailing carriage return", () => {
  assert.deepEqual(promptWritesForKind("shell", "status"), ["status\r"]);
});

test("prompt write sequence preserves codex delay before enter", async () => {
  const writes = [];
  const delays = [];
  await writePromptSequence(
    "codex",
    "hello",
    async (data) => { writes.push(data); },
    async (ms) => { delays.push(ms); },
  );

  assert.deepEqual(writes, ["\x1b[200~hello\x1b[201~", "\r"]);
  assert.deepEqual(delays, [CODEX_PROMPT_SUBMIT_DELAY_MS]);
});

test("failed writes propagate and never submit a partial message", async () => {
  const writes = [];
  await assert.rejects(writePromptSequence("claude", "hello", async (data) => {
    writes.push(data);
    throw new Error("PTY disconnected");
  }, async () => {}), /PTY disconnected/);
  assert.equal(writes.length, 1);
});
