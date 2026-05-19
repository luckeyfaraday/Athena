import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_INPUT_SUBMIT_DELAY_MS,
  terminalInputWritesForKind,
} from "../dist-electron/input-sequencing.js";

test("codex control injection uses bracketed paste before submit", () => {
  assert.deepEqual(terminalInputWritesForKind("codex", "review the diff"), [
    { data: "\x1b[200~review the diff\x1b[201~", delayAfterMs: CODEX_INPUT_SUBMIT_DELAY_MS },
    { data: "\r" },
  ]);
});

test("codex control injection strips caller-provided submit newlines", () => {
  assert.deepEqual(terminalInputWritesForKind("codex", "review the diff\r\n"), [
    { data: "\x1b[200~review the diff\x1b[201~", delayAfterMs: CODEX_INPUT_SUBMIT_DELAY_MS },
    { data: "\r" },
  ]);
});

test("codex control injection can submit an existing prompt", () => {
  assert.deepEqual(terminalInputWritesForKind("codex", "\r"), [{ data: "\r" }]);
});

test("non-codex control injection submits input with Enter", () => {
  for (const kind of ["shell", "hermes", "opencode", "claude"]) {
    assert.deepEqual(terminalInputWritesForKind(kind, "status\r"), [{ data: "status\r" }]);
  }
});

test("non-codex control injection adds submit when caller omits it", () => {
  for (const kind of ["shell", "hermes", "opencode", "claude"]) {
    assert.deepEqual(terminalInputWritesForKind(kind, "status"), [{ data: "status\r" }]);
  }
});
