# Athena Robustness Pass

Goal: make existing Athena workflows reliable before adding new surfaces such as ambient context, voice, or external memory layers.

This pass is complete only when the checks below pass on a fresh build and a packaged AppImage. Bugs found during the pass should be fixed before new product work continues.

## Scope

- Command Room terminal and chat modes.
- Agent spawn and resume flows.
- Native session discovery and transcripts.
- Session handoff and recall writes.
- Hermes MCP bridge behavior.
- Memory and recall injection into launched agents.
- Workspace isolation.
- Build, dist, and packaged-app behavior.

## Non-Goals

- New agent providers.
- Ambient screen capture.
- Voice loop implementation.
- New memory systems.
- Major visual redesign.

## Verification Matrix

| Area | Required checks | Pass criteria |
|---|---|---|
| Shell spawn | Launch Shell from `New Shell` and `New > Shell` | Visible PTY opens, accepts input, closes cleanly, no duplicate session row. |
| Hermes spawn | Launch Hermes from `New > Hermes` | Chat and terminal modes both accept prompts; startup chrome is hidden in chat mode; answers appear in separate turns. |
| Codex spawn | Launch Codex from `New > Codex` | Prompt is submitted without manual Enter; output appears in a new chat bubble; terminal mode still behaves normally. |
| OpenCode spawn | Launch OpenCode from `New > OpenCode` | Prompt is submitted and visible PTY appears; chat mode filters startup/status noise; session appears in Sessions tab. |
| Claude spawn | Launch Claude from `New > Claude` | Visible PTY opens, prompt is attached, session appears in Sessions tab. |
| Grid launch | Launch Codex/OpenCode/Claude grids | Four panes open, pane order is stable, drag/minimize/maximize still works. |
| Resume | Resume native Codex/OpenCode/Claude/Hermes sessions | Resume opens visible embedded PTY or gives a clear failure; shell does not hang silently. |
| Broadcast | Prompt all ready agents | Codex, OpenCode, Hermes, and Claude all receive prompt and submit it. |
| Chat mode | Toggle Settings `Interface mode` to Chat | All instances render chat view globally; useful output is readable; raw terminal execution remains unchanged. |
| Terminal mode | Toggle Settings `Interface mode` to Terminal | Existing xterm interface is unchanged. |
| Session list | Open Command Room Sessions tab | Provider tabs show Codex/OpenCode/Claude/Hermes; no duplicate live/historical entry for same active session. |
| Delete session | Delete a session from Sessions tab | Deleted session stays hidden for the active workspace and does not delete provider-owned history. |
| Handoff | Select sessions and create handoff | Handoff contains concrete evidence, thin-evidence warnings when appropriate, and saves to recall. |
| Recall | Refresh recall and launch agent | Recall status updates, generated prompt includes cache path, and launch marks recall as used. |
| Hermes MCP health | Run Hermes MCP discovery/test for `context_workspace` | MCP server is discoverable, reports health, and gives a clear error when the desktop backend is unavailable. |
| MCP visible spawn | Spawn Shell/Hermes/Codex/OpenCode/Claude through Hermes MCP | Each MCP spawn opens a visible Athena pane in the active workspace, returns the terminal/session identifiers, and does not use the legacy backend run board. |
| MCP recall tools | Read, write, clear, and refresh recall through Hermes MCP | Recall file and status update correctly; stale/missing/cleared states are reflected in the UI. |
| Memory lookup | Query project memory through Athena backend and Hermes MCP | Results are scoped to the active project path and do not leak unrelated workspace memory. |
| Memory injection | Launch a fresh Codex/OpenCode/Claude session after recall refresh and memory lookup | Generated prompt includes recall cache path, recall contents, and Hermes memory excerpt when available; current user instruction remains higher priority. |
| Missing memory scenario | Launch agent with no recall cache or no Hermes memory | Prompt includes explicit empty-state text, launch still works, and UI does not imply context was injected. |
| Stale recall scenario | Start with stale recall, refresh, then spawn agent | Refresh result is visible, prompt uses the refreshed cache, and recall audit marks the launch as using fresh recall. |
| Workspaces | Switch between two workspace tabs | Terminals, sessions, memory, and recall stay scoped to active workspace. |
| Shell focus | Enter/exit shell focus | Surrounding chrome hides/restores; tabs still usable; Escape exits focus. |
| Backend | Restart backend from Settings | Backend recovers and UI reconnects without orphaning visible terminals. |
| Package | Run `npm run build` and `npm run dist` | Build and AppImage complete with only known warnings. |
| AppImage | Launch fresh AppImage after quitting old instances | Packaged UI reflects latest source and backend code. |

## Known High-Risk Areas

1. **Chat renderer parsing**
   - PTY output from Hermes, Codex, OpenCode, and Claude is TUI-oriented and noisy.
   - Chat mode must hide startup chrome and transient status lines, but it must not hide real answers or errors.
   - Fallback should be explicit when parsing is uncertain.

2. **Codex input submission**
   - Codex has historically required prompt text and Enter as separate writes.
   - Any prompt-all or chat composer change must preserve that behavior.

3. **Main-process blocking**
   - Session refresh should avoid expensive synchronous work on the Electron main process.
   - Large provider histories and locked SQLite files must not freeze terminals.

4. **Workspace context bleed**
   - Workspace tabs are central to the product now.
   - Every recall, memory, terminal, and session query needs active-workspace scoping.

5. **Hermes MCP and memory injection drift**
   - Hermes MCP, Electron control, FastAPI backend, and prompt generation cross process and OS boundaries.
   - Test real scenarios, not only static health checks: missing backend, stale recall, cleared recall, project memory hit, project memory miss, MCP spawn, and direct UI spawn.
   - WSL and Windows-localhost behavior must fail clearly instead of silently skipping memory or recall.

6. **Packaged app drift**
   - Running AppImages use bundled code from `/tmp/.mount_ATHENA...`.
   - Always fully quit old instances before judging a fresh build.

## Required Commands

From the repository root:

```bash
pytest
```

From `client/`:

```bash
npm run build
npm run dist
```

## Automated Coverage Started

The MCP memory and recall slice now has targeted regression coverage for:

- MCP recall read/write/clear safety and round trips.
- Backend recall status, refresh, write, and launch-used metadata.
- Generated context artifacts with recall present, recall missing, memory present, and memory missing.
- Workspace-scoped recall injection so one workspace's recall sentinel does not appear in another workspace's prompt.

## Hermes MCP And Memory Injection Scenario Sequence

Use this sequence when validating the Hermes MCP bridge and prompt-context injection. The goal is to prove that real launched agents receive the intended recall and memory context, not just that individual endpoints respond.

### 1. Establish Baseline

1. Fully quit old Athena instances.
2. Launch the freshly built Athena app.
3. Open Settings and confirm backend and Hermes status are online or show clear actionable errors.
4. Confirm the backend state file points to the current healthy backend.

Pass criteria:
- The UI is connected to the live backend.
- Stale backend state does not silently pass as healthy.
- Any Hermes/backend failure is visible in Settings.

### 2. Verify Hermes MCP Health

From Hermes:

```bash
hermes mcp list
hermes mcp test context_workspace
```

Pass criteria:
- `context_workspace` is enabled.
- Tools are discovered.
- `context_workspace_health` reports the Athena backend as reachable.
- With Athena closed, the MCP tool fails clearly with a backend-unavailable error instead of silently succeeding.

### 3. Verify MCP Recall Tools

Through Hermes MCP, run the equivalent of:

1. `context_workspace_read_recall_cache`
2. `context_workspace_write_recall_cache` with a known sentinel, for example `TEST_RECALL_SENTINEL_123`
3. `context_workspace_read_recall_cache`
4. `context_workspace_clear_recall_cache`
5. `context_workspace_read_recall_cache`

Pass criteria:
- Write creates or updates `.context-workspace/hermes/session-recall.md`.
- Read returns the exact sentinel while present.
- Clear removes or empties the recall cache.
- Athena UI recall status reflects written, fresh, missing, stale, or cleared states correctly.

### 4. Verify Recall Injection Into A Fresh Agent

1. Write recall containing `TEST_RECALL_SENTINEL_123`.
2. Launch a fresh Codex, OpenCode, or Claude pane from Athena.
3. Inspect the generated prompt path from the terminal/session metadata.

Pass criteria:
- Prompt contains the recall cache path.
- Prompt contains `TEST_RECALL_SENTINEL_123`.
- Recall audit marks the launch as having used recall.
- Current user instructions remain higher priority than recall text.

### 5. Verify Hermes Memory Injection

1. Add a known Hermes memory entry for the active project, for example `TEST_MEMORY_SENTINEL_456`.
2. Launch a fresh agent from Athena.
3. Inspect the generated prompt path.

Pass criteria:
- Prompt contains a Hermes memory section.
- Prompt contains `TEST_MEMORY_SENTINEL_456` when project memory lookup matches the active workspace.
- If project memory has no match, the prompt explicitly states that no Hermes memory entries are available.
- Memory from unrelated workspaces is not injected.

### 6. Verify MCP Visible Spawn

Through Hermes MCP, spawn visible panes for the installed providers:

1. Shell
2. Hermes
3. Codex
4. OpenCode
5. Claude

Pass criteria:
- Athena opens visible panes in the active workspace.
- MCP responses include terminal/session identifiers that match visible sessions.
- Sessions tab updates.
- The flow does not depend on the legacy backend run board.
- Missing providers fail with clear actionable errors.

Manual result on 2026-05-17:
- Shell: pass, visible session `1779047526339-2e5ef744db6fb`, PID `96017`.
- Hermes: pass, visible session `1779047609288-9dba47deb5fbe`, PID `96389`.
- Codex: pass, visible session `1779047610304-9184f844c0221`, PID `96399`.
- OpenCode: pass, visible session `1779047611342-965fea16267de8`, PID `96658`.
- Claude: pass, visible session `1779047612370-a640a0573e9f5`, PID `96766`.
- Workspace verified as `/home/alan/home_ai/projects/context-workspace`.

### 7. Verify Workspace Isolation

1. Open two workspace tabs.
2. Write `WORKSPACE_A_RECALL_SENTINEL` to workspace A recall.
3. Write `WORKSPACE_B_RECALL_SENTINEL` to workspace B recall.
4. Spawn one fresh agent in each workspace.
5. Inspect each generated prompt.

Pass criteria:
- Workspace A prompt contains only `WORKSPACE_A_RECALL_SENTINEL`.
- Workspace B prompt contains only `WORKSPACE_B_RECALL_SENTINEL`.
- Sessions, memory, recall, and terminals switch with the active workspace tab.
- No recall or memory context bleeds across projects.

## Exit Criteria

- All verification matrix rows are manually checked or explicitly marked blocked.
- Hermes MCP and memory/recall injection scenarios are checked with real launches or documented as blocked with reproduction steps.
- `pytest` passes.
- `npm run build` passes.
- `npm run dist` passes.
- Any discovered regression is either fixed or documented as a follow-up with reproduction steps.
- The product backlog points to robustness fixes before new feature work.
