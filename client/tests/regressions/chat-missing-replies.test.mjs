// Missing chat replies incident: the UI must use the same submit protocol as
// terminal injection, and a startup box must never hide the rest of a session.
import assert from "node:assert/strict";
import test from "node:test";
import { writePromptSequence } from "../../src/chat-mode.ts";
import { terminalInputWritesForKind } from "../../dist-electron/input-sequencing.js";
import { ChatTranscriptParser } from "../../src/chat-parse.ts";

test("missing replies: chat and terminal injection agree for every agent", async () => {
  for (const kind of ["codex", "claude", "opencode", "athena", "hermes", "grok"]) {
    const writes = [];
    await writePromptSequence(kind, "first line\nsecond line", async (data) => { writes.push(data); }, async () => {});
    assert.deepEqual(writes, terminalInputWritesForKind(kind, "first line\nsecond line").map((step) => step.data));
  }
});

test("missing replies: a closed startup box and short answer remain readable", () => {
  const parser = new ChatTranscriptParser();
  parser.append("╭────────────╮\r\n│ Agent │\r\n╰────────────╯\r\n42\r\n");
  assert.match(parser.view([], "Agent").map((block) => block.text).join("\n"), /42/);
});
