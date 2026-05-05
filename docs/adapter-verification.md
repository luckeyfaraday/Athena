# Adapter Verification

This document records CLI behavior that Context Workspace depends on.

## Codex

Initial adapter target:

```bash
codex exec --cd <project-dir> --json --output-last-message <result-path>
```

The task prompt is passed on stdin. The prompt includes:

- the agent id
- the run id
- the project directory
- the generated context artifact path
- the task text

The generated context artifact is written before execution:

```text
<project-dir>/.context-workspace/runs/<run-id>/context.md
```

Current implementation status:

- Command construction is covered by unit tests.
- Real Codex execution is not invoked by the tests yet.
- `AGENTS.md` behavior still needs a live compatibility spike.

## File Safety

Generated artifacts are allowed only under:

```text
<resolved-project-dir>/.context-workspace/runs/<validated-run-id>/
```

The project directory must be absolute, must exist, and cannot be a protected root
such as `/`, `/etc`, `/usr`, `/var`, or the user's home directory itself.

