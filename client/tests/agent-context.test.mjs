import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentContextPrompt,
  resolveAgentContextMode,
} from "../dist-electron/agent-context.js";

test("manual agent launches default to no injected context", () => {
  assert.equal(resolveAgentContextMode(undefined), "none");
  assert.equal(buildAgentContextPrompt({
    workspace: "/repo",
    agentLabel: "Codex",
  }), null);
});

test("task mode builds a compact task-only prompt", () => {
  const prompt = buildAgentContextPrompt({
    mode: "task",
    workspace: "/repo",
    agentLabel: "Claude Code",
    title: "Claude Builder",
    task: "Fix the bug",
    contextText: "Should not appear in task mode",
  });

  assert.match(prompt, /^# Athena Task/);
  assert.match(prompt, /Workspace: \/repo/);
  assert.match(prompt, /Agent: Claude Code/);
  assert.match(prompt, /Pane: Claude Builder/);
  assert.match(prompt, /Task: Fix the bug/);
  assert.doesNotMatch(prompt, /Should not appear/);
  assert.doesNotMatch(prompt, /Recall cache path/);
  assert.doesNotMatch(prompt, /## Memory/);
});

test("curated mode includes only Hermes-selected context", () => {
  const prompt = buildAgentContextPrompt({
    mode: "curated",
    workspace: "/repo",
    agentLabel: "OpenCode",
    task: "Review auth",
    contextText: "Relevant prior decision only.",
  });

  assert.match(prompt, /Task: Review auth/);
  assert.match(prompt, /## Context selected by Hermes/);
  assert.match(prompt, /Relevant prior decision only/);
});
