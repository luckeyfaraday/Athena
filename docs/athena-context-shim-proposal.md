# Athena Immersive Context Shim

## Decision

Add an opt-in `immersive` context mode for Codex, Claude Code, and OpenCode.
Athena should assemble one versioned, workspace-scoped context bundle and expose
it through:

1. A bounded startup prompt.
2. A durable launch artifact under `.context-workspace/context/`.
3. MCP tools for focused memory, session, project-file, and agent-state recall.
4. Provider-specific launch adapters.

Do not copy Hermes's full system prompt, overwrite project-owned `AGENTS.md` or
`CLAUDE.md`, or inject entire transcripts at launch.

## What Hermes Does

The installed checkout is Hermes Agent v0.16.0 at commit `136dae779`, currently
31 commits behind upstream `main`. The relevant architecture is present in both
the installed checkout and the current upstream repository.

### 1. Stable session prompt

Hermes builds a three-tier prompt once per session:

- `stable`: identity, tool guidance, skills, environment and model guidance.
- `context`: project instruction files and caller-supplied context.
- `volatile`: frozen memory, user profile, external memory-provider metadata,
  and session metadata.

The assembled prompt is cached for the session and persisted in `state.db`.
Hermes restores that exact prompt on resume instead of rebuilding it from
possibly changed memory. This gives semantic continuity and stable provider
prefix caching.

Relevant installed sources:

- `agent/system_prompt.py`
- `hermes_state.py`
- `agent/conversation_loop.py`

### 2. Frozen durable memory

`MEMORY.md` and `USER.md` are loaded at session start, bounded, deduplicated,
scanned for prompt injection, and frozen into the startup prompt. Writes during
the session update disk but do not mutate the active prompt snapshot.

This separates:

- durable live state on disk;
- the immutable session snapshot the model began with.

Relevant source: `tools/memory_tool.py`.

### 3. Query-driven per-turn recall

External memory providers can prefetch context using the current user message.
Hermes fetches once before the tool loop, fences the result as recalled data,
and appends it only to the current API request. It does not persist the injected
recall as if the user had said it.

Relevant sources:

- `agent/memory_manager.py`
- `agent/memory_provider.py`
- `agent/conversation_loop.py`

### 4. Session recall as retrieval, not prompt bulk

Hermes stores sessions and messages in SQLite and indexes message content with
FTS5. `session_search` supports:

- discovery by query;
- a bounded window around a match;
- full session read;
- recent-session browsing.

Discovery returns kickoff bookends, a match window, and resolution bookends.
This reconstructs goal-to-result context without loading a complete transcript.

Relevant sources:

- `hermes_state.py`
- `tools/session_search_tool.py`

### 5. Project instructions

At startup Hermes loads one project instruction source by priority:

1. `.hermes.md` or `HERMES.md`, walking toward the Git root.
2. `AGENTS.md` in the working directory.
3. `CLAUDE.md` in the working directory.
4. Cursor rules.

Each source is bounded and scanned. As tools enter subdirectories, Hermes lazily
discovers nested `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` files and appends
them to the relevant tool result. This preserves the stable startup prompt.

Relevant sources:

- `agent/prompt_builder.py`
- `agent/subdirectory_hints.py`

### 6. Persisted session state and compression lineage

Hermes persists session ID, parent ID, source, model, CWD, full system prompt,
messages, tool calls, usage, and end reason. Context compression creates a child
continuation session and preserves lineage. Session listings project a
compression chain to its current tip so it still appears as one conversation.

This is more important than the exact prompt format: continuity has an explicit
data model.

## What Athena Exposes Today

### Visible Codex, Claude, and OpenCode terminals

The current embedded-terminal path supports `none`, `task`, and `curated` modes.
It writes a temporary prompt containing workspace, task or curated text, Hermes
routing instructions, and agent-to-agent messaging instructions.

It does not automatically include:

- Hermes memory;
- the recall cache;
- session summaries or transcript retrieval guidance beyond "ask Hermes";
- a project-file manifest;
- Athena agent state;
- a stable context snapshot identifier.

Resumed sessions receive no new launch prompt.

Relevant sources:

- `client/electron/agent-context.ts`
- `client/electron/embedded-terminal.ts`
- `client/electron/terminal-launch.ts`

### MCP wiring

Claude receives an ephemeral MCP config. Codex and OpenCode currently receive
backend and control URLs in their environment, but no equivalent generated MCP
configuration in the visible-terminal launcher.

Athena installs an `athena-context-workspace` skill for all three agents, which
is useful for behavioral guidance but is not itself project context.

Relevant sources:

- `client/electron/embedded-terminal.ts`
- `client/electron/agent-skills.ts`

### Legacy backend run path

The backend creates `.context-workspace/runs/<run-id>/context.md` containing:

- task;
- a Hermes memory excerpt;
- the project recall cache;
- a dynamic memory URL.

Only the legacy Codex adapter consumes this path. It is not the primary visible
session flow.

Relevant sources:

- `backend/context_artifacts.py`
- `backend/adapters/codex.py`
- `backend/executor.py`

### Legacy native Codex launcher

`client/electron/codex-terminal.ts` has a second prompt builder that fetches
project memory and recall for native Codex launches. This logic is separate from
embedded terminals and does not serve Claude or OpenCode.

### Current gap

Athena has the required data sources, but context assembly is duplicated and the
main visible-terminal path intentionally launches with shallow context. Product
documentation still describes automatic memory/recall injection in places, so
implementation and documentation have drifted.

## Proposed Architecture

### 1. Canonical `ContextBundle`

Create one backend-owned context assembly service. Suggested modules:

- `backend/context_bundle.py`
- `backend/context_sources.py`
- `backend/context_security.py`

The bundle should be structured before it is rendered:

```json
{
  "schema_version": 1,
  "bundle_id": "ctx_...",
  "workspace": "/absolute/project",
  "created_at": "...",
  "mode": "immersive",
  "task": "...",
  "sources": {
    "project_instructions": [],
    "memory_snapshot": [],
    "session_recall": {},
    "recent_sessions": [],
    "agent_state": {},
    "curated_context": ""
  },
  "retrieval": {
    "mcp_server": "context_workspace",
    "tools": []
  },
  "budgets": {},
  "warnings": []
}
```

Render:

- `bundle.json`: machine-readable source and audit metadata.
- `context.md`: bounded model-facing startup context.

Store immutable launch bundles at:

```text
<workspace>/.context-workspace/context/<bundle-id>/
```

Do not use a temp-only prompt as the source of truth. A resumed or audited
session must be able to identify the exact bundle it started with.

### 2. Context tiers

Borrow Hermes's layering but adapt it to external CLIs:

#### Stable Athena guidance

- workspace and provider identity;
- precedence and safety statement;
- available retrieval tools;
- agent messaging instructions;
- bundle ID and artifact paths.

#### Session snapshot

- root project instructions;
- frozen project-scoped Hermes memory excerpt;
- fresh recall cache or explicit stale/missing state;
- compact active-agent state;
- task or curated handoff.

#### Dynamic retrieval

- focused memory query;
- session search and bounded transcript read;
- project instruction lookup for a path;
- live Athena agent-state lookup;
- current bundle inspection.

The launch prompt should summarize the snapshot and tell the agent to read
`context.md`. Large source material stays behind retrieval tools.

### 3. New context modes

Keep existing modes and add:

- `immersive`: Athena-selected automatic context.
- `immersive_curated`: automatic context plus caller-curated text.

Recommended behavior:

| Launch | Default |
|---|---|
| Manual fresh agent | `none` |
| User supplies a task | `task` unless UI explicitly selects immersive |
| "Start with full Athena context" | `immersive` |
| Handoff launch | `immersive_curated` |
| Hermes-spawned worker | `immersive_curated` when Hermes supplies context |
| Resume native session | preserve original bundle; do not silently reinject |

This keeps automatic immersion explicit and avoids surprising prompt changes.

### 4. Source adapters

#### Project instructions

Implement one scanner with provider-aware reporting:

- discover root `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, and Cursor
  rules;
- record all discovered files and hashes;
- select content with a documented priority;
- bound and scan content;
- never modify those files.

For nested instructions, expose:

```text
context_workspace_project_instructions(project_dir, path)
```

The managed Athena skill should instruct agents to call it when entering a new
subtree. This is the closest provider-neutral equivalent to Hermes's lazy
subdirectory hints.

#### Memory

At bundle creation, query only project-scoped Hermes memory and freeze the
result with source hashes and timestamps. Add focused retrieval:

```text
context_workspace_query_context(project_dir, query, sources=["memory"])
```

Do not inject all global Hermes memory.

#### Session recall

Include the current bounded recall cache and its freshness metadata. Add a
provider-neutral session search over Athena's native session readers:

```text
context_workspace_search_agent_sessions(project_dir, query, limit)
context_workspace_read_agent_session(provider, session_id, ...)
```

The search result should borrow Hermes's useful shape: kickoff, match window,
resolution, message counts, and provider/session identifiers. Athena can first
implement lexical scoring, then add an FTS index.

#### Agent state

Create a compact snapshot from Electron control state:

- live terminal handles;
- provider session IDs;
- titles and current tasks;
- last activity;
- queued or in-flight messages;
- relevant recent control events.

Exclude terminal buffer contents from startup context. Expose bounded reads on
demand.

### 5. Provider launch adapters

Use one bundle, with small provider-specific bootstraps.

#### Codex

- Pass a compact initial task that names `context.md` and the bundle ID.
- Keep the workspace CWD so native `AGENTS.md` discovery still works.
- Configure the Athena MCP server through Codex's supported configuration path
  when available; otherwise retain backend/control environment fallbacks.

#### Claude Code

- Continue using `--mcp-config`.
- Pass the compact bootstrap prompt.
- Let Claude's native `CLAUDE.md` support coexist with the bundle; the bundle
  records which project instructions were selected so conflicts are visible.

#### OpenCode

- Pass a compact single-line bootstrap due to its current prompt invocation.
- Configure the Athena MCP server using OpenCode's native config mechanism.
- Do not flatten the full context document into `--prompt`.

Provider adapters should return capabilities:

```ts
{
  supportsMcp: boolean,
  supportsPromptFile: boolean,
  nativeInstructionFiles: string[],
  maxBootstrapChars: number
}
```

### 6. Session-to-bundle mapping

Persist:

```text
<workspace>/.context-workspace/context/session-bindings.json
```

Each binding should include Athena terminal ID, provider, provider session ID,
bundle ID, launch mode, timestamps, task, and resume lineage.

When Athena discovers the provider session ID after launch, update the binding.
On resume, show the original bundle and offer an explicit "refresh context"
action. Do not automatically prepend a new snapshot to a historical
conversation.

### 7. Security and trust boundaries

Borrow Hermes's defensive treatment:

- scan memory, recall, curated text, and project instructions before injection;
- preserve raw source for user inspection while substituting blocked content in
  the model-facing bundle;
- fence recalled context as data, not instructions;
- include source path, hash, timestamp, and truncation metadata;
- reject paths outside the active workspace for project-file lookup;
- cap each source and the total bundle;
- never expose secrets from Hermes config, `.env`, auth files, or raw process
  environment.

## Concrete Implementation Plan

### Phase 1: unify startup context

1. Add `backend/context_bundle.py` with structured sources, budgets, rendering,
   and immutable bundle writes.
2. Move recall and project-memory reads out of Electron prompt builders into the
   backend service.
3. Add:
   - `POST /context/bundles`
   - `GET /context/bundles/{bundle_id}`
4. Add `immersive` to the MCP, Electron control, and renderer context-mode
   unions.
5. When and only when `immersive` or `immersive_curated` is selected, make
   `spawnEmbeddedTerminal` request a bundle before launching and pass its
   bootstrap prompt path to all three providers.
6. Remove `writeCodexMemoryPrompt`; native Codex launches stay clean unless
   they are replaced by an explicit immersive launch through the shared
   embedded-agent path.
7. Make legacy `ContextArtifactWriter` render through the shared bundle service.

Acceptance criteria:

- identical source sections for visible Codex, Claude, OpenCode, and legacy
  backend runs;
- no cross-workspace context;
- bundle survives after the temp prompt is removed;
- missing backend, memory, or recall is explicit and non-fatal.

### Phase 2: retrieval parity

1. Add MCP tools:
   - `context_workspace_get_context_bundle`
   - `context_workspace_query_context`
   - `context_workspace_search_agent_sessions`
   - `context_workspace_project_instructions`
   - `context_workspace_get_agent_state`
2. Generate MCP config for Codex and OpenCode as well as Claude.
3. Update the managed Athena skill to use these tools automatically when a task
   references prior work, a subdirectory, or another live agent.
4. Return provenance and truncation metadata from every retrieval tool.

Acceptance criteria:

- each provider can retrieve focused memory and session evidence mid-session;
- nested instruction lookup is workspace-contained;
- retrieval output is bounded and source-attributed.

### Phase 3: session continuity

1. Add session-to-bundle bindings.
2. Persist provider session IDs after discovery.
3. Show bundle ID, source freshness, and warnings in the Command Room.
4. Add "resume original context" and "start fresh with refreshed context" as
   distinct actions.
5. Add optional pre-launch recall refresh with a timeout and visible fallback.

Acceptance criteria:

- resumes never silently change their original context;
- fresh sessions can be traced to the exact bundle they received;
- stale recall is visible before launch.

### Phase 4: indexed recall and compaction

1. Add an Athena SQLite context index for normalized native session messages.
2. Implement FTS5 discovery with kickoff, match, and resolution windows.
3. Add a bounded workspace summary generated from selected evidence, not raw
   transcript concatenation.
4. Track source hashes and rebuild only changed bundle components.

Acceptance criteria:

- session search is fast across all supported providers;
- results preserve provider/session identity and evidence windows;
- launch context remains within a fixed budget as history grows.

## Tests

Add focused coverage for:

- bundle determinism and source ordering;
- memory and recall freezing;
- prompt-injection substitution;
- project instruction priority and nested lookup;
- workspace path containment and symlink handling;
- visible launch parity across Codex, Claude, and OpenCode;
- MCP configuration for all providers;
- session binding after asynchronous provider ID discovery;
- resume without reinjection;
- stale/missing backend, memory, and recall states;
- FTS result bookends and bounded transcript windows.

## Recommended First Slice

Implement Phase 1 with a 12-16 KB total startup budget:

- task and curated context: 3 KB;
- project instructions: 5 KB;
- recall: 3 KB;
- project memory: 2 KB;
- agent state and routing: 1 KB;
- warnings and metadata: 2 KB.

This gives all three visible agents the same opt-in immersive context behavior
while leaving every ordinary launch context-free unless the user supplies a task
or curated handoff. Large history and live state remain behind explicit
retrieval tools.

## Why This Is the Right Borrowing Boundary

Hermes owns the model loop, so it can place memory in a true system prompt,
inject per-turn recall without polluting history, and preserve prompt cache
invariants internally. Athena does not own Codex, Claude, or OpenCode model
loops. It should therefore borrow Hermes's data lifecycle and retrieval
architecture, not pretend a large first user message is equivalent to a native
system prompt.

The practical equivalent is:

- immutable startup snapshot;
- exact session-to-snapshot binding;
- small bootstrap;
- strong on-demand retrieval;
- provider-native project instructions;
- explicit refresh boundaries.

That is enough to make non-Hermes agents feel deeply situated while remaining
auditable, bounded, and compatible with each CLI.

## Upstream Reference

- https://github.com/NousResearch/hermes-agent
- Current upstream release observed during this review: Hermes Agent v0.16.0,
  released June 6, 2026.
