import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentContextPrompt,
  resolveAgentContextMode,
} from "../dist-electron/agent-context.js";

test("manual agent launches include only Athena tool routing", () => {
  assert.equal(resolveAgentContextMode(undefined), "none");
  const prompt = buildAgentContextPrompt({
    workspace: "/repo",
    agentLabel: "Codex",
  });

  assert.match(prompt, /^# Athena Tools/);
  assert.match(prompt, /context_workspace_ask_hermes/);
  assert.match(prompt, /CONTEXT_WORKSPACE_BACKEND_URL/);
  assert.match(prompt, /Wait for the user's next instruction/);
  assert.doesNotMatch(prompt, /Recall cache path/);
  assert.doesNotMatch(prompt, /## Memory/);
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

test("curated mode includes the selected context", () => {
  const prompt = buildAgentContextPrompt({
    mode: "curated",
    workspace: "/repo",
    agentLabel: "OpenCode",
    task: "Review auth",
    contextText: "Relevant prior decision only.",
  });

  assert.match(prompt, /Task: Review auth/);
  assert.match(prompt, /## Curated Context/);
  assert.match(prompt, /Relevant prior decision only/);
});

test("curated mode can launch directly from handoff context without a separate task", () => {
  const prompt = buildAgentContextPrompt({
    mode: "curated",
    workspace: "/repo",
    agentLabel: "Codex",
    contextText: "# Athena Session Handoff\n\n- Continue the verified implementation.",
  });

  assert.match(prompt, /^# Athena Task/);
  assert.match(prompt, /## Curated Context/);
  assert.match(prompt, /Athena Session Handoff/);
  assert.doesNotMatch(prompt, /Task:/);
});

test("immersive mode points at an immutable context bundle", () => {
  const prompt = buildAgentContextPrompt({
    mode: "immersive",
    workspace: "/repo",
    agentLabel: "Codex",
    task: "Investigate auth",
    bundleId: "ctx_123",
    contextPath: "/repo/.context-workspace/context/ctx_123/context.md",
  });

  assert.match(prompt, /^# Athena Immersive Launch/);
  assert.match(prompt, /Context bundle: ctx_123/);
  assert.match(prompt, /Read the context file before making decisions/);
  assert.doesNotMatch(prompt, /## Curated Context/);
});
