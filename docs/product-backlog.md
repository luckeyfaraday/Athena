# Context Workspace Product Backlog

Last verified: 2026-05-15 on `main` after PR #28.

This backlog converts the raw task list into implementation milestones. It separates verified current behavior from proposed work so new features do not duplicate already-merged PRs.

## Current Verified Baseline

- Core UI rooms exist: Command Room, Agents, Reviews, Memory, and Settings.
- Settings has real controls for workspace selection, backend restart, Hermes status, and recall refresh.
- Embedded terminal spawning works for shell, Hermes, Codex, OpenCode, and Claude.
- New agent terminals refresh recall before launch when recall is missing or stale.
- Terminal prompts include the refreshed recall cache path and contents.
- Sessions tab tracks Codex, OpenCode, Claude, and Hermes sessions.
- Backend exposes native session discovery and native transcripts through `/agents/sessions`.
- MCP exposes Context Workspace tools for health, memory, visible embedded terminal spawning, legacy backend runs/artifacts, recall cache, native sessions, native transcripts, and memory delete.
- Review and Command Room can inspect native session metadata and transcripts.
- Memory Room can delete exact Hermes memory entries through `/memory/delete`.
- Current UI is branded Athena.
- Workspaces, session continuity handoff, recall audit trail, Codex JSONL session context, desktop lag reduction, and frontend room/component extraction are merged.

## Done

| Task | Status | Notes |
|---|---|---|
| `#31eb0480` native Codex/OpenCode session memory layer | Done | Backend and MCP expose native session discovery. Hermes owns search policy. |
| `#6011e0da` Hermes controls Context Workspace | Done | MCP bridge, recall cache tools, backend control paths, and Hermes-side config pattern exist. |
| `#97d36054` agents know recall context at spawn | Done | Recall refresh runs before spawn, and prompt files include recall path plus contents. |
| `#bee147fc` integrate functionality to UI | Done | Core visible controls perform real actions or expose accurate session-first state. |
| `#fa84515` Hermes sessions in Sessions tab | Done | Codex, OpenCode, Claude, and Hermes session readers feed the shared Sessions tab with provider filters. |
| `#453f21e2` Athena branding integrated | Done | Athena name, mark, icon assets, and app styling are integrated across the UI and packaged build assets. |
| `#5596309f` audit current app | Done | See `docs/current-app-audit.md` for works/doesn't/needs/do-not-need breakdown. |
| `#e24fce1a` add `routes.ts` | Done | Active room IDs, labels, icons, descriptions, and sidebar order come from `client/src/routes.tsx`. |
| `#11d80e78` polish the UI | Done | Focused pass tightened session-first copy, terminal controls, overflow behavior, and responsive review/agent panels. |
| MCP memory delete | Done | Backend and MCP expose exact Hermes memory delete; Memory Room can call it from the UI. |
| MCP visible terminal spawn | Done | Hermes can spawn visible Command Room terminals through Electron control instead of the legacy backend run API. |
| Native session transcript viewer | Done | PR #12 added transcript actions for native sessions in Command Room and Reviews, backed by provider-native transcript endpoints. |
| MCP spawn contract clarification | Done | PR #11 clarified that `context_workspace_spawn_agent` is the high-level visible terminal spawn tool and `/agents/spawn` is legacy backend run infrastructure. |
| Codex JSONL session context gap | Done | Codex sessions are enriched from `~/.codex/sessions/**/*.jsonl`, including session metadata, model provider, collaboration mode, sandbox/approval policy, system prompt excerpt, and native transcript reads. |
| Frontend architecture cleanup | Done | PRs #22-24 and #28 split rooms, sidebar, dashboard panels, workspace tabs, status UI, formatters, and shared helpers out of `App.tsx`. |

## Milestone 1: Finish UI Functionality

Goal: every visible control either performs a real action, exposes accurate state, or is intentionally removed.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#ce14092c` settings chat/shell mode | P1 | Partial: Settings shows real environment/runtime state, but there is no persistent chat-vs-shell mode preference yet. |
| Add actionable session detail view | P1 | Done: embedded and native sessions can be opened from Command/Reviews to inspect metadata, live terminal buffers, and native transcripts. |
| Make Review Room real | P1 | Done for session inspection: Review Room shows live buffers, native metadata, and transcripts. Separate future work can derive summaries/checks from those contents. |
| Make Active Agents real | P1 | Done: Agents is session-first; live embedded sessions and native session discovery drive the visible state. |
| Remove or relabel remaining decorative metrics | P2 | Done: visible dashboard metrics now use session, adapter, memory, and review counts from app state. |

## Milestone 2: Polish UI

Goal: reduce friction in the existing workspace UI before adding new product surfaces.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#9d14b31e` transparent shell focus mode | P2 | User can hide surrounding UI chrome while preserving shell panes and restore it predictably. |
| Improve terminal focus ergonomics | P2 | Partial: focus, maximize, minimize, drag, and grid arrange work; true transparent app mode remains open. |

## Milestone 3: Architecture Cleanup

Goal: keep the growing frontend maintainable.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| Split `App.tsx` rooms into modules | Done | Command, Agents, Reviews, Memory, Settings, and Workspace rooms live in separate components without behavior changes. |
| Extract dashboard/sidebar support UI | Done | Sidebar, workspace tabs, dashboard panels, status UI, and workspace/session helpers are separate modules. |
| Centralize status formatters | Done | Age, provider labels, status tone mapping, recall audit lines, session labels, and workspace path helpers are shared helpers. |

## Milestone 4: Session Continuity

Goal: let the user start fresh without losing useful context.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#ec62ad60` merge sessions / start fresh | P1 | Done: user can select sessions, preview a bounded handoff, save it to recall cache, and launch a fresh Codex/OpenCode/Claude session from that handoff. |
| Add session-to-recall action | P1 | Done: selected review sessions can contribute a bounded handoff to project recall. |
| Add recall audit trail | P2 | Done: recall status includes source, source count/titles, bytes, refreshed time, and last launch usage; Settings and Shared Memory Snapshot display it, with fixed byte metadata from PR #27. |

## Milestone 5: Multi-Workspace

Goal: support users working across several projects without mixing context.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#0ae98ecb` workspace tabs | P2 | Done: multiple workspaces can stay open in tabs, and switching filters terminals, sessions, recall, and memory to the active workspace. |
| Persist workspace list | P2 | Done: workspace tabs survive restart and can be closed/reopened. |
| Prevent context bleed | P1 | Done: recall cache, session discovery, terminal views, and project memory use the selected workspace. |

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
| `#d4b192ce` Ambient Screen Context Layer | Research | Curated umbrella for Peekaboo, PeekabooWin, Perceptron Mk1, Hermes curation, and selective recall injection. Produce architecture, threat model, and relevance policy before implementation. |
| Cross-platform capture adapter | Research | Define a provider interface for macOS Peekaboo, Windows PeekabooWin, and a future Linux backend. Capture must be local-first and user-controllable. |
| Perceptron Mk1 vision adapter | Research | Evaluate OpenRouter `perceptron/perceptron-mk1` for bounded screenshot/video understanding, OCR cleanup, UI region grounding, and optional box/point/polygon annotations. No raw continuous stream to the model. |
| Hermes screen-context curator | P3 | Hermes receives local OCR/snapshot facts and optional VLM summaries, then writes only task-relevant compact context to recall. |
| Selective screen context injection | P3 | Only curated, task-relevant summaries can enter recall or spawn prompts. User can inspect, redact, pause, and disable capture. |

## Parking Lot

| Task | Status | Notes |
|---|---|---|
| `#1fcdc98a` OpenClaw integration | Research only | Too vague for implementation. Define what OpenClaw contributes before adding code. |
| `#078b61c7` open-source direction | Strategic | Needs licensing, repo hygiene, security review, contribution model, and public positioning before implementation. |
| `#a0e82258` ACE, Agentic Collaboration Environment | Product concept | Keep as direction-level framing until concrete agent-to-agent workflows are defined. |
| `#b2e7bca5` GitHub organization | Research | Decide naming, ownership, repo split, and release policy before creating an org. |

## Next Implementation Step

Current recommended order:

1. Finish `#ce14092c` only if chat-vs-shell mode has a clear product meaning.
2. Treat `#9d14b31e` as a focused transparent-shell mode, not more general UI polish.
3. Keep `#d4b192ce` as research until privacy, relevance, platform adapter, and cost boundaries are written down.
