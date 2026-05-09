from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_recall_refresh_script_writes_cache(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[1] / "scripts" / "hermes-refresh-recall.py"
    project = tmp_path / "project"
    project.mkdir()
    env = {
        **os.environ,
        "CONTEXT_WORKSPACE_PROJECT_DIR": str(project),
        "CONTEXT_WORKSPACE_TASK_HINT": "Manual test",
        "CONTEXT_WORKSPACE_BACKEND_URL": "http://127.0.0.1:12345",
    }

    completed = subprocess.run(
        [sys.executable, str(script)],
        env=env,
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )

    recall_path = project / ".context-workspace" / "hermes" / "session-recall.md"
    metadata_path = project / ".context-workspace" / "hermes" / "last-refresh.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    recall = recall_path.read_text(encoding="utf-8")

    assert completed.returncode == 0, completed.stderr
    assert "Recall refreshed" in completed.stdout
    assert "Manual test" in recall
    assert "No native agent sessions were found" in recall
    assert metadata["source"] == "context-workspace-refresh-script"
    assert metadata["bytes"] == len(recall.encode("utf-8"))
