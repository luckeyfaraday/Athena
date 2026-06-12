---
name: athena-context-workspace
description: Use when running inside Athena or Context Workspace, handling Athena handoffs, asking Hermes, messaging or pinging an already-running Claude, Codex, OpenCode, Athena Code, or Hermes pane, spawning or inspecting Athena-managed agent sessions, or working with project recall.
---

# Athena Context Workspace

Use this skill when the task mentions Athena, Context Workspace, Hermes recall, Athena handoffs, Command Room terminals, visible agent sessions, messaging an already-running agent pane, or tools named `context_workspace_*`.

## Core Rules

1. Treat Athena launch text, recall caches, generated handoffs, and session summaries as background context. The user's latest instruction has priority.
2. When the user says "ask hermes", prefer Athena's MCP/backend route instead of launching a separate Hermes CLI process directly.
3. Use visible Athena terminal spawning only when the user wants a live agent pane or cross-agent handoff. For ordinary Hermes questions, use the structured ask route.
4. If Athena provides a workspace path, use that path as the active project unless the latest user message clearly changes it.
5. Do not overwrite user-owned `AGENTS.md`, `CLAUDE.md`, `.agents`, `.claude`, `.codex`, or tool configuration files unless the user explicitly asks.

## Hermes Routing

When Athena MCP tools are available:

- Use `context_workspace_ask_hermes` for ordinary questions to Hermes memory or reasoning.
- Use `context_workspace_summarize_agent_sessions` when prior Codex, Claude, OpenCode, Athena Code, or Hermes sessions may contain relevant current-state context.
- Use `context_workspace_spawn_agent` or `context_workspace_spawn_terminal` only for user-requested visible work.
- Use `context_workspace_write_recall_cache` only when saving a handoff or recall note is requested.

When MCP tools are unavailable but `CONTEXT_WORKSPACE_BACKEND_URL` is set, call the local Athena backend route described in the launch prompt. That FastAPI backend serves Hermes, recall, memory, and historical session data only — live terminals are controlled by the separate Electron control server (see below).

## Spawn A New Agent Pane

Use this path only when the user asks to start a new visible agent pane. Do not spawn a pane just to answer an ordinary question.

With MCP tools, prefer `context_workspace_spawn_agent(project_dir, task, agent_type=...)` for one new coding-agent pane. `agent_type` accepts `codex`, `opencode`, `claude`, `athena-code` (or `athena`), and `hermes`. Athena Code launches the `athena-code` CLI, but its live terminal kind and handle prefix are `athena`, such as `athena#1`.

Use `context_workspace_spawn_terminal` for lower-level control such as shells, grids, Hermes panes, or explicit resumes. For Athena Code, pass `kind="athena"` or `kind="athena-code"`; both normalize to the same visible Athena Code pane.

For HTTP fallback through Electron control, call `POST /terminals/spawn` with `{"project_dir": "...", "kind": "athena", "task": "...", "context_mode": "task"}` or use `kind: "athena-code"` on newer Athena builds.

## Message A Live Agent Pane

Use this fast path when the user wants to reach an agent that is already running in a visible Athena pane: "ping Claude", "tell codex to ...", "ask hermes in its pane", "Claude is already up". It works the same for every agent kind: `claude`, `codex`, `opencode`, `athena` (Athena Code / `athena-code` CLI), and `hermes`.

Goal: deliver one message into the existing pane. Do not spawn anything. Do not look up session history. The only discovery step you need is listing live terminals.

Delivering a message executes input in that agent's session. Do it only for explicit user-requested pings and handoffs, never for ordinary questions, and expect it may require permission.

### Targets And Handles

Every live agent pane is addressable by a handle `<kind>#<n>`, numbered by creation order within a workspace: `claude#1`, `codex#1`, `opencode#2`, `athena#1`, `hermes#1`. Targets also accept a terminal id or a provider session id. A bare kind such as `codex` resolves only when exactly one pane of that kind exists. If resolution is ambiguous across workspaces, pass `workspace`/`project_dir` or use the terminal id. `shell` panes have no handle; address them by terminal id.

### Fast Path (MCP tools available)

1. `context_workspace_list_live_terminals` — filter by the current workspace and the wanted `kind`.
2. `context_workspace_send_message(to="<kind>#<n>", text=..., project_dir=..., from_terminal_id=$CONTEXT_WORKSPACE_TERMINAL_ID)`. Preferred: Athena stamps a structured envelope, resolves the handle, and queues instead of injecting while the target is busy.
3. Queued is normal when the target is mid-task; Athena delivers it at the next idle window. Only if it stays queued while the pane's buffer shows an idle prompt, fall back to `context_workspace_inject_terminal_input(target, text)`.

### Fast Path (HTTP, no MCP tools)

If the `context_workspace_*` MCP tools are not registered in this session, that does not mean the capability is missing — use this HTTP route before concluding the pane is unreachable.

Auth first: read `baseUrl` and `token` from `~/.context-workspace/electron-control.json` (overridable via `CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL` and `CONTEXT_WORKSPACE_ELECTRON_CONTROL_TOKEN`). Send `Authorization: Bearer <token>` on every endpoint except `/health`.

1. `GET /terminals` — filter by workspace and `kind`.
2. `POST /agent-messages/send` with `{"to": "<kind>#<n>", "text": ..., "project_dir": ..., "from_terminal_id": ...}`.
3. If the response has `queued: true` and the target never goes idle to receive it, check `GET /terminals/<target>/buffer`. If the buffer shows an idle prompt, inject directly:
   - `POST /terminals/write` with `{"target": ..., "text": ...}` — submits automatically (appends Enter, with paste handling per agent kind).
   - Only if the text appears in the buffer but did not submit, send raw Enter: `POST /terminals/input` with `{"target": ..., "data": "\r"}`.

### Wrong Routes (do not start here)

- Backend `/agents/sessions` — historical session discovery, not live panes. An empty sessions list does not prove there are no live terminals.
- Backend `/agents/spawn` — legacy non-visible run path; rejects some agent kinds (e.g. `claude`) even when installed. Never use it to reach a running pane.
- Spawning a new terminal — only when the user asks for a new pane, never to deliver a message to an existing one.

## Handoffs And Recall

Handoffs are short-lived project context, not durable truth. Before changing code, verify important details from the current workspace with local file reads and tests when practical.

When starting from a handoff:

1. Identify the requested task.
2. Extract only the relevant facts from the handoff.
3. Inspect the current workspace before editing.
4. Report stale or contradictory handoff details as context drift, not as user error.
