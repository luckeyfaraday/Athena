# Context Workspace — Project Specification

**Date:** May 4, 2026 (updated May 5, 2026; plan revised May 5, 2026)
**Status:** Early-stage — not started

---

## What It Is

A desktop AI workspace that unifies browsing, context memory, and multi-agent execution in one app.

**The core idea:** All AI instances share Hermes's memory. When Hermes learns something, every spawned agent instance knows it immediately — no re-explaining, no copy-pasting. Hermes orchestrates everything.

**The difference from existing tools:**
- Not a chat interface where you paste links and explain what you want
- Not an agent sandbox with no memory of what you were doing
- The AI proactively knows your work context and can act without being asked
- Multiple agent instances (opencode, codex, claude-code) work simultaneously, all sharing Hermes's memory

**Name:** TBD — candidates: Conductor, Workbench, Scope, Context

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Tauri Desktop App (React + Rust)                           │
│                                                              │
│  ┌────────────────┐  ┌─────────────────────────────────┐   │
│  │  Webview        │  │  Agent Instances (PTY)           │   │
│  │                 │  │                                  │   │
│  │  youtube.com/   │  │  [Hermes] [opencode] [codex]   │   │
│  │  github.com/... │  │  [claude]                      │   │
│  │                 │  │                                  │   │
│  │  ← URL bar     │  │  All read from Hermes MEMORY.md │   │
│  └────────┬───────┘  └─────────────────────────────────┘   │
│           │                                                    │
│           ↓                                                    │
│  Context Engine (Python FastAPI, subprocess of Tauri)         │
│  - Fetches page content (URL input or webview nav event)      │
│  - Intent detection (deterministic intent ranking)            │
│  - Stores results in Hermes MEMORY.md                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Hermes MEMORY.md / USER.md                           │    │
│  │  ~/.hermes/profiles/<profile>/memories/              │    │
│  │  ← Hermes reads/writes (only writer)                  │    │
│  │  ← Agents read via GET /memory/hermes                │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Activity Feed / Suggestions Panel (React)            │    │
│  │  "opencode-1: reviewing auth.py | Status: running"   │    │
│  │  "codex-2: writing tests | Status: pending"           │    │
│  │  [What next?] [Extract code] [Summarize]              │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## Investigation Findings (May 5, 2026)

The original direction is strong, but the plan needs one important correction: agent context injection cannot rely on every CLI treating `CLAUDE.md` as the same native memory file.

Validated behavior:
- **Claude Code:** `CLAUDE.md` is a native project instruction file. Claude Code also supports `.claude/CLAUDE.md`, `CLAUDE.local.md`, imports, and hierarchical loading from the current working directory upward.
- **opencode:** project instructions are `AGENTS.md` first. `CLAUDE.md` is supported only as a Claude Code compatibility fallback when no local `AGENTS.md` wins.
- **Codex CLI:** project instructions are `AGENTS.md` first. `CLAUDE.md` is ignored unless the user configures `project_doc_fallback_filenames`. The local CLI supports non-interactive execution with `codex exec`, `--cd`, stdin prompts, JSONL event output, and `--output-last-message`.
- **Tauri 2:** webview navigation hooks exist in the Rust builder API (`on_navigation`, `on_page_load`, `on_new_window`), so embedded browsing remains viable without a Chrome extension.

Plan change:
- Add an **Agent Instruction Adapter** instead of assuming a single project `CLAUDE.md` works everywhere.
- Treat Hermes memory as the source of truth, but treat generated agent instruction files as cache/build artifacts.
- Never blindly overwrite an existing project `CLAUDE.md`, `AGENTS.md`, or agent config. If Hermes needs to write into a user project, it must use a generated, clearly marked block or a separate `.context-workspace/` artifact and pass that artifact path in the spawn prompt.
- Build the backend orchestration and memory safety layer before the full Tauri UI. The fastest useful MVP is a local orchestrator that can spawn one real CLI agent with controlled context, capture output, and write a curated memory entry.

Primary references checked:
- Claude Code memory docs: https://code.claude.com/docs/en/memory
- opencode rules docs: https://opencode.ai/docs/rules
- Codex AGENTS.md docs: https://developers.openai.com/codex/guides/agents-md
- Codex skills docs: https://developers.openai.com/codex/skills
- Tauri webview builder API: https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html

---

## Core Design Decisions

### 1. Hermes as Primary Executor

Hermes is the conductor — the main interface. All other agents (opencode, codex, claude-code) are tools Hermes spawns. This means:

- User talks to Hermes
- Hermes decides: use built-in knowledge, read memory, call context engine, or spawn an agent
- When Hermes spawns an agent, that agent reads relevant memory and gets a task via stdin
- Memory is the common language between all instances
- Hermes logs all agent activity to MEMORY.md as if he were doing the work himself

### 2. Shared Memory — Hermes's Own Memory Files

**Critical design decision:** The shared memory is Hermes's existing `MEMORY.md` and `USER.md` files — NOT a separate JSONL. Every entry in Hermes's memory is automatically visible to all agents. The context engine writes browsing context as entries directly into these files.

**Location:** `~/.hermes/profiles/<profile>/memories/MEMORY.md` and `USER.md`

**Memory format:** Section-delimited text files using `§` as entry separator. Each entry is plain text. Hermes has built-in tools to read and write these files (`memory` tool with add/replace/remove actions).

**Memory retrieval:** Hermes's built-in `memory` tool reads entries via keyword search and injects them into the system prompt as a frozen snapshot at session start.

**Read/write semantics:**
- Hermes reads from `MEMORY.md` at startup via `MemoryStore.load_from_disk()`
- Context engine writes via `POST /memory/store` → writes to `MEMORY.md`
- Agents (opencode, codex, claude-code) read via `GET /memory/hermes?q=...` (FastAPI reads from `MEMORY.md`)

### 3. Multi-Agent Collaboration = Shared Memory at Startup

**What "multi-instance collaboration" means:**

Every agent instance (opencode, codex, claude-code) starts with the **exact same memory Hermes has** filtered to the relevant project context. No re-explaining, no copy-paste. Hermes spawns them with relevant context pre-loaded. That's the collaboration.

Agents are **one-shot CLI processes** — spawned per task, run to completion, die. They are not persistent background services.

**Example workflow:**
```
User: "3 opencode and 3 codex in /project/foo, relevant memory from Codex repo"
  ↓
Hermes reads MEMORY.md for Codex context
  ↓
Hermes writes /project/foo/.context-workspace/runs/<run-id>/context.md
  ↓
Hermes spawns 6 agents into /project/foo
  ↓
Each agent receives context through its adapter and spawn prompt
  ↓
Each agent gets its task via PTY stdin
  ↓
Hermes monitors PTY output streams (one reader thread per instance)
  ↓
Hermes logs agent activity to MEMORY.md as if doing the work himself
  ↓
Agents exit when done, Hermes reads final output, logs result to MEMORY.md
```

### 4. Agent Memory Injection — Adapter Layer

Hermes injects context through agent-specific adapters. The adapter chooses the safest supported mechanism for each CLI instead of pretending every tool has the same instruction-file contract.

**Static startup context:**
- Claude Code: use `CLAUDE.md` / `.claude/CLAUDE.md` only when Hermes owns the generated file or can append a clearly marked generated block safely.
- opencode: prefer `AGENTS.md`; use `CLAUDE.md` only as a compatibility fallback when no `AGENTS.md` exists.
- Codex: prefer `AGENTS.md`; optionally configure `project_doc_fallback_filenames` only in a Hermes-managed `CODEX_HOME`, not in the user's global Codex config.
- All agents: always receive a spawn prompt that includes the task, the relevant Hermes memory excerpt, and the path to any generated `.context-workspace/` context artifact.

**Dynamic memory lookup:** `hermes-memory` skill or equivalent agent instruction that tells the agent how to query Hermes mid-task.

**Rule:** generated instruction files are disposable cache. Hermes's `MEMORY.md` remains the source of truth.

### Dynamic Memory Queries — hermes-memory Skill

Each spawned agent loads a skill that lets it ask Hermes for relevant memory mid-task, not just at startup.

**Skill name:** `hermes-memory`

**Installed per agent:**
- claude-code → Claude-compatible skill or project rule, only after verifying the installed version's supported skill path
- opencode → Claude Code compatibility skills can use `~/.claude/skills/` unless disabled; otherwise use opencode's native skill mechanism
- codex → `.agents/skills/hermes-memory/SKILL.md` in the project or `$HOME/.agents/skills/hermes-memory/SKILL.md`

**Skill content:**

```markdown
# hermes-memory

## When to invoke
When you need context about:
- The project you're working on (past decisions, architecture, ongoing issues)
- A specific file or module you're editing
- What other agents have done in this project
- Any technical context beyond what you can see in the code

## How to invoke
Run this command and include the output in your context:

  curl -s http://localhost:8000/memory/hermes?q=<your query>

Replace `<your query>` with a short keyword or phrase. Example:
  curl -s http://localhost:8000/memory/hermes?q=auth+module+decisions

## When to invoke
- When you start working on a new file or module
- When you encounter something that doesn't match the code pattern
- When you're about to make a significant decision or change
- When Hermes or another agent flagged something relevant

## When NOT to invoke
- When the context is already visible in the files you're reading
- For simple factual lookups (use read/file tools instead)
- When you've already asked for this specific context in the last few turns
```

**How Hermes serves memory queries:**
```
Agent: curl http://localhost:8000/memory/hermes?q=auth+module
  ↓
FastAPI reads from MEMORY.md (via Hermes memory tool)
  ↓
Returns formatted memory block:
  "Project context from Hermes's memory:
   - auth module: JWT-based, migrated from session cookies on May 2
   - opencode-1 noted: line 42 in auth.py has a race condition
   - Decision: use async/await pattern, not threading"
  ↓
Agent incorporates context into its task
```

**Protocol for memory queries:**
- Agent calls `GET /memory/hermes?q=<query>` to FastAPI
- FastAPI returns formatted plain text (no JSON wrapper)
- Agent treats response as informational context
- Hermes logs the query to MEMORY.md: "[opencode-1] asked about: auth module"

**Installation:**
- Hermes writes dynamic-memory instructions only to Hermes-managed locations, unless the user explicitly opts into project-local files.
- For Codex, use a real skill directory with `SKILL.md` metadata.
- For opencode and Claude Code, use the native rule/skill mechanism verified at runtime.
- If a CLI does not support skills on the installed version, Hermes falls back to putting the memory-query protocol in the spawn prompt.

**Interaction with native instruction files:**
- `AGENTS.md` / `CLAUDE.md` adapters can provide static project context at startup when safe.
- `hermes-memory` skill provides dynamic queries throughout the task.
- Spawn prompts always include enough context to work even when no native file is written.
- All mechanisms draw from the same source: Hermes's `MEMORY.md`.

### 4b. Agent Instruction Files Per Project Directory

**How agents receive memory at startup:**

Agents do not share one universal instruction filename:
- **claude-code**: loads `CLAUDE.md` and related Claude instruction locations.
- **opencode**: prefers `AGENTS.md`; uses `CLAUDE.md` as a compatibility fallback.
- **codex**: prefers `AGENTS.md`; can be configured to recognize fallback names, but should not require global user config changes.

**Safer approach: generate a Hermes context artifact and adapt per agent.**

When spawning agents into `/project/foo`:
1. Hermes writes relevant memory context to `/project/foo/.context-workspace/runs/<run-id>/context.md`
2. Hermes builds an agent-specific spawn prompt that references this file and embeds a concise memory excerpt.
3. If a project lacks native instruction files and the user opted in, Hermes can create managed `AGENTS.md` / `CLAUDE.md` files that import or point to the generated context.
4. If a project already has native instruction files, Hermes must not overwrite them. It should append only inside a marked generated block after explicit opt-in, or rely on spawn prompts.

**Design decision: persistent project context, non-destructive agent instructions**

The durable context belongs in Hermes memory and in `.context-workspace/` artifacts, not necessarily in first-party instruction files. Multiple agents in the same directory can share the same generated run context. This means:
- Agent completes task, dies
- Later: new agent spawned into same `/project/foo` — Hermes can reuse the stable project context, then generate a fresh task context
- Existing repo instruction files remain under the user's control

**Separation of concerns:**
- `MEMORY.md` = durable source of truth
- `.context-workspace/runs/<run-id>/context.md` = generated task/project context for one run
- Native instruction files (`AGENTS.md`, `CLAUDE.md`) = optional adapters, not the source of truth
- PTY stdin = per-spawn task instruction, agent-specific assignment

### 5. Hermes Monitors via PTY Output Streams (H1)

Hermes has **one reader thread per agent instance** (one per PTY). Each thread:
- Reads stdout/stderr from the agent's PTY
- Parses output for activity/status
- Logs to MEMORY.md as Hermes's own observation
- Detects completion (process exit)

This means Hermes always knows what each agent is doing, even without completion markers.

### 6. Results Captured via PTY Exit (M1 + M3)

When an agent exits:
1. Hermes reads all accumulated PTY output (via reader thread)
2. Hermes writes a curated summary to `MEMORY.md` in his own voice:
   ```
   §
   opencode-1 completed: reviewed auth.py | Findings: 3 issues found, 1 fixed in place
   codex-2 completed: wrote tests for api.py | Output: 47 tests, all passing
   ```
3. User sees results, decides next action

No completion markers needed — process exit is the completion signal.

### 7. Hermes is the Only Memory Writer

Agents are **read-only** on memory. Only Hermes writes to `MEMORY.md` and `USER.md`.

Rationale: Keeps memory clean and curated. Prevents noise/conflict. Hermes is the orchestrator and curator.

### 8. Shared Working Directory

Multiple directories + multiple instances possible:
- `/project/foo` — 3 opencode + 3 codex working simultaneously
- `/project/bar` — 2 claude-code in a different project
- All agents in same directory share the same Hermes-generated run context under `.context-workspace/`

Each directory is a **shared workspace** — all agents in that directory work on the same project.

### 9. User Can Prompt Directly or Via Hermes

**Allowed modes:**
- User talks to Hermes, Hermes prompts agents
- User talks directly to any agent instance (like opening two terminal windows)
- Mixed — user primarily talks to Hermes, but can occasionally DM another agent

The architecture supports all three. User decides at runtime.

---

## Data Flow

### Spawning Agents

```
Hermes receives task
  ↓
Hermes reads MEMORY.md for relevant context
  ↓
Hermes writes /project/dir/.context-workspace/runs/<run-id>/context.md
  ↓
Hermes builds an agent-specific prompt/instruction adapter
  ↓
Hermes writes task instruction to agent's PTY stdin or CLI stdin
  ↓
Agent receives relevant context through prompt + any native instruction adapter
  ↓
Agent runs to completion (one-shot)
  ↓
Hermes monitors PTY output (reader thread)
  ↓
Agent exits (process death)
  ↓
Hermes reads final output, writes curated result to MEMORY.md
  ↓
Activity feed updates
```

### Memory Read for Agents

```
Agent spawned into /project/foo
  ↓
Agent's CWD = /project/foo
  ↓
Hermes provides run context from .context-workspace/runs/<run-id>/context.md
  ↓
Native files may also load if present (AGENTS.md, CLAUDE.md, or configured fallback)
  ↓
Agent has focused project context without requiring global config changes
```

### Hermes Memory Write (Activity Logging)

```
Hermes observes agent activity (via PTY reader thread)
  ↓
Hermes forms a memory entry in his own voice:
  "[opencode-1] Task: review auth.py | Status: running | Started: 10:32am"
  ↓
Hermes writes to MEMORY.md (same as if he did the work himself)
  ↓
Next agent spawned reads updated MEMORY.md, knows what happened before
```

---

## Memory Schema (MEMORY.md entries)

```
══════════════════════════════════════════════
MEMORY (your personal notes) [97% — 2,154/2,200 chars]
══════════════════════════════════════════════
§
[opencode-1] Task: review auth.py | Status: running | Started: 10:32am
[codex-2] Task: write tests for api.py | Status: pending | Input: output from opencode-1
[claude-1] Task: refactor db.py | Status: done | Output: committed to main
§
YouTube: [title] | [channel] — [summary]
§
GitHub Issue: [title] — [URL] — [intent: debug/understand/decide]
```

**Format rule:** Memory entries are in Hermes's own voice. When logging agent activity, Hermes writes as if he is doing the work. E.g.:
- `[opencode-1] completed X` → Hermes writes: `I completed reviewing auth.py. Key findings: 3 issues.`
- NOT: `opencode-1 said: "3 issues found"`

---

## Generated Agent Context Template

Written by Hermes to `/project/foo/.context-workspace/runs/<run-id>/context.md` on spawn:

```markdown
# Project: <project name>

## Context
<relevant memory from Hermes MEMORY.md — what this project is about, current state>

## Current Task
<what the spawned agents should be working on>

## Agent Assignments
<agent id, agent type, role, expected output>

## Memory
<any specific facts, decisions, constraints relevant to this project>

## Dynamic Memory Lookup
If more context is needed, query:
curl -s "http://localhost:8000/memory/hermes?q=<url-encoded query>"
```

Example:
```markdown
# Project: Codex CI Setup

## Context
Working on setting up GitHub Actions CI for the Codex repo at /home/you/codex.
Repo has Python backend + TypeScript frontend. Need to add test automation.

## Current Task
3 opencode instances reviewing different modules for test coverage gaps.
2 codex instances writing tests for reviewed modules.

## Memory
- Main branch: main (protected)
- Test framework: pytest for Python, vitest for TypeScript
- CI already has: lint step, build step
- Missing: test step, integration test step
```

Native adapter examples:
- Codex/opencode: create or update Hermes-managed `AGENTS.md` only when safe.
- Claude Code: create or update Hermes-managed `CLAUDE.md` only when safe.
- All agents: include the generated context path in the spawn prompt so the agent can read it even when no native instruction file is written.

---

## Revised Implementation Plan

### Phase 0: Compatibility Spike (must happen before UI)

Goal: prove the agent contracts before building around them.

1. Add a small backend test harness that can run an agent in a temp repo and ask it to report which instruction sources it loaded.
2. Verify Codex path:
   - Use `codex exec --cd <dir>` for non-interactive runs.
   - Use stdin for long task prompts.
   - Use `--json` for event capture when stable enough; otherwise capture stdout/stderr.
   - Use `--output-last-message` for final result extraction.
   - Use Hermes-managed `CODEX_HOME` only when custom fallback filenames or skills are needed.
3. Verify opencode path:
   - Prefer `AGENTS.md`.
   - Confirm whether the installed version exposes a non-interactive mode suitable for one-shot execution.
   - Confirm skill loading path or fall back to prompt-based dynamic memory instructions.
4. Verify Claude Code path:
   - Prefer `CLAUDE.md` / `.claude/CLAUDE.md`.
   - Confirm current skill support and location on the installed version.
   - Confirm non-interactive execution mode and output capture behavior.
5. Record each verified command in the spec and encode it in adapter tests.

Exit criteria:
- At least Codex can be spawned end-to-end from the orchestrator harness.
- Existing project `AGENTS.md` / `CLAUDE.md` files are not overwritten.
- Generated context is readable by the agent and final output is captured.

### Phase 1: Backend-Only MVP

Goal: prove shared memory + one-shot agent execution without Tauri.

1. Create Python package under `backend/`.
2. Implement memory access:
   - Locate `~/.hermes/profiles/<profile>/memories/MEMORY.md` and `USER.md`.
   - Parse `§`-delimited entries.
   - Use file locking for writes.
   - Add injection scanning/redaction before storing fetched or agent-produced text.
3. Implement endpoints:
   - `GET /health`
   - `GET /memory/hermes?q=<query>`
   - `GET /memory/recent?limit=N`
   - `POST /memory/store`
   - `POST /agents/spawn`
   - `GET /agents/runs/<run_id>`
4. Implement an in-memory active-run registry for process status. Memory remains the durable history; the registry is only for live process handles and UI polling.
5. Implement generated context artifacts:
   - `.context-workspace/runs/<run_id>/context.md`
   - `.context-workspace/runs/<run_id>/stdout.log`
   - `.context-workspace/runs/<run_id>/stderr.log`
   - `.context-workspace/runs/<run_id>/result.md`
6. Implement `AgentAdapter` interface:
   - `build_context(project_dir, run)`
   - `build_command(project_dir, run)`
   - `parse_events(output_chunk)`
   - `summarize_result(run)`
7. Implement `CodexAdapter` first.
8. Add tests for memory parsing, memory writes, context artifact generation, and Codex command construction.

Exit criteria:
- A local API call can spawn one Codex task in a test project.
- Hermes captures output, summarizes it, and appends one curated memory entry.
- The run can be inspected through `/agents/runs/<run_id>`.

### Phase 2: Multi-Agent Runtime

Goal: safely run multiple one-shot agents against one or more project directories.

1. Add per-run IDs and per-agent IDs (`codex-1`, `opencode-1`, `claude-1`).
2. Add concurrency limits:
   - global maximum agents
   - per-project maximum agents
   - per-agent-type maximum agents
3. Add cancellation and timeout controls.
4. Add output readers per process with bounded logs to prevent unbounded memory/disk growth.
5. Add task routing:
   - parse user request into agent count, agent type, project directory, and task
   - reject or ask for clarification when directory or command is unsafe
6. Add opencode and Claude adapters after Phase 0 verification.
7. Add integration tests with fake agent executables before running real CLIs in CI.

Exit criteria:
- Multiple fake agents can run concurrently with deterministic logs.
- At least two real CLI adapter paths are verified locally.
- Memory entries remain curated and bounded.

### Phase 3: Tauri Desktop Shell

Goal: wrap the proven orchestrator in a usable desktop app.

1. Create Tauri + React app.
2. Manage FastAPI subprocess lifecycle from Tauri:
   - start on app launch
   - health-check before UI actions
   - stop on quit
3. Build UI:
   - workspace selector
   - agent spawn form
   - live run list
   - terminal/log panes
   - memory/activity feed
4. Use Rust PTY support where interactive terminal control is needed. Keep non-interactive runs on the backend process runner until the PTY path is required.
5. Add basic settings:
   - Hermes profile path
   - enabled agent types
   - concurrency limits
   - generated-file policy

Exit criteria:
- User can launch the app, select a project, spawn a Codex run, watch output, and see a memory entry after completion.

### Phase 4: Embedded Browsing + Context Engine

Goal: add browsing context after multi-agent memory sharing works.

1. Add embedded webview with URL bar.
2. Use Tauri webview navigation hooks to capture navigated URLs.
3. Add fetch/extract pipeline:
   - generic web page extraction
   - GitHub issue/PR extraction
   - YouTube transcript extraction
4. Rank intent deterministically first; add model reranking later only if needed.
5. Store curated browsing summaries through the same `POST /memory/store` path.

Exit criteria:
- Navigating to a URL can produce a reviewed memory entry.
- Agent runs can query that memory through `/memory/hermes`.

### Phase 5: Cloud and Pricing Work (defer)

Cloud Hermes, bundled API billing, team memory, and messaging integrations are explicitly post-local-MVP. Do not build cloud-specific code until the free local product proves the loop:

browser/context → Hermes memory → agent spawn → captured result → curated memory.

---

## Key Files to Create

```
context-workspace/
├── SPEC.md                          ← this file
├── backend/                         ← Python FastAPI orchestrator
│   ├── app.py                        ← API routes and app wiring
│   ├── memory.py                     ← MEMORY.md / USER.md parsing and writes
│   ├── locks.py                      ← cross-platform file locking
│   ├── safety.py                     ← injection scanning, redaction, path guards
│   ├── runs.py                       ← active run registry
│   ├── context_artifacts.py          ← .context-workspace artifact writer
│   ├── adapters/
│   │   ├── base.py                   ← AgentAdapter protocol
│   │   ├── codex.py                  ← Codex CLI adapter
│   │   ├── opencode.py               ← opencode adapter
│   │   └── claude.py                 ← Claude Code adapter
│   ├── webfetch.py                   ← generic page fetch + extract (Phase 4)
│   └── requirements.txt
├── tests/
│   ├── test_memory.py
│   ├── test_context_artifacts.py
│   ├── test_codex_adapter.py
│   └── fixtures/
│       └── fake_agent.py             ← deterministic fake CLI for tests
├── client/                          ← Tauri React frontend (Phase 3)
│   ├── src/
│   │   ├── App.jsx                  ← main layout
│   │   ├── components/
│   │   │   ├── ActivityFeed.jsx     ← recent memories / agent status
│   │   │   ├── SuggestionsPanel.jsx ← suggested next actions
│   │   │   ├── InstancePool.jsx     ← agent terminals (from agent-ide)
│   │   │   └── ...
│   │   └── tauri.js                ← Tauri IPC wrapper
│   └── src-tauri/
│       ├── src/
│       │   └── lib.rs               ← Rust PTY backend (from agent-ide)
│       └── Cargo.toml
└── docs/
    └── adapter-verification.md       ← verified CLI behavior and commands
```

---

## Borrowed from Existing Projects

### From agent-ide:
- Tauri app shell (Rust + React)
- Rust PTY backend (`portable-pty`) for spawning agent instances
- Multi-instance workspace model
- React component architecture

### From hermes-agent:
- `memory_tool.py` — MEMORY.md read/write with file locking, char limits, injection scanning
- `MemoryStore` — bounded curated memory with frozen snapshot pattern
- `MemoryManager` — provider orchestration (built-in + one external)
- Memory file format: `§` delimited entries in `~/.hermes/profiles/<profile>/memories/`

### From promptless-ai:
- Intent ranking logic (adapt for HTTP-fetched content)
- Ollama reranking (optional)

### Build Fresh:
- URL input + webview navigation integration (Phase 4)
- Hermes orchestrator integration (spawn, monitor, log)
- Agent instruction adapter and `.context-workspace/` context artifact generation
- PTY reader threads for multi-instance monitoring

---

## What to Abandon

- **Chrome extension:** Replaced by embedded webview + navigation event detection (Phase 4)
- **YouTube/GitHub Phase 1:** Focus on multi-agent collaboration first (Phase 1-3)
- **Separate JSONL memory:** Use Hermes's existing MEMORY.md files
- **Agents as persistent services:** One-shot CLI processes only
- **Universal CLAUDE.md assumption:** Use agent-specific adapters instead of one instruction filename for every CLI

---

## Open Questions

1. **Project name?** TBD — Conductor, Workbench, Scope, Context, or something else.
2. **Hermes ownership boundary?** Confirm whether Context Workspace is allowed to write through Hermes's existing memory tool directly, or whether it should write only through a Hermes-owned API to preserve curation semantics.
3. **Agent install detection?** Decide whether missing CLIs should be shown as setup warnings in the UI or handled through an installer flow.
4. **Generated file policy?** Decide default behavior for appending to existing `AGENTS.md` / `CLAUDE.md`: likely off by default, opt-in per project.
5. **PTY vs subprocess first?** Backend subprocess capture is enough for the first Codex MVP; interactive PTY should wait until the desktop terminal UX requires it.

---

## Pricing Strategy

### Priority: Free Tier First

**We build the free tier first. Paid tiers come later.**

Rationale: Build the product, prove the value, then monetize. The free tier IS the product at this stage. Don't design paid features until free tier works.

### Core Model

**Freemium SaaS with bundled API**

The product is Cloud Hermes (always-on orchestration brain). The bundled API model means users pay one flat fee and we handle everything — API keys for agents, LLM costs, infrastructure. One bill, no surprises.

### Tiers

**Free Tier (Local)**
- Local Hermes (desktop app, self-hosted)
- User's own API keys (OpenAI, Anthropic, etc.)
- Memory stored locally (`~/.hermes/`)
- Unlimited local agents
- No cloud dependency
- Telegram/WhatsApp/Discord connected locally
- **Price:** $0

**Pro ($25/mo) — All-in**
- Cloud Hermes running 24/7
- Memory persists forever (cloud-synced)
- Telegram + WhatsApp + Discord connected to cloud Hermes
- 5 simultaneous agents
- API keys bundled (we manage opencode, codex, claude-code, Hermes LLM costs)
- User does NOT need to keep machine on to message Hermes
- User's machine must be on for agent execution tasks
- Desktop app + web UI for monitoring
- **Price:** $25/mo

**Pro+ ($40/mo)**
- Everything in Pro
- 10 simultaneous agents
- Priority queue (agents start faster under load)
- **Price:** $40/mo

**Team ($15/mo per seat)**
- Everything in Pro+
- Shared team memory
- Team activity feed (see what teammates' agents are doing)
- Collaboration features
- Audit log
- Minimum 2 seats
- **Price:** $15/mo per seat

### Technical Architecture (Pricing-Relevant)

```
Cloud Hermes (our server)
├── Holds memory (persistent)
├── Orchestrates agents
├── Connected to: Telegram, WhatsApp, Discord
├── Sends commands to user's connector app
└── Always-on (user can message from anywhere)

User's Machine (connector app)
├── Receives commands from cloud Hermes
├── Spawns opencode, codex, claude-code agents
├── Captures PTY output
├── Reports results back to cloud Hermes
└── Must be on for agent tasks (not for messaging)
```

### What We Pay For (Cost Model)

- Cloud Hermes server costs (we host)
- Hermes LLM API costs (we bundle)
- opencode/api costs (we bundle — agent uses its own provider keys through our account)
- claude-code API costs (we bundle)
- Infrastructure + monitoring

**Margin:** We negotiate bulk API rates, pass a flat rate to users. Variable usage vs fixed $25/mo.

### Revenue Split (Approximate)

- Infrastructure + agent API costs: ~$10-15/mo per Pro user
- Our margin: ~$10-15/mo per Pro user
- Target: profitable at 100+ paying users

---

## Conversation Log (May 5, 2026)

### What this project is
- Desktop AI workspace: browsing + context memory + multi-agent execution
- Core idea: all AI instances share Hermes's memory. One learns something, all know it.
- Not a chat interface. Not an agent sandbox. AI proactively knows context.

### Core architecture decisions confirmed
- Tauri desktop app (React + Rust PTY)
- Embedded webview (no Chrome extension)
- Python FastAPI as context engine subprocess
- Hermes as primary executor / orchestrator
- Shared memory = Hermes's MEMORY.md / USER.md files (NOT a separate JSONL)
- Context engine writes browsing context to MEMORY.md

### Multi-agent collaboration design
- Multi-instance = multiple agents (opencode, codex, claude-code) sharing Hermes's memory at startup
- Building is easier: every agent starts with the same context Hermes has
- Agents are one-shot CLI processes (not persistent)
- Hermes is the ONLY writer to MEMORY.md — agents are read-only
- Hermes logs agent activity to MEMORY.md as if he were doing the work himself

### Memory injection approaches (L)
- Superseded decision: do not rely on persistent per-project CLAUDE.md for all agents.
- Revised decision: use an Agent Instruction Adapter per CLI.
- claude-code: use CLAUDE.md-compatible files when safe.
- opencode: prefer AGENTS.md; CLAUDE.md is a fallback.
- codex: prefer AGENTS.md; use Hermes-managed CODEX_HOME if fallback filenames or skills are needed.
- Stable context lives in Hermes MEMORY.md and generated `.context-workspace/` artifacts.
- PTY/stdin prompt remains the per-spawn task instruction and agent-specific assignment.

### Dynamic memory queries (hermes-memory skill) — NEW
- Each spawned agent also loads a hermes-memory skill
- Lets agents ask Hermes for relevant memory mid-task (not just at startup)
- Works like any agent skill: trigger condition + action (curl to FastAPI)
- Skill installed per agent type on spawn:
  - claude-code → verified Claude-compatible skill/rule location
  - opencode → verified opencode skill/rule location
  - codex → `.agents/skills/hermes-memory/SKILL.md` or Hermes-managed user skill
- How it works: agent runs `curl -s http://localhost:8000/memory/hermes?q=<query>`, incorporates response
- Hermes logs the query to MEMORY.md: "[opencode-1] asked about: auth module"
- Two memory mechanisms: generated startup context + hermes-memory (dynamic, mid-task)
- Both draw from same source: Hermes's MEMORY.md
- Protocol: GET /memory/hermes?q=<query> → formatted plain text response

### Hermes monitoring (H)
- H1: Hermes has N PTY reader threads (one per spawned instance)
- Each thread reads stdout/stderr from the agent's PTY
- Parses output for activity/status, logs to MEMORY.md
- Detects completion via process exit

### Result capture (M)
- M1 + M3: Agent exits (process death) = completion signal
- Hermes reads accumulated PTY output via reader thread
- Hermes writes curated summary to MEMORY.md in his own voice
- No completion markers needed

### Directory model (N)
- Single shared directory per agent group
- /project/foo: 3 opencode + 3 codex working simultaneously
- All agents in same directory share the same generated run context under `.context-workspace/`
- Multiple directories supported simultaneously

### Memory write protocol (D)
- D3: Only Hermes writes to MEMORY.md
- Agents are read-only consumers
- Hermes logs in his own voice: "[opencode-1] completed X → I completed reviewing auth.py. Key findings: 3 issues."

### Memory scope per instance (A)
- A3: Each instance sees only what Hermes explicitly routes
- Hermes writes targeted run context per project directory
- Different directories = different `.context-workspace/` context artifacts = different project context

### How agents communicate results (C)
- C1: Agent's output captured by Hermes (via PTY reader), Hermes writes summary to MEMORY.md
- NOT I3 (raw dump): Hermes curates and filters before writing
- Rationale: keeps memory clean, Hermes maintains quality and can redact

### User prompting modes (F)
- User can prompt directly to any agent instance
- Or let Hermes prompt agents
- Mixed mode supported

### Task state tracking (K)
- Memory is the durable task history; an in-memory active-run registry tracks live process handles and transient status
- Entries like "[opencode-1] Task: review auth.py | Status: running | Started: 10:32am"
- When task completes, Hermes updates entry to "done" with output note
- Next agent reads updated memory to pick up context

### What was abandoned
- GitHub issue fetch (focusing on multi-agent collaboration first)
- YouTube and web content workflows (Phase 4 post-MVP)
- Separate JSONL memory (using Hermes MEMORY.md)
- Browser extension (Tauri webview replaces it)
- promptless-ai as separate project (merged into this one)

### What we decided NOT to do
- Agents do NOT write directly to MEMORY.md
- Agents do NOT communicate peer-to-peer
- No separate durable task-history store beyond memory; live process state can use an in-memory registry
- No completion markers (process exit is the signal)
- No persistent agent services (one-shot processes only)

### Financial strategy
- Freemium SaaS planned: Free (local) + Pro ($25/mo) + Pro+ ($40/mo) + Team ($15/mo per seat)
- **Priority: free tier first. Paid tiers later.**
- Build the product, prove the value, then monetize
- Free tier IS the product at this stage
- Don't design paid features until free tier works
