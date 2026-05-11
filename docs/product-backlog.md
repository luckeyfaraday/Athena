# Context Workspace Product Backlog

Last verified: 2026-05-11 on `main`.

This backlog converts the raw task list into implementation milestones. It separates verified current behavior from proposed work so new features do not duplicate already-merged PRs.

## Current Verified Baseline

- Core UI rooms exist: Command Room, Agents, Reviews, Memory, and Settings.
- Settings has real controls for workspace selection, backend restart, Hermes status, and recall refresh.
- Embedded terminal spawning works for shell, Hermes, Codex, OpenCode, and Claude.
- New agent terminals refresh recall before launch when recall is missing or stale.
- Terminal prompts include the refreshed recall cache path and contents.
- Sessions tab tracks Codex, OpenCode, Claude, and Hermes sessions.
- Backend exposes native session discovery through `/agents/sessions`.
- MCP exposes Context Workspace tools for health, memory, runs, artifacts, recall cache, native sessions, and memory delete.
- Memory Room can delete exact Hermes memory entries through `/memory/delete`.
- Current UI is branded Athena.

## Done

| Task | Status | Notes |
|---|---|---|
| `#31eb0480` native Codex/OpenCode session memory layer | Done | Backend and MCP expose native session discovery. Hermes owns search policy. |
| `#6011e0da` Hermes controls Context Workspace | Done | MCP bridge, recall cache tools, backend control paths, and Hermes-side config pattern exist. |
| `#97d36054` agents know recall context at spawn | Done | Recall refresh runs before spawn, and prompt files include recall path plus contents. |
| `#bee147fc` integrate functionality to UI | Mostly done | Core visible controls now perform real actions. Keep this open only for remaining gaps listed below. |

## Milestone 1: Finish UI Functionality

Goal: every visible control either performs a real action, exposes accurate state, or is intentionally removed.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| Complete settings affordances | P0 | In progress: Settings now shows configured refresh command state, backend URL, Hermes home, memory path, adapter paths, and default workspace. |
| Add actionable run detail view | P1 | Done: runs can be opened from Agents/Reviews to inspect context, stdout, stderr, and result artifacts. |
| Make Review Room real | P1 | In progress: Review Room now has run artifact inspection; remaining work is replacing static summary cards with artifact-derived checks. |
| Make Active Agents real | P1 | Agent status is derived from embedded sessions and backend runs, not role placeholder text. |
| Remove or relabel remaining decorative metrics | P2 | Dashboard metrics that cannot be traced to backend/Electron state are either wired or removed. |

## Milestone 2: Polish UI

Goal: reduce friction in the existing workspace UI before adding new product surfaces.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#11d80e78` polish the UI | P1 | Dense operational layout, consistent spacing, no clipped labels, stable terminal layout, and clear empty/error states. |
| `#9d14b31e` transparent shell focus mode | P2 | User can hide surrounding UI chrome while preserving shell panes and restore it predictably. |
| Improve terminal focus ergonomics | P2 | Focus mode, maximize, minimize, drag, and grid arrange are visually obvious and reversible. |

## Milestone 3: Architecture Cleanup

Goal: keep the growing frontend maintainable.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#e24fce1a` add `routes.ts` | P1 | Active room IDs, labels, icons, and sidebar metadata come from one typed source of truth. |
| Split `App.tsx` rooms into modules | P2 | Command, Agents, Reviews, Memory, and Settings rooms live in separate components without behavior changes. |
| Centralize status formatters | P2 | Age, provider labels, status tone mapping, and session labels are shared helpers. |

## Milestone 4: Session Continuity

Goal: let the user start fresh without losing useful context.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#ec62ad60` merge sessions / start fresh | P1 | User can select sessions and generate a curated handoff summary into recall cache. Raw transcripts are not dumped. |
| Add session-to-recall action | P1 | A session row can contribute a bounded summary to project recall. |
| Add recall audit trail | P2 | UI shows when recall was refreshed, source, bytes, and whether a launch used fresh recall. |

## Milestone 5: Multi-Workspace

Goal: support users working across several projects without mixing context.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#0ae98ecb` workspace tabs | P2 | Multiple workspaces can be open, each with isolated terminals, sessions, recall status, and memory lookup. |
| Persist workspace list | P2 | Recent workspaces survive restart and can be closed/reopened. |
| Prevent context bleed | P1 | Recall cache and session discovery always use the selected workspace, never the last active workspace by accident. |

## Milestone 6: Hermes UI Layer

Goal: improve Hermes interaction without blocking the core workspace.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#6e789407` custom Hermes TUI layer | Research | Produce a protocol/design note first: PTY parsing vs structured events, tool-call card model, status bar, failure modes. |
| Render Hermes tool calls as cards | P3 | Only after a reliable event source exists; do not parse brittle terminal text as the permanent interface. |

## Milestone 7: Voice

Goal: consolidate voice work into one deliberate product milestone.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#767fbfe2` Athena Voice Loop | Research | Design local STT, orchestrator intent routing, command confirmation, and app control boundaries. |
| `#01be7b97` faster Whisper integration | Superseded | Fold into Athena Voice Loop. |
| `#218d43d4` Athena Whisper | Superseded | Fold into Athena Voice Loop. |
| `#1d318701` orchestrator LLM connected to voice | Superseded | Fold into Athena Voice Loop. |

## Milestone 8: Ambient Context

Goal: explore ambient capture only after privacy and relevance rules are explicit.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#d4b192ce` Ambient Peekaboo background capture loop | Research | Produce a threat model and relevance design before implementation. No continuous raw screen stream is written to recall. |
| Selective screen context injection | P3 | Only curated, task-relevant summaries can enter recall or spawn prompts. User can inspect and disable capture. |

## Parking Lot

| Task | Status | Notes |
|---|---|---|
| `#1fcdc98a` OpenClaw integration | Research only | Too vague for implementation. Define what OpenClaw contributes before adding code. |

## Next Implementation Step

Start with Milestone 1:

1. Add richer Settings state for refresh command/backend/Hermes/adapter paths.
2. Add run detail viewing from Agents or Reviews.
3. Replace static Review Room cards with data from run artifacts.
