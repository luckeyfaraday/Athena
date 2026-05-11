# Current App Audit

Last audited: 2026-05-11 on `main` after PR #38.

## Executive Summary

The app has crossed the line from prototype UI into a usable Athena workspace. The strongest path is now embedded terminals plus native session discovery, with Hermes recall injected at spawn time and session inspection available from Reviews.

The weakest remaining area is not another large feature. It is product clarity: simplify the visible model around sessions, remove legacy backend-run affordances from the primary UI, and polish the dense operational layout before adding voice, ambient capture, or a custom Hermes renderer.

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
- Active Agents still mixes role cards with real session state. The cards are useful orientation, but they are not a direct list of actual active agents.
- Legacy backend runs remain visible in Agents even though current work happens in embedded/native sessions.
- Settings has status visibility, but no persistent user preferences yet.
- Memory deletion is exact-match only and has no confirmation, undo, or provenance display.
- Sessions can be inspected or resumed, but not summarized, merged, or written back into recall as a curated handoff.
- Multi-workspace support is still single-active-workspace only.
- Full Python test execution is not reliable in the current local environment; `python3 -m pytest` previously hung in `tests/test_app.py`.

## What We Need

### P0: Remove Legacy Run Confusion

The app should treat embedded/native sessions as the primary execution model. Backend runs should be hidden from the main Agents room or moved to a small diagnostics/developer section.

Acceptance criteria:

- Agents room lists live embedded agent sessions as the real active agents.
- Legacy backend runs are not presented as the primary work board.
- Review metrics use embedded/native session counts, not backend-run language.

### P1: Make Review Room Produce Value

The session inspector is useful, but review should answer: what happened, what changed, what should I do next?

Acceptance criteria:

- User can select a session and generate or view a bounded review summary.
- Summary includes provider, workspace, prompt path, recent terminal output excerpt, and known session metadata.
- Review UI avoids pretending to know test status or changed files unless those signals exist.

### P1: Add `routes.ts`

Navigation metadata is still embedded in `App.tsx`. This will get worse as Workspace, Settings modes, and polish work land.

Acceptance criteria:

- Room IDs, labels, descriptions, sidebar icons, and ordering are defined in one typed source of truth.
- `App.tsx` consumes route metadata instead of duplicating it.

### P1: Polish Current UI

Polish should target operational clarity, not visual decoration.

Acceptance criteria:

- No clipped labels in Settings, Sessions, Review, or terminal headers.
- Empty states say exactly what action creates useful data.
- Focus/maximize/minimize behavior is obvious and reversible.
- Dense panels remain readable on laptop-sized windows.

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

1. `remove-legacy-run-board`
   Move legacy backend runs out of the main Agents room and make Agents reflect embedded/native sessions.

2. `routes-source-of-truth`
   Add `routes.ts` and remove route/sidebar metadata duplication from `App.tsx`.

3. `review-session-summary`
   Add a real session summary/handoff surface in Review without claiming unavailable checks.

4. `ui-polish-pass`
   Tighten spacing, overflow, empty states, and terminal control affordances.

## Status Against Raw Task List

- `#5596309f` audit what works, what does not, what we need, and what we do not need: completed by this document.
- `#bee147fc` integrate functionality to UI: functionally complete, with remaining cleanup captured above.
- `#11d80e78` polish UI: ready to start after legacy-run cleanup or routes cleanup.
- `#e24fce1a` add `routes.ts`: should be one of the next small architecture PRs.
