import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_IDLE_SETTLE_MS,
  TERMINAL_INPUT_TIMEOUT_MS,
  clearTerminalActivity,
  isTerminalActive,
  recordTerminalInputActivity,
  recordTerminalOutputActivity,
  resetTerminalActivityForTests,
} from "../dist-electron/terminal-activity.js";

test.beforeEach(() => resetTerminalActivityForTests());

test("input keeps a terminal busy while waiting for the first output", () => {
  recordTerminalInputActivity("term-1", 1_000);

  assert.equal(isTerminalActive("term-1", 1_000 + TERMINAL_INPUT_TIMEOUT_MS - 1), true);
  assert.equal(isTerminalActive("term-1", 1_000 + TERMINAL_INPUT_TIMEOUT_MS), false);
});

test("output keeps a terminal busy until the stream settles", () => {
  recordTerminalInputActivity("term-1", 1_000);
  recordTerminalOutputActivity("term-1", 2_000);

  assert.equal(isTerminalActive("term-1", 2_000 + TERMINAL_IDLE_SETTLE_MS - 1), true);
  assert.equal(isTerminalActive("term-1", 2_000 + TERMINAL_IDLE_SETTLE_MS), false);
});

test("later output extends the idle settle window", () => {
  recordTerminalOutputActivity("term-1", 2_000);
  recordTerminalOutputActivity("term-1", 4_000);

  assert.equal(isTerminalActive("term-1", 4_000 + TERMINAL_IDLE_SETTLE_MS - 1), true);
  assert.equal(isTerminalActive("term-1", 4_000 + TERMINAL_IDLE_SETTLE_MS), false);
});

test("clearing terminal activity removes stale busy state", () => {
  recordTerminalInputActivity("term-1", 1_000);
  clearTerminalActivity("term-1");

  assert.equal(isTerminalActive("term-1", 1_001), false);
});
