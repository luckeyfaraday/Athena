import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTerminalAttention,
  mergeWorkspaceAttention,
} from "../src/workspace-attention.ts";

test("classifies approval prompts as action attention", () => {
  assert.equal(classifyTerminalAttention("Waiting for approval to run command"), "action");
  assert.equal(classifyTerminalAttention("Permission required. Press enter to continue"), "action");
});

test("classifies task completion as update attention", () => {
  assert.equal(classifyTerminalAttention("Task complete. Ready for review."), "update");
  assert.equal(classifyTerminalAttention("Opened PR #57"), "update");
});

test("ignores ordinary output", () => {
  assert.equal(classifyTerminalAttention("transforming modules..."), null);
});

test("merge preserves action priority and caps count", () => {
  assert.deepEqual(mergeWorkspaceAttention(undefined, "update"), { kind: "update", count: 1 });
  assert.deepEqual(mergeWorkspaceAttention({ kind: "update", count: 8 }, "action"), { kind: "action", count: 9 });
  assert.deepEqual(mergeWorkspaceAttention({ kind: "action", count: 9 }, "update"), { kind: "action", count: 9 });
});
