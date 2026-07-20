import assert from "node:assert/strict";
import test from "node:test";

import { TerminalAttentionTracker, classifyTerminalAttention } from "../dist-electron/terminal-attention.js";

test("main-side attention classification replaces global raw renderer output", () => {
  assert.equal(classifyTerminalAttention("Waiting for approval to run command"), "action");
  assert.equal(classifyTerminalAttention("Task complete. Ready for review."), "update");
  assert.equal(classifyTerminalAttention("transforming modules...".repeat(4_000)), null);
});

test("attention classification carries only a bounded suffix across split PTY batches", () => {
  const tracker = new TerminalAttentionTracker();
  assert.equal(tracker.classify("one", "Waiting for appr"), null);
  assert.equal(tracker.classify("one", "oval to continue"), "action");
  tracker.clear("one");
  assert.equal(tracker.classify("one", "ordinary output"), null);
});
