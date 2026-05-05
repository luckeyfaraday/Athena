#!/usr/bin/env python3
"""
verify_codex_adapter.py

Local compatibility harness for the Codex CLI adapter.

Proves the executor's assumptions about the Codex CLI under real conditions:
  1. Codex reads AGENTS.md in the project directory
  2. Codex can access .context-workspace/runs/<run_id>/context.md if given the path
  3. --output-last-message writes the final response
  4. --json emits usable JSONL events on stderr

Usage:
    python scripts/verify_codex_adapter.py [--json]
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.adapters.codex import CodexAdapter
from backend.context_artifacts import ContextArtifactWriter
from backend.runs import RunRegistry

AGENTS_INSTRUCTION = "MAGIC_WORD_FOR_TEST=blueberry"
CONTEXT_INSTRUCTION = "HERMES_CONTEXT_VAR=purple"


def run_id() -> str:
    return f"run_{uuid.uuid4().hex[:8]}"


def init_temp_project(tmp: Path) -> None:
    """Create a minimal project with AGENTS.md."""
    (tmp / "AGENTS.md").write_text(AGENTS_INSTRUCTION + "\n", encoding="utf-8")
    (tmp / "README.md").write_text("test project\n", encoding="utf-8")


def run_codex(
    tmp: Path,
    *,
    use_json: bool = False,
    timeout: int = 90,
) -> tuple[int, str, str, str, Path, Path]:
    """
    Run codex exec in the temp project.

    Returns:
        (returncode, stdout, stderr, result_path_content)
    """
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp,
        task="Verify Codex adapter compatibility.",
        run_id=run_id(),
    )
    artifacts = ContextArtifactWriter().write_context(
        run,
        memory_excerpt=CONTEXT_INSTRUCTION,
    )
    adapter = CodexAdapter(use_json=use_json)
    command = adapter.build_command(run, artifacts)

    prompt = "\n".join(
        [
            command.stdin,
            "Compatibility check:",
            "1. Read AGENTS.md and report the exact MAGIC_WORD_FOR_TEST value.",
            f"2. Read the generated context file at this exact absolute path: {artifacts.context}",
            "3. Report the exact HERMES_CONTEXT_VAR value from that context file.",
            "Format your answer as: MAGIC=<value>, CONTEXT=<value>",
            "",
        ]
    )
    completed = subprocess.run(
        command.argv,
        cwd=command.cwd,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )

    result_content = ""
    if artifacts.result.exists():
        result_content = artifacts.result.read_text(encoding="utf-8").strip()

    return (
        completed.returncode,
        completed.stdout,
        completed.stderr,
        result_content,
        artifacts.context,
        artifacts.result,
    )


def parse_jsonl(stderr: str) -> list[dict]:
    """Parse JSONL lines from stderr."""
    events = []
    for line in stderr.splitlines():
        line = line.strip()
        if line.startswith("{") and not line.startswith("hint:"):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def check_result(result: str) -> tuple[bool, str]:
    """Check if result contains the expected values."""
    ok = True
    msgs = []

    if AGENTS_INSTRUCTION not in result:
        ok = False
        msgs.append(f"FAIL: result missing AGENTS.md instruction: {AGENTS_INSTRUCTION!r}")
    else:
        msgs.append(f"OK: AGENTS.md instruction found in result")

    if CONTEXT_INSTRUCTION not in result:
        ok = False
        msgs.append(f"FAIL: result missing context.md instruction: {CONTEXT_INSTRUCTION!r}")
    else:
        msgs.append(f"OK: context.md instruction found in result")

    return ok, "\n".join(msgs)


def main() -> int:
    use_json = "--json" in sys.argv

    # Clean up tmp no matter what
    tmp = Path(tempfile.mkdtemp(prefix="cw_verify_"))

    try:
        init_temp_project(tmp)
        print(f"[cw] Temp project: {tmp}")
        print(f"[cw] AGENTS.md:     {AGENTS_INSTRUCTION}")
        print(f"[cw] context.md:    {CONTEXT_INSTRUCTION}")
        print()

        ret, stdout, stderr, result, context_path, result_path = run_codex(
            tmp,
            use_json=use_json,
        )

        print(f"[cw] Exit code:     {ret}")
        print(f"[cw] Context path:  {context_path}")
        print(f"[cw] Result path:   {result_path}")
        print()

        if use_json:
            events = parse_jsonl(stderr)
            print(f"[cw] JSONL events captured: {len(events)}")
            for ev in events:
                etype = ev.get("type", "?")
                print(f"       - {etype}")
            print()

        print("[cw] Result from --output-last-message:")
        print("---")
        print(result or "(empty)")
        print("---")
        print()

        check_ok, check_msg = check_result(result)
        print(f"[cw] Checks:\n{check_msg}")
        print()

        if ret != 0:
            print("[cw] WARNING: codex exited non-zero")
            print("[cw] stderr (first 5 lines):")
            for line in stderr.splitlines()[:5]:
                if line.strip():
                    print(f"       {line}")

        return 0 if (check_ok and ret == 0) else 1

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
