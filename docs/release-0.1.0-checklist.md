# Athena 0.1.0 Release Checklist

Goal: ship Athena as a reliable local desktop workspace for spawning, viewing,
resuming, and coordinating Codex, OpenCode, Claude Code, Hermes, and shell
terminals across projects.

This release should be a stability release. Do not add new product surfaces
while this checklist is open unless they directly remove a release blocker.

## Release Scope

Athena 0.1.0 should prove these workflows:

- Open one or more project workspaces.
- Spawn visible Shell, Hermes, Codex, OpenCode, and Claude Code terminals.
- Spawn visible terminals from Hermes through MCP.
- Open a workspace through MCP before spawning into it.
- Inject text into live terminals through MCP.
- Kill a live terminal and close a workspace through MCP.
- Resume and inspect native agent session history scoped to the active workspace.
- Generate handoffs and write project-local recall.
- Persist user preferences and workspaces across app restarts.
- Package and run from the generated AppImage.

## Release Blockers

Fix before tagging 0.1.0:

- AppImage does not start cleanly after old Athena instances are fully quit.
- Settings such as theme, interface mode, and shell focus do not persist after
  closing and reopening the app.
- Workspace tabs do not persist after closing and reopening the app.
- Shell terminals auto-start when the user did not request them.
- Workspace switching reloads live terminals into a black or corrupted state.
- Historical Codex, OpenCode, Claude Code, or Hermes sessions appear in
  unrelated workspaces.
- MCP visible spawn fails while Athena is running and Electron control is
  healthy.
- MCP workspace open/spawn opens the backend session but does not make the
  workspace and terminal visible in the UI.
- MCP live input injection writes text but does not submit for Codex, OpenCode,
  Claude Code, or Hermes.
- MCP close workspace or kill terminal leaves visible stale panes behind.
- Closing a workspace kills terminals from another workspace.
- Links clicked inside terminals open inside a new Electron window instead of
  the user's default browser.
- Session discovery or refresh blocks the Electron UI for noticeable periods.
- Packaged app behavior differs from dev behavior for the core workflows above.

## Release Candidate Manual Test

Run this from a fresh AppImage build. Fully quit old Athena instances before
starting.

### 1. Fresh Launch And Persistence

- Launch the generated AppImage.
- Open a workspace.
- Change theme.
- Change interface mode.
- Quit Athena.
- Reopen Athena.

Pass criteria:

- The same workspace is present.
- The selected theme and interface mode are preserved.
- No shell terminal appears unless it was restored from an explicit user-created
  shell.
- Backend and Electron-control health are visible and correct.

### 2. Multi-Workspace Stability

- Open at least three workspaces.
- Spawn one shell and one agent in each workspace.
- Switch between workspace tabs repeatedly.
- Enter and exit shell focus.
- Close one workspace.

Pass criteria:

- Terminals remain visible and interactive after tab switches.
- Inactive workspaces show attention state when an agent needs action or
  finishes a task.
- Closing one workspace kills only that workspace's live terminals.
- Remaining workspaces and terminals stay intact.

### 3. UI Spawn Matrix

From the Command Room `New` menu:

- Spawn Shell.
- Spawn Hermes.
- Spawn Codex.
- Spawn OpenCode.
- Spawn Claude Code.
- Spawn Codex/OpenCode/Claude grids.

Pass criteria:

- Every requested pane appears in the active workspace.
- Agent prompts are submitted without requiring a manual Enter.
- Terminal mode still shows the raw terminal correctly.
- Chat mode, if enabled, shows readable turns and does not hide real answers.

### 4. MCP Control Matrix

From Hermes MCP:

- Call `context_workspace_open_workspace(project_dir, select=true)` for a
  workspace that is not currently open.
- Call `context_workspace_spawn_agent(..., visible_terminal=true)` in that
  workspace.
- Call `context_workspace_spawn_terminal(...)`.
- Call `context_workspace_list_live_terminals(project_dir)`.
- Call `context_workspace_inject_terminal_input(target, text)`.
- Call `context_workspace_kill_terminal(target)`.
- Call `context_workspace_close_workspace(project_dir)`.

Pass criteria:

- Open/spawn makes the workspace tab and terminal visible.
- List returns the live terminal identifiers Hermes needs.
- Injected text is both written and submitted.
- Kill removes the target terminal.
- Close removes the workspace tab and stops only that workspace's terminals.

### 5. Session History And Recall

- Open the Sessions tab in multiple workspaces.
- Verify provider tabs for Codex, OpenCode, Claude Code, and Hermes.
- Resume at least one historical session where available.
- Create a handoff from selected sessions.
- Save the handoff to recall.
- Launch a fresh agent after recall exists.

Pass criteria:

- Historical sessions are scoped to the active workspace.
- Running sessions do not duplicate their historical entries.
- Handoff evidence is useful; thin historical sessions are clearly labeled.
- Recall is written to `.context-workspace/hermes/session-recall.md`.
- Fresh agents receive only the expected lightweight Athena routing/context
  instructions.

### 6. Packaged Build

From `client/`:

```bash
npm run build
npm run dist
```

Then launch the generated AppImage.

Pass criteria:

- Build and dist complete with only known warnings.
- The AppImage contains the latest source changes.
- Backend, Electron control, MCP tools, and renderer behavior match dev mode.

## Automated Checks

Run before opening the release PR:

```bash
pytest
```

From `client/`:

```bash
npm run test:chat
npm run test:electron
npm run build
npm run dist
```

If a broad check has unrelated failures, document the failure and run the
narrowest relevant checks for the release-blocking area.

## Deferred From 0.1.0

These should not block the first release unless they regress existing behavior:

- Ambient Peekaboo/screen capture loop.
- Athena Voice Loop.
- Multi-agent collaboration tab as a new product surface.
- Advanced chat-mode transcript rendering beyond making current output usable.
- Additional themes beyond the working theme selector.
- OpenClaw integration.
- Full cross-platform polish beyond clear failure modes on unsupported paths.

## Release Notes Draft

Athena 0.1.0 is the first stability release of the local AI coding agent
workspace. It focuses on visible embedded terminals, workspace-scoped session
history, Hermes MCP control, project-local recall, handoffs, persistent
preferences, and packaged AppImage reliability.

Use this release for local orchestration of Codex, OpenCode, Claude Code,
Hermes, and shell sessions across project workspaces.
