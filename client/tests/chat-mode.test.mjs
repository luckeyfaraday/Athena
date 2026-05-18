import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_PROMPT_SUBMIT_DELAY_MS,
  promptWritesForKind,
  writePromptSequence,
} from "../src/chat-mode.ts";

test("codex prompts are written as text followed by a separate enter", () => {
  assert.deepEqual(promptWritesForKind("codex", "review the diff"), ["review the diff", "\r"]);
});

test("non-codex prompts submit with a trailing carriage return", () => {
  for (const kind of ["shell", "hermes", "opencode", "claude"]) {
    assert.deepEqual(promptWritesForKind(kind, "status"), ["status\r"]);
  }
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

  assert.deepEqual(writes, ["hello", "\r"]);
  assert.deepEqual(delays, [CODEX_PROMPT_SUBMIT_DELAY_MS]);
});
