# Current App Audit

Last audited: 2026-05-12 on `ui-polish-pass`.

## Executive Summary

The app has crossed the line from prototype UI into a usable Athena workspace. The strongest path is now embedded terminals plus native session discovery, with Hermes recall injected at spawn time and session inspection available from Reviews.

The weakest remaining area is session continuity: sessions can be found, opened, resumed, and inspected, but the app does not yet help the user turn multiple prior sessions into a curated handoff for starting fresh.

## What Works

- Command Room is the primary workspace: shell, Hermes, Codex, OpenCode, and Claude launch inside embedded PTYs.
- Terminal controls are functional: close, minimize, maximize, focus, arrange grid, and prompt broadcast.
- Sessions tab tracks Codex, OpenCode, Claude, and Hermes sessions, grouped by provider.
- Resume works through native provider commands, with resumed sessions opened in embedded terminal panes.
- Terminal image/file drag support exists.
- Hermes recall refresh is checked before agent launch and injected into prompt files when configured.
- Review Room can inspect live embedded terminal buffers and native session metadata.
- Settings exposes real environment state: workspace, backend, Hermes paths, recall status, and adapter paths.
- Memory Room shows recent Hermes memory and can delete exact entries.
- MCP/backend coverage includes health, memory, recall, native sessions, legacy runs/artifacts, and memory delete.
- Athena branding is integrated across the app and packaged builds.
- `npm run build` and `npm run test:electron` pass on the current frontend/electron path.

## What Does Not Work Yet

- Review Room is an inspector, not a true review decision surface. It does not summarize session output, detect changed files, show checks, or produce a handoff.
- Active Agents still includes role cards for orientation, but the primary Agents surface is now session-first.
- Settings has status visibility, but no persistent user preferences yet.
- Memory deletion is exact-match only and has no confirmation, undo, or provenance display.
- Sessions can be inspected or resumed, but not summarized, merged, or written back into recall as a curated handoff.
- Multi-workspace support is still single-active-workspace only.
- Full Python test execution is not reliable in the current local environment; `python3 -m pytest` previously hung in `tests/test_app.py`.

## What We Need

### P1: Make Review Room Produce Value

The session inspector is useful, but review should answer: what happened, what changed, what should I do next?

Acceptance criteria:

- User can select a session and generate or view a bounded review summary.
- Summary includes provider, workspace, prompt path, recent terminal output excerpt, and known session metadata.
- Review UI avoids pretending to know test status or changed files unless those signals exist.

### P2: Session Continuity

This is the next major product feature after cleanup/polish.

Acceptance criteria:

- User can select one or more sessions and create a curated handoff summary.
- Handoff can be saved to recall or memory without dumping raw transcripts.
- Recall audit shows source, time, bytes, and workspace.

## What We Do Not Need Yet

- Voice/Whisper/orchestrator work. Keep it as the Athena Voice Loop milestone, but do not start until the core UI is stable.
- Ambient Peekaboo capture. It needs a threat model and relevance design before implementation.
- Custom Hermes TUI rendering. It needs a protocol/event-source design first; do not build long-term UX on brittle terminal text parsing.
- OpenClaw integration. The user flow is not defined enough.
- More branded visuals. The brand is now good enough; functionality and clarity matter more.

## Recommended Next PRs

1. `session-continuity-handoff`
   Let the user select sessions, generate a bounded handoff summary, and save it to recall.

2. `review-session-summary`
   Derive useful summaries from embedded/native session content without claiming unavailable checks.

3. `transparent-shell-focus`
   Finish the true transparent/focused shell mode now that terminal focus and pane controls exist.

4. `settings-mode-preferences`
   Define and implement chat-vs-shell mode only if it changes launch or workspace behavior.

## Status Against Raw Task List

- `#5596309f` audit what works, what does not, what we need, and what we do not need: completed by this document.
- `#bee147fc` integrate functionality to UI: complete.
- `#fa84515` Hermes sessions in Sessions tab: complete.
- `#453f21e2` Athena branding: complete.
- `#11d80e78` polish UI: complete on `ui-polish-pass`.
- `#e24fce1a` add `routes.ts`: complete.
- `#ce14092c` settings chat/shell mode: partial; settings state exists, mode preference does not.
- `#9d14b31e` hide/transparent shell focus: partial; focus/maximize exists, transparent mode does not.
