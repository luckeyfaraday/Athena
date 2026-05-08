---
name: hermes-context-workspace-recall
description: Use when Hermes is working with Context Workspace through the context_workspace MCP server and needs to refresh, verify, report, inspect, or clear project-local recall context before answering project questions or launching future agent runs.
---

# Hermes Context Workspace Recall

Use this workflow to turn Hermes session memory into a project-local recall cache that Context Workspace automatically injects into future agent runs.

Hermes owns retrieval and summarization. Context Workspace owns injection into generated agent context. Agents consume the generated `context.md`; they do not need direct Hermes access.

## Preconditions

- The `context_workspace` MCP server is configured in Hermes.
- Context Workspace Electron is running, or `CONTEXT_WORKSPACE_BACKEND_URL` points to a healthy backend, for backend-dependent tools.
- The project path is the WSL path to the Windows checkout, for example:

```text
/mnt/c/Users/alanq/context-workspace
```

Recall cache tools read and write project-local files and can operate even if the backend is unavailable.

## Required Operating Pattern

Before answering a substantive task about a Context Workspace project, and before spawning or coordinating agents:

1. Run `session_search` for the current project, branch, task, PR, error, or investigation topic.
2. Summarize only useful carry-forward context.
3. Call `context_workspace_write_recall_cache`.
4. Verify with `context_workspace_read_recall_cache`.
5. Report the refresh result briefly before continuing.

Use this report shape:

```text
Recall refreshed:
- project_dir: /mnt/c/Users/alanq/context-workspace
- query: <session_search query>
- bytes: <bytes written>
```

If there are no useful prior-session results, write a short empty-state summary instead of leaving stale recall in place:

```markdown
## Recall

- No relevant prior-session context found for this task.
```

## Refresh Recall

1. Run Hermes `session_search` for the current project, branch, task, or problem.
2. Summarize only the useful carry-forward context:
   - current objective
   - important decisions
   - relevant PRs, branches, commits, and files
   - known failures or caveats
   - next steps future agents should inherit
3. Call `context_workspace_write_recall_cache`:

```json
{
  "project_dir": "/mnt/c/Users/alanq/context-workspace",
  "markdown": "## Recall\n\n- Concise project/session context here.\n"
}
```

Keep the markdown concise. Do not paste raw search dumps unless the exact text is needed.

Prefer replacing the whole cache with the latest summary. Do not append indefinitely.

## Verify Recall

Call `context_workspace_read_recall_cache`:

```json
{
  "project_dir": "/mnt/c/Users/alanq/context-workspace"
}
```

Expect `exists: true` and the markdown that was just written.

Future Context Workspace runs read this file directly:

```text
<project>/.context-workspace/hermes/session-recall.md
```

The generated run context includes it under:

```text
## Hermes Session Recall Cache
```

## Clear Recall

If recall conflicts with current user instructions, points at the wrong branch/task, or becomes stale or harmful, call `context_workspace_clear_recall_cache`:

```json
{
  "project_dir": "/mnt/c/Users/alanq/context-workspace"
}
```

Then refresh recall before launching more agents.

When clearing, report it:

```text
Recall cleared:
- project_dir: /mnt/c/Users/alanq/context-workspace
- reason: <why the previous cache was stale or harmful>
```

## Operating Rules

- Treat Hermes memory as the durable source of truth.
- Treat the recall cache as a short-lived working summary for one project.
- Refresh recall at the start of each new work session.
- Refresh recall when the task, branch, or investigation direction changes.
- Prefer overwriting stale recall over appending indefinitely.
- Verify after writing so skipped or failed refreshes are visible.
- Report refresh or clear results so the user can audit whether the workflow happened.
- Do not rely on future agents calling Hermes directly; Context Workspace injects the latest recall into their generated `context.md`.

## Responsibility Split

```text
Hermes = search old sessions, summarize, refresh or clear recall
Context Workspace = inject latest recall into future agent context
Agents = consume generated context.md
```

## Troubleshooting

If backend-dependent tools fail, check `context_workspace_health`.

If health fails, start Context Workspace Electron first so this file exists:

```text
/mnt/c/Users/alanq/.context-workspace/backend.json
```

Recall cache tools can still operate without the backend because they read and write project-local files.
