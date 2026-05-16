# Context Workspace Product Backlog

Last verified: 2026-05-16 on `main` after PR #33.

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
- Workspaces, session continuity handoff, recall audit trail, Codex JSONL session context, desktop lag reduction, frontend room/component extraction, and global chat interface mode are merged.

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
| `#ce14092c` settings chat/shell mode | Done | PR #30 added a persistent terminal/chat interface preference with Settings controls and Command Room rendering. |
| `#9d14b31e` transparent shell focus mode | Done in PR #32/#33 | Command Room can enter a persisted shell-focus mode, hide surrounding workspace chrome, restore with the toolbar or Esc, and keep Command Room tabs usable while focused. |
| `#8af0e23e` Codex JSONL session source of truth | Done | PR #25 enriches Codex sessions from `~/.codex/sessions/**/*.jsonl`, including session metadata, model provider, collaboration mode, sandbox/approval policy, system prompt excerpt, and native transcript reads. |
| `#0ae98ecb` workspace tabs / multi-project support | Done | PR #23 added persisted workspace tabs and workspace-scoped terminals, sessions, recall, and memory. |
| `#ec62ad60` merge sessions / start fresh | Done | PR #14/#17/#19/#20 added session handoff selection, preview, save-to-recall, start-fresh launch, and recall audit metadata. |
| `#a4b66aa9` make handoff artifacts substantively useful | Done | PR #34 improved handoff generation with native transcript reads, evidence extraction, scoring, noise filtering, and sections for files, commands, outcomes, failures, decisions, questions, and next actions. |

## Milestone 1: Finish UI Functionality

Goal: every visible control either performs a real action, exposes accurate state, or is intentionally removed.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#ce14092c` settings chat/shell mode | Done | Persistent chat-vs-terminal interface mode is available in Settings and Command Room. |
| Add actionable session detail view | P1 | Done: embedded and native sessions can be opened from Command/Reviews to inspect metadata, live terminal buffers, and native transcripts. |
| Make Review Room real | P1 | Done for session inspection: Review Room shows live buffers, native metadata, and transcripts. Separate future work can derive summaries/checks from those contents. |
| Make Active Agents real | P1 | Done: Agents is session-first; live embedded sessions and native session discovery drive the visible state. |
| Remove or relabel remaining decorative metrics | P2 | Done: visible dashboard metrics now use session, adapter, memory, and review counts from app state. |

## Milestone 2: Polish UI

Goal: reduce friction in the existing workspace UI before adding new product surfaces.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#9d14b31e` transparent shell focus mode | Done in PR #32/#33 | User can hide surrounding UI chrome while preserving shell panes, keep Command Room tabs available, and restore with Esc or the Command Room toolbar. |
| Improve terminal focus ergonomics | Done in PR #32/#33 | Focus, maximize, minimize, drag, grid arrange, transparent shell focus, larger Command Room workspace, and focus-mode tab switching are implemented. |

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

## Milestone 6: Chat Mode Quality

Goal: make chat mode a strong visual alternative to terminal mode while keeping the same PTY-backed execution model.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#6e789407` improve chat mode rendering | P1 | Replace the Hermes-specific TUI idea with better global chat mode: clearer message grouping, readable streaming output, status/error blocks, and graceful fallback to raw transcript when parsing is uncertain. |
| Chat composer parity | P1 | Chat mode supports the same practical interactions as terminal mode where possible: prompt send, prompt-all compatibility, image path drop, running/exited state, and keyboard ergonomics. |
| Provider-aware chat polish | P2 | Codex, OpenCode, Claude, Hermes, and Shell output each get conservative display cleanup without changing spawn/runtime behavior. |

## Milestone 7: Robustness Pass

Goal: harden existing user-facing workflows before adding new product surfaces.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#robustness` run full robustness matrix | P0 | Complete `docs/robustness-pass.md` across terminal/chat modes, spawns, resumes, sessions, handoffs, workspace isolation, build, dist, and AppImage launch. |
| Chat mode regression pass | P0 | Hermes, Codex, OpenCode, Claude, and Shell chat output render useful answers in separate turns, hide startup/control chrome, and preserve terminal execution behavior. |
| Spawn/resume regression pass | P0 | Shell, Hermes, Codex, OpenCode, Claude, grids, native resumes, and MCP visible spawn work or fail with clear actionable errors. |
| Workspace/session state regression pass | P1 | No duplicate live/historical sessions, deleted sessions stay hidden per workspace, and switching workspaces never leaks recall/memory/session state. |
| Packaged-app confidence | P1 | `pytest`, `npm run build`, `npm run dist`, and fresh AppImage launch are verified after fully quitting old Athena instances. |

## Milestone 8: Voice

Goal: consolidate voice work into one deliberate product milestone.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#767fbfe2` Athena Voice Loop | Research | Design local STT, orchestrator intent routing, command confirmation, and app control boundaries. |
| `#01be7b97` faster Whisper integration | Superseded | Fold into Athena Voice Loop. |
| `#218d43d4` Athena Whisper | Superseded | Fold into Athena Voice Loop. |
| `#1d318701` orchestrator LLM connected to voice | Superseded | Fold into Athena Voice Loop. |

## Milestone 9: Ambient Context

Goal: explore ambient capture only after privacy and relevance rules are explicit.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#d4b192ce` Ambient Screen Context Layer | Research | Curated umbrella for Peekaboo, PeekabooWin, Perceptron Mk1, Hermes curation, and selective recall injection. Produce architecture, threat model, and relevance policy before implementation. |
| Cross-platform capture adapter | Research | Define a provider interface for macOS Peekaboo, Windows PeekabooWin, and a future Linux backend. Capture must be local-first and user-controllable. |
| Perceptron Mk1 vision adapter | Research | Evaluate OpenRouter `perceptron/perceptron-mk1` for bounded screenshot/video understanding, OCR cleanup, UI region grounding, and optional box/point/polygon annotations. No raw continuous stream to the model. |
| Hermes screen-context curator | P3 | Hermes receives local OCR/snapshot facts and optional VLM summaries, then writes only task-relevant compact context to recall. |
| Selective screen context injection | P3 | Only curated, task-relevant summaries can enter recall or spawn prompts. User can inspect, redact, pause, and disable capture. |

## Milestone 10: Memory Layer Research

Goal: evaluate external memory layers without weakening Athena's controlled recall and handoff workflow.

| Task | Priority | Acceptance criteria |
|---|---:|---|
| `#418751b2` AgentMemory optional integration | Research | Evaluate `rohitg00/agentmemory` as an optional secondary cross-agent memory/index layer for Athena/Hermes. Keep Hermes recall as the policy owner. Possible Athena integration: Settings status, Memory Room search tab, curated handoff writes, and bounded spawn recall. Do not stream raw PTY output by default, and do not replace Hermes `MEMORY.md` until the value is proven. |

## Parking Lot

| Task | Status | Notes |
|---|---|---|
| `#1fcdc98a` OpenClaw integration | Research only | Too vague for implementation. Define what OpenClaw contributes before adding code. |
| `#078b61c7` open-source direction | Strategic | Needs licensing, repo hygiene, security review, contribution model, and public positioning before implementation. |
| `#61ae50de` Athena article / public call to action | Strategic | Create a substantial article explaining what Athena is, how it works, the vision, and how developers can help build it. Depends on the open-source positioning work. |
| `#a0e82258` ACE, Agentic Collaboration Environment | Product concept | Keep as direction-level framing until concrete agent-to-agent workflows are defined. |
| `#b2e7bca5` GitHub organization | Research | Decide naming, ownership, repo split, and release policy before creating an org. |

## Next Implementation Step

Current recommended order:

1. Complete the robustness matrix in `docs/robustness-pass.md`.
2. Fix any regressions found in chat mode, spawn/resume, session state, workspace isolation, or packaged builds.
3. Keep `#d4b192ce`, voice, and external memory systems paused until the existing app is reliable.
