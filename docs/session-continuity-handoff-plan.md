# Session Continuity Handoff Plan

Last updated: 2026-05-12.

## Goal

Implement `#ec62ad60`: let the user start fresh without losing useful context from prior Athena sessions.

The product behavior should be:

1. User selects one or more live or historical sessions.
2. Athena creates a bounded handoff summary from metadata and recent terminal output.
3. User reviews the handoff before saving.
4. Athena writes the curated handoff into project-local recall.
5. A fresh agent launch receives that handoff through the existing recall prompt path.

This is not raw transcript merging. The output must be short, inspectable, workspace-scoped, and safe to inject into future agent prompts.

## Current Building Blocks

- `client/src/App.tsx` can list embedded terminal sessions and native provider sessions.
- `desktop.getEmbeddedTerminalBuffer(id)` can read a bounded live terminal buffer.
- Native sessions expose provider, session ID, title, workspace, model, branch, timestamps, status, terminal ID, and resume command.
- Recall already lives at `.context-workspace/hermes/session-recall.md`.
- Backend exposes `/hermes/recall/status` and `/hermes/recall/refresh`.
- MCP exposes `context_workspace_write_recall_cache`, `context_workspace_read_recall_cache`, and `context_workspace_clear_recall_cache`.

## First Shippable Slice

### UI

- Add multi-select checkboxes to the Review session list.
- Add a `Create handoff` action enabled when at least one session is selected.
- Show a preview panel with:
  - source session count
  - workspace
  - generated markdown
  - byte count
  - warning that raw transcripts are not saved
- Add `Save to recall` after preview generation.

### Handoff Content

Generate markdown with this shape:

```md
# Athena Session Handoff

Generated: <timestamp>
Workspace: <workspace>
Sources: <count>

## Summary
- <manual/generated short summary placeholder>

## Selected Sessions
- <provider/kind>: <title> (<status>, <session id or terminal id>)

## Recent Evidence
### <session title>
<last bounded terminal excerpt or metadata-only note>

## Next Suggested Context
- <short bullets for the next agent>
```

For the first implementation, the summary can be deterministic and metadata-based. It should not pretend to know changed files, tests, or final outcome unless those signals are actually present in the selected buffers.

### Data Rules

- Live embedded sessions may contribute a bounded recent terminal excerpt.
- Historical native sessions without a live `terminalId` contribute metadata only.
- Limit per-session excerpt size, with a total handoff byte cap.
- Preserve current workspace isolation. Do not include sessions from inactive workspace tabs.
- Do not write to Hermes global memory directly from the UI.

### Recall Write Path

Preferred first implementation:

- Add a backend endpoint such as `POST /hermes/recall/write`.
- Request body:
  - `project_dir`
  - `markdown`
  - `source`
- Backend validates the project path with existing safety helpers.
- Backend writes `.context-workspace/hermes/session-recall.md`.
- Backend writes `last-refresh.json` with source, timestamp, and bytes.
- Frontend calls this endpoint after the user reviews the preview.

Reason: the UI should not depend on Hermes MCP to write the cache. Hermes can still overwrite or clear recall later through MCP.

## Acceptance Criteria

- User can select multiple sessions in Reviews.
- User can generate a preview handoff without saving it.
- User can save the preview to project recall.
- Recall status updates after save.
- Fresh agent launches include the saved handoff via existing prompt injection.
- Handoff is bounded and does not dump full raw transcripts.
- Historical sessions without live buffers are handled gracefully.

## Follow-Up Slices

- Add recall audit trail in UI: source, timestamp, bytes, workspace, and whether the next launch used fresh recall.
- Add optional manual edit before saving.
- Add provider-specific historical transcript readers only after privacy and size rules are explicit.
- Add a `Start fresh from handoff` action that saves recall and launches a new selected agent in one flow.
