import assert from "node:assert/strict";
import test from "node:test";

import {
  INPUT_SUBMIT_DELAY_MS,
  terminalInputWritesForKind,
} from "../dist-electron/input-sequencing.js";

const PASTE_SUBMIT_KINDS = ["codex", "claude", "opencode", "athena", "hermes"];

test("agent TUI injection uses bracketed paste before submit", () => {
  for (const kind of PASTE_SUBMIT_KINDS) {
    assert.deepEqual(terminalInputWritesForKind(kind, "review the diff"), [
      { data: "\x1b[200~review the diff\x1b[201~", delayAfterMs: INPUT_SUBMIT_DELAY_MS },
      { data: "\r" },
    ]);
  }
});

test("agent TUI injection strips caller-provided submit newlines", () => {
  for (const kind of PASTE_SUBMIT_KINDS) {
    assert.deepEqual(terminalInputWritesForKind(kind, "review the diff\r\n"), [
      { data: "\x1b[200~review the diff\x1b[201~", delayAfterMs: INPUT_SUBMIT_DELAY_MS },
      { data: "\r" },
    ]);
  }
});

test("agent TUI injection keeps a multi-line body intact inside the paste", () => {
  const body = "[athena-msg id=1]\nMessage:\nline one\nline two";
  for (const kind of PASTE_SUBMIT_KINDS) {
    assert.deepEqual(terminalInputWritesForKind(kind, body), [
      { data: `\x1b[200~${body}\x1b[201~`, delayAfterMs: INPUT_SUBMIT_DELAY_MS },
      { data: "\r" },
    ]);
  }
});

test("agent TUI injection can submit an existing prompt", () => {
  for (const kind of PASTE_SUBMIT_KINDS) {
    assert.deepEqual(terminalInputWritesForKind(kind, "\r"), [{ data: "\r" }]);
  }
});

test("shell injection submits input with Enter in a single write", () => {
  assert.deepEqual(terminalInputWritesForKind("shell", "status\r"), [{ data: "status\r" }]);
});

test("shell injection adds submit when caller omits it", () => {
  assert.deepEqual(terminalInputWritesForKind("shell", "status"), [{ data: "status\r" }]);
});

test("shell injection of a bare submit stays a single Enter", () => {
  assert.deepEqual(terminalInputWritesForKind("shell", "\r"), [{ data: "\r" }]);
});
