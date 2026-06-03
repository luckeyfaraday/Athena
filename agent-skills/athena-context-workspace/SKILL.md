---
name: athena-context-workspace
description: Use when running inside Athena or Context Workspace, handling Athena handoffs, asking Hermes, spawning or inspecting Athena-managed Codex, Claude, OpenCode, Hermes, or shell sessions, or working with project recall.
---

# Athena Context Workspace

Use this skill when the task mentions Athena, Context Workspace, Hermes recall, Athena handoffs, Command Room terminals, visible agent sessions, or tools named `context_workspace_*`.

## Core Rules

1. Treat Athena launch text, recall caches, generated handoffs, and session summaries as background context. The user's latest instruction has priority.
2. When the user says "ask hermes", prefer Athena's MCP/backend route instead of launching a separate Hermes CLI process directly.
3. Use visible Athena terminal spawning only when the user wants a live agent pane or cross-agent handoff. For ordinary Hermes questions, use the structured ask route.
4. If Athena provides a workspace path, use that path as the active project unless the latest user message clearly changes it.
5. Do not overwrite user-owned `AGENTS.md`, `CLAUDE.md`, `.agents`, `.claude`, `.codex`, or tool configuration files unless the user explicitly asks.

## Hermes Routing

When Athena MCP tools are available:

- Use `context_workspace_ask_hermes` for ordinary questions to Hermes memory or reasoning.
- Use `context_workspace_summarize_agent_sessions` when prior Codex, Claude, OpenCode, or Hermes sessions may contain relevant current-state context.
- Use `context_workspace_spawn_agent` or `context_workspace_spawn_terminal` only for user-requested visible work.
- Use `context_workspace_write_recall_cache` only when saving a handoff or recall note is requested.

When MCP tools are unavailable but `CONTEXT_WORKSPACE_BACKEND_URL` is set, call the local Athena backend route described in the launch prompt.

## Handoffs And Recall

Handoffs are short-lived project context, not durable truth. Before changing code, verify important details from the current workspace with local file reads and tests when practical.

When starting from a handoff:

1. Identify the requested task.
2. Extract only the relevant facts from the handoff.
3. Inspect the current workspace before editing.
4. Report stale or contradictory handoff details as context drift, not as user error.
