# Context Workspace — Technical Document

**Project:** luckeyfaraday/Athena
**Generated:** 2026-05-09
**Sources:** 8 development sessions (May 4–9, 2026), full codebase review (13 Python files, 14 TypeScript/React files)
**Authors:** Hermes Agent swarm — session mining, backend review, frontend review agents

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Backend — Python/FastAPI](#3-backend--pythonfastapi)
4. [Frontend — Electron/TypeScript/React](#4-frontend--electrontypescriptreact)
5. [Data Flow: Agent Spawn](#5-data-flow-agent-spawn)
6. [Key Design Decisions](#6-key-design-decisions)
7. [Bug History](#7-bug-history)
8. [PR History](#8-pr-history)
9. [Current State](#9-current-state)
10. [Security Considerations](#10-security-considerations)

---

## 1. Overview

**Context Workspace** is a desktop AI workspace application that lets you spawn and orchestrate multiple AI agent CLIs (Codex, OpenCode, Claude Code) from a single Electron app, with Hermes memory as the shared brain.

The app acts as an orchestrator layer between Hermes (the memory/control plane) and multiple AI agent tools (the execution plane). Every agent run is logged to Hermes memory and receives context from both the durable memory store and a per-project recall cache refreshed from session history.

**Repo:** `https://github.com/luckeyfaraday/Athena`
**Stack:** Electron + React + FastAPI (NOT Tauri/Rust as originally conceived)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Main Process (client/electron/)                       │
│  main.ts · preload.ts · ipc-handlers.ts                        │
│  backend.ts · embedded-terminal.ts · codex-terminal.ts          │
│  platform.ts · agent-sessions.ts                               │
└─────────────────────────────────────────────────────────────────┘
                              ↕ IPC (contextBridge)
┌─────────────────────────────────────────────────────────────────┐
│  React Renderer (client/src/)                                   │
│  App.tsx · api.ts · electron.ts · components/                   │
└─────────────────────────────────────────────────────────────────┘
                              ↕ HTTP
┌─────────────────────────────────────────────────────────────────┐
│  FastAPI Backend (backend/)                                     │
│  app.py · memory.py · hermes.py · runs.py · executor.py         │
│  runtime.py · safety.py · context_artifacts.py · locks.py       │
│  adapters/ (codex.py)                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  Hermes Memory (~/.hermes/memories/MEMORY.md)                   │
│  HermesAgent MCP Server (mcp_server/) ← NEW                     │
│  Session Recall Cache (.context-workspace/hermes/)              │
└─────────────────────────────────────────────────────────────────┘
```

### Process Lifecycle

1. **Electron starts** → spawns FastAPI backend (uvicorn on dynamic port)
2. **Vite dev server** starts on `127.0.0.1:5173` (or loads `dist/` in production)
3. **Backend writes** `~/.context-workspace/backend.json` with URL + PID
4. **React app loads** → polls backend health every 8s
5. **User selects workspace** → sets project directory
6. **User spawns agent** → FastAPI receives spawn request
7. **Executor runs agent** → writes `context.md`, captures stdout/stderr
8. **Result logged to Hermes memory** → completion entry appended to MEMORY.md

---

## 3. Backend — Python/FastAPI

**Path:** `/home/you/home_ai/projects/context-workspace/backend/`

### File Structure

```
backend/
├── __init__.py
├── app.py                          # FastAPI app, all HTTP endpoints (452 lines)
├── memory.py                       # Hermes MEMORY.md/USER.md access (218 lines)
├── hermes.py                       # Hermes installation probing (195 lines)
├── runs.py                         # In-memory run registry (166 lines)
├── executor.py                     # Subprocess execution orchestrator (123 lines)
├── runtime.py                      # Runtime limits & policy (59 lines)
├── safety.py                       # Path/identifier validation (87 lines)
├── context_artifacts.py            # Context file & artifact paths (91 lines)
├── locks.py                        # Cross-platform exclusive file lock (34 lines)
└── adapters/
    ├── __init__.py
    ├── base.py                     # AgentAdapter protocol (29 lines)
    └── codex.py                   # Codex CLI adapter (69 lines)
```

### Module: `safety.py`

Filesystem and identifier safety guards. All project directories, run IDs, and agent IDs must pass validation before use.

**Key Constants:**
```python
_DANGEROUS_ROOTS = {
    Path("/"), Path("/bin"), Path("/boot"), Path("/dev"), Path("/etc"),
    Path("/lib"), Path("/lib64"), Path("/proc"), Path("/root"), Path("/run"),
    Path("/sbin"), Path("/sys"), Path("/usr"), Path("/var"),
}
RUN_ID_RE   = re.compile(r"^run_[A-Za-z0-9_-]{8,80}$")
AGENT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}-[1-9][0-9]{0,5}$")
```

**Public API:**
| Function | Contract |
|---|---|
| `validate_run_id(run_id)` | Raises `SafetyError` if pattern invalid |
| `validate_agent_id(agent_id)` | Raises `SafetyError` if pattern invalid |
| `resolve_project_dir(project_dir)` | Must be absolute, resolve to existing directory, not dangerous root, not home |
| `ensure_within_directory(parent, child)` | Raises if `child` resolves outside `parent` |
| `generated_run_dir(project_dir, run_id)` | → `{project_dir}/.context-workspace/runs/{run_id}/` |

---

### Module: `locks.py`

Cross-platform exclusive file lock using `fcntl` (Unix) or `msvcrt` (Windows).

```python
@contextmanager
def exclusive_file_lock(path: Path) -> Iterator[TextIO]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        if os.name == "nt":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield handle
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
```

**Platform detection:** `os.name == "nt"` → Windows `msvcrt.locking`, else Unix `fcntl.flock`. Lock is released in `finally` block. No timeout — a crashed process holding the lock will block other processes indefinitely (acceptable for local-only use).

---

### Module: `memory.py`

Hermes `MEMORY.md` / `USER.md` access layer. Reads, searches, and appends entries with secret/injection redaction.

**Entry format:** Sections separated by `§` (U+00A7):
```
§
First entry text here.
§
Second entry text here.
§
```

**Secret redaction (regex):**
```python
_SECRET_PATTERNS = [
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s`]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
]
```

**Injection pattern blocking (limited):**
```python
_INJECTION_PATTERNS = [
    re.compile(r"(?i)\bignore (all )?(previous|prior) instructions\b"),
    re.compile(r"(?i)\bsystem prompt\b"),
    re.compile(r"(?i)\bdeveloper message\b"),
]
```

**Key class: `HermesMemoryStore`**

```python
class HermesMemoryStore:
    def __init__(self, *, profile="default", root=None,
                 memory_path=None, user_path=None):
        base = root or Path.home() / ".hermes" / "memories"
        self.memory_path = memory_path or base / "MEMORY.md"
        self.user_path   = user_path or base / "USER.md"
        self.lock_path   = self.memory_path.with_suffix(".lock")
```

**Factory:** `from_hermes_home(hermes_home)` supports both new layout (`memories/MEMORY.md`) and legacy (`profiles/default/memories/MEMORY.md`).

**Core methods:**

| Method | Behavior |
|---|---|
| `entries()` | Parses all entries split by `ENTRY_SEPARATOR` — reads full file every call |
| `recent(limit)` | Returns last `limit` entries |
| `search(query, limit)` | Scores by term frequency, returns top matches sorted by `(score, index)` |
| `append(text)` | Uses `exclusive_file_lock`, applies sanitization, prepends `§\n` |
| `format_query_response(query, limit)` | Returns `"Project context from Hermes memory:\n\n- <entry>..."` |
| `format_project_context(project_dir, limit)` | Searches entries for project-related context using path needles |
| `search_project(project_dir, limit)` | Weighted matching against path variants (full path=100, home-relative=95, partial=60) |
| `log_query(agent_id, query)` | Appends `[actor] asked Hermes memory about: ...` |

**Pathneedle rule (CRITICAL):** Memory entries for context-workspace **must** contain the literal local filesystem path `/home/you/home_ai/projects/context-workspace/` for `search_project()` needle matching to work. The GitHub repo name `luckeyfaraday/Athena` alone does NOT generate matching needles.

**`_project_needles()` generation:**
```python
def _project_needles(project_dir: Path) -> list[tuple[str, int]]:
    normalized = _normalize_for_project_match(str(project_dir))
    home = Path.home()
    home_prefix = str(home) + "/"
    needles = [(normalized, 100)]  # full normalized path

    if normalized.startswith(home_prefix):
        relative = normalized.removeprefix(home_prefix)
        for prefix in ("~", home.name):
            needles.append((f"{prefix}/{relative}", 95))  # home-relative variants

    # Partial path segments (lower weight)
    for part in normalized.split("/"):
        if len(part) >= 3:
            needles.append((part, 30))
```

**`_read_recall_cache()` (for context.md injection):**
```python
def _read_recall_cache(project_dir: Path) -> str:
    recall_path = project_dir.resolve() / ".context-workspace" / "hermes" / "session-recall.md"
    if not recall_path.exists():
        return ""
    return recall_path.read_text(encoding="utf-8").strip()
```
**WARNING:** Returns raw file content with NO sanitization. Injected directly into `context.md`. See Security Considerations.

---

### Module: `hermes.py`

Hermes Agent installation detection, WSL2 bridging, and install orchestration.

**Install command (supply chain risk — no commit pin):**
```python
INSTALL_COMMAND = (
    "curl -fsSL "
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh "
    "| bash"
)
```

**`HermesStatus` dataclass:**
```python
@dataclass(frozen=True)
class HermesStatus:
    installed: bool
    command_path: str | None
    version: str | None
    hermes_home: Path
    config_exists: bool
    memory_path: Path | None
    native_windows: bool
    install_supported: bool
    setup_required: bool
    message: str
```

**WSL2 detection (`_probe_wsl_hermes`):** Queries `wsl.exe` for hermes binary path, version, and home using marker-prefixed output:
```
__HERMES_COMMAND__/home/user/.local/bin/hermes
__HERMES_VERSION__hermes 0.12.0
__HERMES_HOME__\\wsl$\Ubuntu\home\user\.hermes
```

**Status cache:** 60-second TTL to avoid repeated filesystem probes.

---

### Module: `runs.py`

In-memory run registry tracking lifecycle from `PENDING` → `RUNNING` → terminal state.

**`RunStatus` enum:**
```python
class RunStatus(str, Enum):
    PENDING   = "pending"
    RUNNING   = "running"
    SUCCEEDED = "succeeded"
    FAILED    = "failed"
    CANCELLED = "cancelled"
```

**`Run` dataclass (frozen):**
```python
@dataclass(frozen=True)
class Run:
    run_id: str           # e.g. "run_a1b2c3d4e5f6"
    agent_id: str         # e.g. "codex-3"
    agent_type: str       # "codex" | "opencode" | "claude"
    project_dir: Path
    task: str
    status: RunStatus = RunStatus.PENDING
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
```

**`RunRegistry` methods:** `create_run`, `get`, `update_status`, `fail`, `request_cancel`, `cancel_requested`, `active_runs`, `active_count`, `list_runs`.

**Agent type normalization:**
```python
def _normalize_agent_type(agent_type: str) -> str:
    normalized = agent_type.strip().lower()
    if normalized not in {"codex", "opencode", "claude"}:
        raise ValueError(f"Unsupported agent type: {agent_type!r}")
    return normalized
```

---

### Module: `executor.py`

One-shot subprocess execution for agent runs. Manages process lifecycle, cancellation, timeout, and artifact capture.

**`ExecutionResult`:**
```python
@dataclass(frozen=True)
class ExecutionResult:
    run: Run
    artifacts: RunArtifacts
    returncode: int
    summary: str
```

**`RunExecutor.execute()` flow (lines 35–114):**

1. `artifacts.write_context(run, memory_excerpt=memory_excerpt)`
2. `artifacts.initialize_logs(run)` — touches stdout.log, stderr.log, result.md
3. Pre-flight cancel check → return CANCELLED if `cancel_requested`
4. `registry.update_status(run_id, RunStatus.RUNNING)` — sets `started_at`
5. `subprocess.Popen(command.argv, cwd=command.cwd, env={**os.environ, **command.env})`
6. Store process in `_processes` dict under lock
7. `process.communicate(input=command.stdin, timeout=timeout_seconds)`
8. **On timeout:** `terminate()` → `communicate(5s)` → `kill()` as last resort
9. Write stdout/stderr to artifact files
10. Post-execution cancel check → return CANCELLED if requested during run
11. `registry.update_status(run_id, SUCCEEDED or FAILED)` — sets `completed_at`
12. `memory.append(f"[{run.agent_id}] completed task: {run.task} | Status: {status} | Summary: {summary}")`
13. Return `ExecutionResult`

**Timeout handle returns `returncode=-1`** to indicate timeout occurred.

**Environment inheritance:** `{**os.environ, **command.env}` — inherits all parent environment variables including potentially sensitive ones like `AWS_SECRET_NAME`, `OPENAI_KEY_NAME`. **Security concern.**

---

### Module: `runtime.py`

Runtime concurrency policy. Enforces global, per-project, and per-agent-type limits before spawning.

**`RuntimeLimits` defaults:**
```python
@dataclass(frozen=True)
class RuntimeLimits:
    max_global: int = 4
    max_per_project: int = 2
    max_per_agent_type: dict[str, int] = field(default_factory=lambda: {"codex": 2})
    default_timeout_seconds: float | None = 600
```

**`check_runtime_limits()`** — checks all three limits in order:
1. Global active count ≥ `max_global` → 429
2. Per-project active count ≥ `max_per_project` → 429
3. Per-agent-type active count ≥ `agent_limit` → 429

**`adapter_statuses()`** — reports for `("codex", "opencode", "claude")`: `configured`, `executable`, `installed` (via `shutil.which`), `command_path`.

---

### Module: `context_artifacts.py`

Manages the per-run artifact directory `{project_dir}/.context-workspace/runs/{run_id}/`:

```
{rundir}/
├── context.md    # Generated context for the agent
├── stdout.log   # Captured stdout
├── stderr.log   # Captured stderr
└── result.md    # Final agent output (--output-last-message)
```

**`RunArtifacts` dataclass:**
```python
@dataclass(frozen=True)
class RunArtifacts:
    run_dir: Path
    context: Path
    stdout: Path
    stderr: Path
    result: Path
```

**`write_context()` calls `_render_context()` which produces `context.md`:**
```markdown
# Context Workspace Run: {run_id}

Project directory: `{project_dir}`
Agent: `{agent_id}` ({agent_type})

## Current Task
{task}

## Hermes Memory Excerpt
{memory_excerpt or "No Hermes memory excerpt was provided."}

## Hermes Session Recall Cache
{recall_cache or "No Hermes session recall cache was provided."}

## Dynamic Memory Lookup
`curl -s "http://localhost:8000/memory/hermes?q=<query>"`
```

---

### Module: `adapters/base.py`

Defines the `AgentAdapter` Protocol and `AdapterCommand` dataclass.

```python
@dataclass(frozen=True)
class AdapterCommand:
    argv: list[str]
    cwd: Path
    stdin: str
    env: dict[str, str] = field(default_factory=dict)

class AgentAdapter(Protocol):
    agent_type: str

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        """Build the process command for a run without executing it."""

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        """Produce a compact summary from run artifacts."""
```

---

### Module: `adapters/codex.py`

Concrete adapter for the `codex` CLI tool.

```python
class CodexAdapter:
    agent_type = "codex"

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        argv = [self.executable, "exec", "--cd", str(run.project_dir),
                "--skip-git-repo-check", "--json",
                "--output-last-message", str(artifacts.result)]
        return AdapterCommand(
            argv=argv,
            cwd=run.project_dir,
            stdin=_render_prompt(run, artifacts),
        )
```

**`_render_prompt()` template:**
```python
def _render_prompt(run: Run, artifacts: RunArtifacts) -> str:
    return "\n".join([
        "You are running under Context Workspace orchestration.",
        "",
        f"Agent id: {run.agent_id}",
        f"Run id: {run.run_id}",
        f"Project directory: {run.project_dir}",
        f"Generated context file: {artifacts.context}",
        "",
        "Read the generated context file before making decisions.",
        "Use the dynamic memory lookup instructions in that file if more context is needed.",
        "",
        "Task:",
        run.task.strip(),
        "",
    ])
```

---

### FastAPI Endpoints (`app.py`)

| Method | Path | Handler | Notes |
|---|---|---|---|
| `GET` | `/health` | `health` | Returns `{"status": "ok"}` |
| `GET` | `/hermes/status` | `hermes_status` | Returns `HermesStatus` |
| `GET` | `/hermes/recall/status` | `hermes_recall_status` | Recall cache freshness |
| `POST` | `/hermes/recall/refresh` | `refresh_hermes_recall` | Runs `CONTEXT_WORKSPACE_HERMES_REFRESH_CMD` |
| `POST` | `/hermes/install` | `install_hermes` | Requires `confirm=true` |
| `GET` | `/memory/hermes` | `hermes_memory` | Queries MEMORY.md |
| `GET` | `/memory/hermes/project` | `hermes_project_memory` | Project-context memory |
| `GET` | `/memory/recent` | `recent_memory` | Recent entries |
| `POST` | `/memory/store` | `store_memory` | Append to MEMORY.md |
| `GET` | `/agents/adapters` | `get_agent_adapters` | Adapter status |
| `POST` | `/agents/spawn` | `spawn_agent` | **Primary** — 202 Accepted, background |
| `GET` | `/agents/runs` | `list_runs` | All runs |
| `GET` | `/agents/runs/{run_id}` | `get_run` | Run + artifact metadata |
| `POST` | `/agents/runs/{run_id}/cancel` | `cancel_run` | Cancel + kill process |
| `GET` | `/agents/runs/{run_id}/artifacts/{name}` | `get_run_artifact` | Read context/stdout/stderr/result |

**CORS:** Allows `^https?://(127\.0\.0\.1|localhost)(:\d+)?$` — any localhost port.

---

## 4. Frontend — Electron/TypeScript/React

**Path:** `/home/you/home_ai/projects/context-workspace/client/`

### File Structure

```
client/
├── electron-builder.yml
├── package.json
├── tsconfig.json
├── tsconfig.electron.json
├── vite.config.ts
├── electron/
│   ├── main.ts              # Electron main process (182 lines)
│   ├── preload.ts           # contextBridge IPC API (86 lines)
│   ├── ipc-handlers.ts      # IPC handler registration (78 lines)
│   ├── backend.ts           # FastAPI lifecycle management (241 lines)
│   ├── embedded-terminal.ts # node-pty PTY terminals (418 lines)
│   ├── codex-terminal.ts    # Native terminal spawning (490 lines)
│   ├── platform.ts          # Cross-platform utilities (203 lines)
│   └── agent-sessions.ts    # Session discovery from CLI state stores (330 lines)
└── src/
    ├── main.tsx             # React entry
    ├── App.tsx              # Main React app (1455 lines)
    ├── api.ts               # BackendClient HTTP client (178 lines)
    ├── electron.ts          # Desktop API wrapper + browser fallback (223 lines)
    └── components/
        └── EmbeddedTerminal.tsx  # xterm.js PTY component (162 lines)
```

---

### `electron/main.ts` — Main Process

Orchestrates the entire Electron lifecycle:

1. **GPU/Sandbox flags** (before `app.whenReady()`):
   ```typescript
   app.commandLine.appendSwitch("no-sandbox");
   app.commandLine.appendSwitch("disable-gpu");
   app.commandLine.appendSwitch("disable-gpu-compositing");
   app.commandLine.appendSwitch("disable-gpu-rasterization");
   app.disableHardwareAcceleration();
   ```

2. **`startBackend(appRoot)`** — spawns uvicorn before window creation

3. **Vite dev server management** — polls `http://127.0.0.1:5173`; spawns `npx vite --host 127.0.0.1` if not ready (15s timeout)

4. **`BrowserWindow`** — 1280×820, min 960×640, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required for node-pty)

5. **`before-quit`** — stops backend and kills Vite process

---

### `electron/backend.ts` — FastAPI Lifecycle

Manages the Python/uvicorn child process:

```typescript
export type BackendState = {
  baseUrl: string | null;   // e.g. "http://127.0.0.1:38472"
  healthy: boolean;
  running: boolean;
  port: number | null;
  lastError: string | null;
};
```

**Key functions:**
- `startBackend(appRoot)` — finds free port, spawns Python/uvicorn, waits 15s for `/health` (polls every 250ms), writes `~/.context-workspace/backend.json`
- `restartBackend(appRoot)` — stops then starts
- `stopBackend()` — SIGTERM with 3s timeout, then SIGKILL
- `checkBackendHealth()` — fetches `/health`, updates `state.healthy`
- `writeBackendDiscovery()` — writes `~/.context-workspace/backend.json` with `{baseUrl, port, pid, healthy, running, startedAt, lastError}` — **world-readable**

**Environment passed to uvicorn:**
```typescript
env: {
  ...process.env,  // ← LEAKS ALL ENV VARS INCLUDING API KEYS
  CONTEXT_WORKSPACE_BACKEND_PORT: String(port),
  PYTHONPATH: mergePythonPath(backendParent, process.env.PYTHONPATH),
},
```

**Error detection:** Lines starting with `ERROR:` or `CRITICAL:`, or containing `Traceback `, are captured as `state.lastError`.

---

### `electron/embedded-terminal.ts` — PTY Terminal Management

Core module for in-app terminal panes using `node-pty`.

**`EmbeddedTerminalSession` type:**
```typescript
export type EmbeddedTerminalSession = {
  id: string;                // `${Date.now()}-${Math.random().toString(36).slice(2)}` ← PREDICTABLE
  title: string;
  kind: "shell" | "hermes" | "codex" | "opencode" | "claude";
  workspace: string;
  pid: number | null;
  promptPath: string | null;  // Hermes prompt file
  sessionLabel: string | null;
  createdAt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
};
```

**Terminal buffer:** Ring buffer capped at 200,000 characters per terminal (`MAX_BUFFER_CHARS`). When exceeded, slices from the **start** (oldest output dropped).

**Spawn flow (`spawnEmbeddedTerminal`):**
1. Validates workspace is a directory
2. For agent kinds, calls `writeHermesPrompt(cwd)` → `fetchHermesMemory(cwd)` → writes temp `.md` prompt file with `mode: 0o600`
3. Calls `terminalLaunch()` → builds platform-specific command
4. `pty.spawn()` with `TERM=xterm-256color`
5. Sets env: `CONTEXT_WORKSPACE_TERMINAL_ID`, `CONTEXT_WORKSPACE_HERMES_PROMPT`
6. Wires `term.onData` → buffer append + IPC emit; `term.onExit` → status update

**`writeHermesPrompt()` — Hermes prompt file generation (line 302–319):**
```typescript
export function writeHermesPrompt(cwd: string, kind: string): string {
  const memory = await fetchHermesMemory(cwd);
  const content = [
    `# Context Workspace — ${kind} agent prompt`,
    "",
    `Workspace: ${cwd}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Hermes Memory",
    memory,
    "",
  ].join("\n");
  const path = `.context-workspace/hermes/prompt-${Date.now()}.md`;
  fs.writeFileSync(path, content, { mode: 0o600 });
  return path;
}
```

**`agentConfig(kind)`** — returns executable, bash args, PowerShell command:
```typescript
// opencode on POSIX
`${quoteShell(cwd)} --prompt "$(cat ${quoteShell(promptPath)})"`

// PowerShell on Windows for opencode
`-ExecutionPolicy Bypass -Command "opencode --cd ${quotePowerShell(cwd)} --prompt $(Get-Content -LiteralPath ${quotePowerShell(promptPath)} -Raw)"`
```

**Shell injection risk:** `$(cat ${quoteShell(promptPath)})` — `quoteShell` only escapes single quotes. `$(...)` inside prompt content executes as command substitution when bash interprets the string.

**Broadcast to all windows:**
```typescript
// L387-391 — emits to ALL BrowserWindow.getAllWindows()
for (const window of BrowserWindow.getAllWindows()) {
  window.webContents.send(`embedded-terminal:${event}`, payload);
}
```
Terminal data sent to every open window including devtools.

**Resize:** `Math.max(20, Math.floor(cols))` — **no upper bound**. Renderer can request arbitrary cols/rows (DoS vector).

---

### `electron/codex-terminal.ts` — Native Terminal Spawning

Manages raw `codex` CLI subprocess and native terminal launches (single + grid).

**Two modes:**

**Mode A — Embedded Codex:** Single `spawn`ed `codex` process forwarded to BrowserWindow via `send()`.
```typescript
// Unix
{ command: "script", args: ["-qfec", "codex", "/dev/null"] }
// Windows
{ command: "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", "codex"] }
```

**Mode B — Native Terminal:** Spawns native terminal emulator with a launch script:
- **Windows:** `wt.exe split-pane` → `windowsTerminalGridLaunch()`
- **Linux/macOS:** `tmux` — creates named session, splits into N panes, `select-layout tiled`

**Native grid (tmux):**
```typescript
spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, "bash"]);
for (let index = 1; index < boundedPanes; index += 1) {
  spawnSync("tmux", ["split-window", "-t", sessionName, "-c", cwd, "bash"]);
}
spawnSync("tmux", ["select-layout", "-t", sessionName, "tiled"]);
// spawn detached terminal attached to session
spawn("tmux", ["attach", "-t", sessionName], { detached: true, stdio: "ignore" });
```

**Prompt injection:**
```typescript
// writeCodexMemoryPrompt() fetches Hermes memory and writes temp .md prompt
const promptPath = `.context-workspace/hermes/codex-prompt-${Date.now()}.md`;
fs.writeFileSync(promptPath, content, { mode: isWindows ? 0o600 : 0o700 });
// PowerShell: Get-Content -Raw -LiteralPath $promptPath
// Note: large memory contexts could exceed PowerShell command-line length limits
```

---

### `electron/platform.ts` — Cross-Platform Utilities

**Platform flags:**
```typescript
export const isWindows = os.platform() === "win32";
export const isLinux = os.platform() === "linux";
export const isMac = os.platform() === "darwin";
```

**Shell quoting:**
```typescript
// POSIX: single-quote escaping
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// PowerShell: single-quote doubling
export function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
```

**WSL path conversion:**
```typescript
// C:\Users\alan\.hermes → /mnt/c/Users/alan/.hermes
export function windowsPathToWslPath(value: string): string {
  const match = value.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}
```

**Native terminal detection order:**
- Windows: `wt.exe`
- macOS: `Terminal.app` via `osascript`
- Linux: `gnome-terminal` → `konsole` → `xfce4-terminal` → `alacritty` → `kitty` → `x-terminal-emulator`

---

### `electron/agent-sessions.ts` — Session Discovery

Reads live and historical agent sessions from each CLI's local state store:

| Provider | State Store | Query |
|---|---|---|
| Codex | `~/.codex/state_5.sqlite` | Python/sqlite3 |
| OpenCode | `~/.local/share/opencode/opencode.db` | Python/sqlite3 |
| Claude | `~/.claude/projects/{encoded_workspace}/*.jsonl` | File parsing |

**Cache:** 5-second TTL to avoid repeated SQLite queries.

**Merge:** Deduplicates by `${provider}:${id}`, prioritizes `running` status, sorts by `updatedAt` descending, caps at 100 sessions.

---

### `client/src/App.tsx` — React Application

Single-page application with workspace-aware multi-room navigation.

**State:**
```typescript
const [backend, setBackend] = useState<BackendStatus | null>(null);
const [workspacePath, setWorkspacePath] = useState<WorkspacePath | null>(null);
const [state, setState] = useState<LoadState>({ hermes, recall, adapters, memory, runs });
const [embeddedSessions, setEmbeddedSessions] = useState<EmbeddedTerminalSession[]>([]);
const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
const [activeRoom, setActiveRoom] = useState<ActiveRoom>("command");
```

**Four rooms:**

| Room | Description |
|---|---|
| `command` | Command Room — embedded PTY terminals, session management, broadcast composer |
| `swarm` | Swarm Room — parallel agent spawning |
| `review` | Review Room — run output review (Tasks + Reviews tab same room) |
| `memory` | Memory Room — Hermes memory entries |

**Polling:** Every 8 seconds refreshes backend health + all sessions. `backendRefreshInFlight` ref prevents concurrent calls.

**NewLaunchMenu:** Dropdown for Shell, Hermes, Codex, OpenCode, Claude — individually or as a 4-pane grid.

**`broadcastPromptToAgents`:** Sends a prompt string to all running non-shell agent terminals via `writeEmbeddedTerminal` using `Promise.allSettled`.

---

### `client/src/components/EmbeddedTerminal.tsx` — xterm.js Terminal

React component mounting `@xterm/xterm`:

```typescript
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 10,
  lineHeight: 1.25,
  scrollback: 10000,  // ~2MB per terminal
  theme: { background: "#03050a", foreground: "#dbeafe", cursor: "#22d3ee" },
});
terminal.loadAddon(new FitAddon());
terminal.open(container);
```

**Resize:** `ResizeObserver` → `fit.fit()` → `desktop.resizeEmbeddedTerminal(id, cols, rows)` with 50ms defer.

**Image drag-and-drop:** Detects `image/*` drops, converts to paths via `desktop.getDroppedFilePaths()`, sends quoted paths to PTY.

---

## 5. Data Flow: Agent Spawn

```
User / Hermes → POST /agents/spawn
  │
  ├─ check_runtime_limits()        runtime.py: enforces 4/2/2 limits
  │
  ├─ registry.create_run()        runs.py: allocates run_id + agent_id
  │    └── validate_run_id, validate_agent_id, resolve_project_dir  safety.py
  │
  ├─ memory.append()               memory.py: logs "[codex-3] Task: ... | Status: pending"
  │    └── exclusive_file_lock → sanitize → write MEMORY.md
  │
  ├─ memory.format_query_response()  memory.py: builds memory excerpt for agent
  │    └── search_project() → _project_needles() → scored match
  │
  └─ executor.execute()            executor.py
       │
       ├─ artifacts.write_context()  context_artifacts.py: writes context.md
       │    ├─ _read_recall_cache()  → raw unsanitized session-recall.md
       │    └─ _render_context()     → "## Hermes Session Recall Cache" section
       │
       ├─ artifacts.initialize_logs()  touches stdout.log, stderr.log, result.md
       │
       ├─ adapter.build_command()   adapters/codex.py: builds argv + stdin prompt
       │
       ├─ subprocess.Popen()       inherits all os.environ + command.env
       │
       ├─ process.communicate()    runs to completion or timeout
       │
       ├─ write stdout/stderr to artifacts
       │
       ├─ registry.update_status(RUNNING→SUCCEEDED/FAILED)
       │
       └─ memory.append()           logs completion to MEMORY.md
```

---

## 6. Key Design Decisions

### Agent Instruction Adapter Layer

**Problem:** Universal `CLAUDE.md` assumption was wrong. Each CLI has different conventions:

| Agent | Native instruction file | Behavior |
|---|---|---|
| Claude Code | `CLAUDE.md` / `.claude/CLAUDE.md` | Native support |
| opencode | `AGENTS.md` first, `CLAUDE.md` fallback | Compatible with Claude Code |
| Codex | `AGENTS.md` first, ignores `CLAUDE.md` by default | Requires `project_doc_fallback_filenames` |

**Solution:** Per-agent `build_command()` adapter. Generated context goes to `.context-workspace/runs/<run-id>/context.md` (disposable cache) — source of truth stays at `~/.hermes/memories/MEMORY.md`. Never overwrite existing project instruction files.

### Hermes Memory Pathneedle Rule

Memory entries for context-workspace **must** contain the literal local filesystem path `/home/you/home_ai/projects/context-workspace/` for `search_project()` needle matching to work.

`_project_needles()` generates scoring needles from the path string. The GitHub repo name alone (`luckeyfaraday/Athena`) generates no matching needles → zero score → empty results → "No Hermes memory entries are available."

### Recall Cache

Session recall lives in `.context-workspace/hermes/session-recall.md` — project-local, separate from Hermes `MEMORY.md`. Refreshed via `CONTEXT_WORKSPACE_HERMES_REFRESH_CMD` environment variable or MCP `context_workspace_write_recall_cache`.

Injected into `context.md` under `## Hermes Session Recall Cache` section. **Not sanitized** before injection — see Security Considerations.

### Hermes as Sole Memory Writer

Hermes is the only writer to `MEMORY.md`. Agents are read-only. Two memory mechanisms:
1. Generated startup context via `context.md`
2. `curl -s "http://localhost:8000/memory/hermes?q=<query>"` for mid-task lookups

### Tech Stack Correction

Originally conceived as Tauri + Rust + PTY. Corrected to **Electron + React + FastAPI** after live verification (May 5, 2026 session). Electron was chosen for faster iteration and existing IPC patterns.

---

## 7. Bug History

| Date | Bug | Root Cause | Fix |
|---|---|---|---|
| May 5 | Memory path mismatch | `HermesManager` discovers `~/.hermes/memories/MEMORY.md`; `HermesMemoryStore` defaults to `~/.hermes/profiles/default/memories/MEMORY.md` | Supported both paths via `from_hermes_home()` |
| May 6 | White screen in Electron | Vite dev server not running → `ERR_CONNECTION_REFUSED` | Start Vite before launching Electron window; poll for readiness |
| May 6 | GPU crash (SIGTRAP) | Missing GPU flags in containerized environment | Added `--no-sandbox --disable-gpu` flags before `app.whenReady()` |
| May 8 | Memory retrieval empty | Memory entry used GitHub repo name instead of local path; `_project_needles()` couldn't match | Restored local path in memory entry |

---

## 8. PR History

| PR | Title | Status | Key Changes |
|---|---|---|---|
| #1 | Revise SPEC implementation plan | Merged | Agent Instruction Adapter, corrected agent conventions |
| #4 | Add Codex live verification harness | Merged | `scripts/verify_codex_adapter.py`, `docs/adapter-verification.md` |
| #5 | Hermes install status | Merged | `HermesManager`, `/hermes/status`, `/hermes/install` |
| #6 | FastAPI memory orchestration MVP | Merged | FastAPI layer, `HermesMemoryStore`, `/memory/hermes`, `/agents/spawn` |
| #14 | native-terminal-grid-workspace (README) | Merged (May 7) | 244-line README.md |
| #15 | prompt-all-agents-opencode-option | Merged (May 7) | `broadcastPromptToAgents()`, OpenCode launch option |
| #21 | native-terminal-grid-workspace (v2) | Open | Cross-platform `platform.ts`, embedded-terminal.ts, codex-terminal.ts, Hermes launcher (+594/-127) |

**Live Codex verification findings (PR #4):**
- `codex exec --cd <dir> --skip-git-repo-check --json -o <path>` works
- **JSONL events go to stderr, not stdout** — critical for streaming layer
- `--output-last-message` writes correctly
- Codex reads `AGENTS.md` from project root
- Codex will NOT discover `.context-workspace/runs/<run_id>/context.md` on its own — spawn prompt must give exact absolute path

---

## 9. Current State

**As of May 9, 2026:**

- **Repo:** `luckeyfaraday/Athena`
- **Main branch:** `5dbe20e`
- **Open PR:** #21 (`native-terminal-grid-workspace` branch)
- **Tech stack:** Electron + React + FastAPI
- **Agents:** codex, opencode, claude-code
- **MCP server:** `mcp_server/` — 15 tools for Hermes integration (recently added)
- **Recall cache:** `.context-workspace/hermes/session-recall.md` — project-local, Hermes session-derived

**Missing:**
- App icons (`.ico` for Windows, `.icns` for macOS)
- GitHub Actions CI for Windows distribution
- Phase 0 CLI spike not run — no live verification of agent behavior post-PR changes

**Known issues:**
- Hermes status shows "offline" in UI despite API responding (frontend/backend state sync)
- Backend health offline in UI (desktop.checkBackendHealth() IPC problem)
- Recall cache has no retention/cleanup policy

---

## 10. Security Considerations

### Critical

1. **Shell injection in `embedded-terminal.ts`** — `$(cat ${quoteShell(promptPath)})` in bash commands. `quoteShell` only escapes single quotes; `$()`, backticks, `$(...)` in prompt content execute as command substitution. If Hermes memory contains shell metacharacters, command injection occurs at agent launch.

2. **Recall cache unsanitized** — `_read_recall_cache()` returns raw file content injected into `context.md` with no sanitization. The recall cache is written by an external command (via `CONTEXT_WORKSPACE_HERMES_REFRESH_CMD` or MCP). If that command produces content with `$()` or backticks, it reaches the agent unfiltered.

3. **Env var leakage** — Both `backend.ts` and `embedded-terminal.ts` pass `...process.env` to spawned processes, leaking API keys and secrets (AWS, OpenAI, Anthropic, etc.) to agent subprocesses.

### Medium

4. **`sandbox: false`** in `main.ts` — Renderer has reduced security boundary; contextIsolation is enabled but sandboxing is disabled.

5. **Broadcast to all BrowserWindows** — Terminal data emitted to every open window including devtools.

6. **Predictable terminal IDs** — Uses `Date.now() + Math.random()` instead of `crypto.randomUUID()`.

7. **Backend discovery file world-readable** — `~/.context-workspace/backend.json` exposes backend URL, PID, and health status.

8. **Supply chain risk** — `hermes.py` install script fetched from raw GitHub URL with no commit pin or hash verification.

9. **Secret redaction incomplete** — `api_key = fake_secret_value` → `api_key = [REDACTED]` leaves value partially visible when spaces around `=`; regex doesn't cover all secret patterns.

10. **No upper bound on PTY resize** — `resizeEmbeddedTerminal` accepts any cols/rows; renderer can request extreme values causing DoS.

11. **PowerShell command-line length limit** — Large Hermes memory contexts passed as PowerShell variables could exceed ~32KB limit and silently truncate.

### Design Notes

- CORS permissive for MVP (any localhost port); tighten for production
- `adapter_statuses` and `_normalize_agent_type` both hardcode agent type list — drift risk
- `INJECTION_PATTERNS` in memory.py is trivially bypassed with slight modifications
- No artifact retention/cleanup policy — run directories accumulate indefinitely

---

*Document generated by Hermes Agent swarm — session mining agent (245s), backend review agent (216s), frontend review agent (165s). Total research: ~627 seconds.*