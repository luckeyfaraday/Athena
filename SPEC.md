# Context Workspace — Project Specification

**Date:** May 4, 2026 (updated May 5, 2026)
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
Hermes writes /project/foo/CLAUDE.md with project-relevant memory context
  ↓
Hermes spawns 6 agents into /project/foo
  ↓
Each agent auto-loads CLAUDE.md from /project/foo/ (their working directory)
  ↓
Each agent gets its task via PTY stdin
  ↓
Hermes monitors PTY output streams (one reader thread per instance)
  ↓
Hermes logs agent activity to MEMORY.md as if doing the work himself
  ↓
Agents exit when done, Hermes reads final output, logs result to MEMORY.md
```

### 4. Agent Memory Injection — Two Mechanisms

**Static: CLAUDE.md per project directory** (persistent, loaded at every spawn)

**Dynamic: hermes-memory skill** (loaded per agent type, enables mid-task memory queries)

### Dynamic Memory Queries — hermes-memory Skill

Each spawned agent loads a skill that lets it ask Hermes for relevant memory mid-task, not just at startup.

**Skill name:** `hermes-memory`

**Installed per agent:**
- claude-code → `~/.claude/skills/hermes-memory.md`
- opencode → skill file in opencode's skill directory
- codex → skill file in codex's skill directory

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
- Hermes writes the skill file to each agent's skill directory on spawn
- For claude-code: `~/.claude/skills/hermes-memory.md`
- For opencode: equivalent path in opencode's config
- For codex: equivalent path in codex's config

**Interaction with CLAUDE.md:**
- CLAUDE.md provides static project context at startup (one-time)
- hermes-memory skill provides dynamic queries throughout the task
- Both draw from the same source: Hermes's MEMORY.md

### 4b. Agent Memory Injection — CLAUDE.md per Project Directory

**How agents receive memory at startup:**

All three agents (opencode, codex, claude-code) auto-load `CLAUDE.md` from their working directory:
- **claude-code**: loads `./CLAUDE.md` from project root + `~/.claude/CLAUDE.md` global
- **opencode**: loads `./CLAUDE.md` from project root (confirmed from skill docs)
- **codex**: likely similar — needs verification

**Simplest approach: write per-project `CLAUDE.md` files.**

When spawning agents into `/project/foo`:
1. Hermes writes relevant memory context to `/project/foo/CLAUDE.md`
2. Each agent auto-loads it on spawn — zero extra flags, zero env vars, zero API calls
3. `CLAUDE.md` is each agent's native memory file — it respects it

**Design decision: Persistent project CLAUDE.md**

`CLAUDE.md` is persistent per project directory, not per agent instance. Multiple agents in the same directory share the same project context. This means:
- Agent completes task, dies
- Later: new agent spawned into same `/project/foo` — `CLAUDE.md` still there, already knows the project
- This is how these tools are designed to work — Claude Code's own auto-memory accumulates across sessions

**Separation of concerns:**
- `CLAUDE.md` (per project directory) = stable project context, persists across agent spawns
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
- All agents in same directory share the same `CLAUDE.md`

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
Hermes writes /project/dir/CLAUDE.md with relevant context
  ↓
Hermes writes task instruction to agent's PTY stdin
  ↓
Agent loads CLAUDE.md (auto), receives task via stdin
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
Agent auto-loads /project/foo/CLAUDE.md
  ↓
CLAUDE.md contains: project name, relevant context from MEMORY.md, current task state
  ↓
Agent has full project context without any API calls or env vars
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

## Project CLAUDE.md Template

Written by Hermes to `/project/foo/CLAUDE.md` on spawn:

```markdown
# Project: <project name>

## Context
<relevant memory from Hermes MEMORY.md — what this project is about, current state>

## Current Task
<what the spawned agents should be working on>

## Memory
<any specific facts, decisions, constraints relevant to this project>
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

---

## Implementation Plan

### Phase 1: Shared Memory Foundation + Agent Spawning

1. Create Tauri app with React frontend
2. Python FastAPI subprocess managed by Tauri (start on app launch, stop on quit)
3. FastAPI endpoints:
   - `GET /memory/hermes?q=<query>` — reads from `~/.hermes/profiles/<profile>/memories/MEMORY.md`, returns formatted context
   - `GET /memory/recent?limit=N` — recent entries
   - `POST /memory/store` — writes entry to MEMORY.md
4. Hermes PTY spawn infrastructure (from agent-ide: Rust portable-pty backend)
5. Hermes PTY reader threads — one per spawned agent instance
6. Spawn command: parse "N opencode, M codex in /dir" → spawn instances
7. hermes-memory skill: write to each agent's skill directory on spawn
8. CLAUDE.md generation per project directory on spawn
9. Test: Spawn opencode, claude-code, codex into a directory, verify CLAUDE.md is loaded and skill is active
10. Verify agent can query memory mid-task via curl to FastAPI
11. Verify Hermes captures agent output and logs to MEMORY.md

### Phase 2: Hermes Orchestrator

1. Hermes is the main interface in the app
2. Hermes reads memory at startup
3. Activity feed React component reads from `/memory/recent`
4. Spawn command: parse "N opencode, M codex in /dir" → spawn instances
5. Hermes logs all agent activity to MEMORY.md in his own voice

### Phase 3: Multi-Directory + Multi-Instance

1. Support multiple simultaneous directories
2. Support mixed agent types per directory
3. Per-instance naming (opencode-1, opencode-2, codex-1, etc.)
4. PTY reader threads per instance — track all simultaneously

### Phase 4: Context Engine Integration (Post-MVP)

1. Webview URL detection (Tauri navigation events)
2. YouTube transcript fetch + classification
3. Generic web page fetch + intent ranking
4. All context stored to MEMORY.md via context engine

---

## Key Files to Create

```
context-workspace/
├── SPEC.md                          ← this file
├── client/                          ← Tauri React frontend
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
└── backend/                         ← Python FastAPI
    ├── app.py                        ← main API
    ├── memory.py                     ← reads/writes Hermes MEMORY.md
    ├── config.py                     ← model tiering
    ├── github.py                     ← GitHub API fetch
    ├── webfetch.py                   ← generic page fetch + extract
    └── requirements.txt
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
- CLAUDE.md generation per project directory
- PTY reader threads for multi-instance monitoring

---

## What to Abandon

- **Chrome extension:** Replaced by embedded webview + navigation event detection (Phase 4)
- **YouTube/GitHub Phase 1:** Focus on multi-agent collaboration first (Phase 1-3)
- **Separate JSONL memory:** Use Hermes's existing MEMORY.md files
- **Agents as persistent services:** One-shot CLI processes only

---

## Open Questions

1. **Project name?** TBD — Conductor, Workbench, Scope, Context, or something else
2. **codex CLI interface?** Needs investigation — how does it handle CLAUDE.md, how does it spawn, how does it output results?
3. **Webview library in Tauri?** `tauri-plugin-webview` or `webkit2gtk` — need to verify navigation event detection

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
- Decision: persistent per-project CLAUDE.md files (simplest, token-efficient)
- All three agents (opencode, codex, claude-code) auto-load CLAUDE.md from their working directory
- claude-code: loads ./CLAUDE.md + ~/.claude/CLAUDE.md (global)
- opencode: loads ./CLAUDE.md from project root
- codex: likely similar — needs verification
- NOT per-agent-instance: CLAUDE.md persists across agent spawns in same directory
- Separation: CLAUDE.md = stable project context, PTY stdin = per-spawn task instruction

### Dynamic memory queries (hermes-memory skill) — NEW
- Each spawned agent also loads a hermes-memory skill
- Lets agents ask Hermes for relevant memory mid-task (not just at startup)
- Works like any agent skill: trigger condition + action (curl to FastAPI)
- Skill installed per agent type on spawn:
  - claude-code → ~/.claude/skills/hermes-memory.md
  - opencode → equivalent path in opencode config
  - codex → equivalent path in codex config
- How it works: agent runs `curl -s http://localhost:8000/memory/hermes?q=<query>`, incorporates response
- Hermes logs the query to MEMORY.md: "[opencode-1] asked about: auth module"
- Two memory mechanisms: CLAUDE.md (static, startup) + hermes-memory (dynamic, mid-task)
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
- All agents in same directory share same CLAUDE.md
- Multiple directories supported simultaneously

### Memory write protocol (D)
- D3: Only Hermes writes to MEMORY.md
- Agents are read-only consumers
- Hermes logs in his own voice: "[opencode-1] completed X → I completed reviewing auth.py. Key findings: 3 issues."

### Memory scope per instance (A)
- A3: Each instance sees only what Hermes explicitly routes
- Hermes writes targeted CLAUDE.md per project directory
- Different directories = different CLAUDE.md = different project context

### How agents communicate results (C)
- C1: Agent's output captured by Hermes (via PTY reader), Hermes writes summary to MEMORY.md
- NOT I3 (raw dump): Hermes curates and filters before writing
- Rationale: keeps memory clean, Hermes maintains quality and can redact

### User prompting modes (F)
- User can prompt directly to any agent instance
- Or let Hermes prompt agents
- Mixed mode supported

### Task state tracking (K)
- Memory IS the task board — no separate state store
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
- No separate session state store (memory is the task board)
- No completion markers (process exit is the signal)
- No persistent agent services (one-shot processes only)

### Financial strategy
- Freemium SaaS planned: Free (local) + Pro ($25/mo) + Pro+ ($40/mo) + Team ($15/mo per seat)
- **Priority: free tier first. Paid tiers later.**
- Build the product, prove the value, then monetize
- Free tier IS the product at this stage
- Don't design paid features until free tier works
