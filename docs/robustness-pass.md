# Athena Robustness Pass

Goal: make existing Athena workflows reliable before adding new surfaces such as ambient context, voice, or external memory layers.

This pass is complete only when the checks below pass on a fresh build and a packaged AppImage. Bugs found during the pass should be fixed before new product work continues.

## Scope

- Command Room terminal and chat modes.
- Agent spawn and resume flows.
- Native session discovery and transcripts.
- Session handoff and recall writes.
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

5. **Packaged app drift**
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

## Exit Criteria

- All verification matrix rows are manually checked or explicitly marked blocked.
- `pytest` passes.
- `npm run build` passes.
- `npm run dist` passes.
- Any discovered regression is either fixed or documented as a follow-up with reproduction steps.
- The product backlog points to robustness fixes before new feature work.
