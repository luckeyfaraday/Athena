from __future__ import annotations

import io
from pathlib import Path

from backend.executor import _drain_stream_bounded


def test_pr_104_136_large_run_logs_are_streamed_to_a_hard_bound(tmp_path: Path) -> None:
    destination = tmp_path / "stdout.log"
    _drain_stream_bounded(io.BytesIO(b"x" * 200_000), destination, 64 * 1024)

    payload = destination.read_bytes()
    assert len(payload) < 66 * 1024
    assert payload.startswith(b"x" * 1024)
    assert b"Athena truncated 134464 output bytes" in payload
