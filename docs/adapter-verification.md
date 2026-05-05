# Adapter Verification

This document records CLI behavior that Context Workspace depends on.

## Codex

Initial adapter target:

```bash
codex exec --cd <project-dir> --skip-git-repo-check --json --output-last-message <result-path>
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
- The run executor is covered with a deterministic fake agent.
- Live local verification found that `codex exec --cd <dir> --skip-git-repo-check -o <path>` reads `AGENTS.md`, exits `0` on success, and writes the final response.
- `--json` streams JSONL events to stderr, not stdout.
- Codex does not discover `.context-workspace/runs/<run-id>/context.md` by itself. The spawn prompt must provide the exact absolute context path.
- Real Codex execution is not invoked by the tests yet.
- `scripts/verify_codex_adapter.py` is the local live compatibility harness.

## Fake Agent Harness

The test fixture at `tests/fixtures/fake_agent.py` simulates a one-shot CLI:

- reads the task prompt from stdin
- writes a final message to `--output-last-message`
- emits stdout/stderr
- exits with a configurable status code

This validates the backend loop before real CLI calls:

```text
RunRegistry -> ContextArtifactWriter -> AgentAdapter -> RunExecutor -> artifacts/status
```

## File Safety

Generated artifacts are allowed only under:

```text
<resolved-project-dir>/.context-workspace/runs/<validated-run-id>/
```

The project directory must be absolute, must exist, and cannot be a protected root
such as `/`, `/etc`, `/usr`, `/var`, or the user's home directory itself.
