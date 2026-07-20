from __future__ import annotations

import os
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import backend.executor as executor_module
from backend.adapters.base import AdapterCommand
from backend.context_artifacts import RunArtifacts
from backend.executor import RunExecutor
from backend.runs import Run, RunRegistry, RunStatus


class FakeAdapter:
    agent_type = "codex"

    def __init__(self, fixture: Path, *, exit_code: int = 0) -> None:
        self.fixture = fixture
        self.exit_code = exit_code

    def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
        return AdapterCommand(
            argv=[
                sys.executable,
                str(self.fixture),
                "--output-last-message",
                str(artifacts.result),
                "--exit-code",
                str(self.exit_code),
                "--stderr",
                "fake stderr",
            ],
            cwd=run.project_dir,
            stdin=f"run={run.run_id}\ncontext={artifacts.context}\n",
        )

    def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
        return artifacts.result.read_text(encoding="utf-8").strip()


def test_executor_captures_successful_fake_agent(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run fake agent.",
        run_id="run_12345678",
    )
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"

    result = RunExecutor(registry=registry).execute(
        run,
        FakeAdapter(fixture),
        memory_excerpt="Relevant memory.",
    )

    assert result.run.status == RunStatus.SUCCEEDED
    assert result.returncode == 0
    assert "fake final message" in result.summary
    assert result.artifacts.context.exists()
    assert result.artifacts.stdout.read_text(encoding="utf-8") == "fake stdout\n"
    assert result.artifacts.stderr.read_text(encoding="utf-8") == "fake stderr\n"
    assert registry.get(run.run_id).status == RunStatus.SUCCEEDED


def test_executor_marks_nonzero_exit_failed(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run fake agent.",
        run_id="run_abcdefgh",
    )
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"

    result = RunExecutor(registry=registry).execute(run, FakeAdapter(fixture, exit_code=7))

    assert result.run.status == RunStatus.FAILED
    assert result.returncode == 7
    assert registry.get(run.run_id).status == RunStatus.FAILED



def test_executor_marks_run_failed_when_binary_is_missing(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Run missing binary.",
        run_id="run_missing1",
    )

    class MissingBinaryAdapter:
        agent_type = "codex"

        def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
            return AdapterCommand(
                argv=[str(tmp_path / "no-such-binary")],
                cwd=run.project_dir,
                stdin="",
            )

        def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
            return ""

    result = RunExecutor(registry=registry).execute(run, MissingBinaryAdapter())

    assert result.run.status == RunStatus.FAILED
    assert result.returncode == -3
    assert "Failed to start" in (result.run.error or "")
    assert "Failed to start" in result.artifacts.stderr.read_text(encoding="utf-8")
    assert registry.get(run.run_id).status == RunStatus.FAILED


def test_executor_streams_and_bounds_large_process_output(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Produce bounded output.",
        run_id="run_largeout1",
    )

    class LargeOutputAdapter:
        agent_type = "codex"

        def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
            return AdapterCommand(
                argv=[
                    sys.executable,
                    "-c",
                    (
                        "import pathlib,sys; "
                        "pathlib.Path(sys.argv[1]).write_text('done'); "
                        "sys.stdout.write('x' * 200000); "
                        "sys.stderr.write('y' * 200000)"
                    ),
                    str(artifacts.result),
                ],
                cwd=run.project_dir,
                stdin="",
            )

        def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
            return artifacts.result.read_text(encoding="utf-8")

    result = RunExecutor(registry=registry, max_log_bytes=64 * 1024).execute(run, LargeOutputAdapter())

    assert result.run.status == RunStatus.SUCCEEDED
    assert result.summary == "done"
    for log in (result.artifacts.stdout, result.artifacts.stderr):
        payload = log.read_bytes()
        assert len(payload) < 66 * 1024
        assert b"Athena truncated" in payload


def test_executor_timeout_is_not_blocked_by_child_that_never_reads_stdin(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Do not block on stdin.",
        run_id="run_stdinblk1",
    )

    class BlockingStdinAdapter:
        agent_type = "codex"

        def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
            return AdapterCommand(
                argv=[sys.executable, "-c", "import time; time.sleep(10)"],
                cwd=run.project_dir,
                stdin="x" * (2 * 1024 * 1024),
            )

        def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
            return "unexpected"

    started = time.monotonic()
    result = RunExecutor(registry=registry).execute(
        run,
        BlockingStdinAdapter(),
        timeout_seconds=0.1,
    )

    assert result.run.status == RunStatus.FAILED
    assert result.returncode == -1
    assert time.monotonic() - started < 3


def test_executor_rejects_new_process_after_shutdown_begins(tmp_path: Path) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Do not start after shutdown.",
        run_id="run_shutdown1",
    )
    fixture = Path(__file__).parent / "fixtures" / "fake_agent.py"
    executor = RunExecutor(registry=registry)
    executor.begin_shutdown()

    result = executor.execute(run, FakeAdapter(fixture))

    assert result.run.status == RunStatus.CANCELLED
    assert result.returncode == -2
    assert registry.get(run.run_id).status == RunStatus.CANCELLED
    assert executor._processes == {}  # noqa: SLF001 - asserts no process was admitted


def test_executor_reaps_process_that_popen_starts_during_shutdown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = RunRegistry()
    run = registry.create_run(
        agent_type="codex",
        project_dir=tmp_path,
        task="Race Popen with shutdown.",
        run_id="run_shutdown2",
    )

    class SleepingAdapter:
        agent_type = "codex"

        def build_command(self, run: Run, artifacts: RunArtifacts) -> AdapterCommand:
            return AdapterCommand(
                argv=[
                    sys.executable,
                    "-c",
                    (
                        "import pathlib,signal,sys,time; "
                        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                        "pathlib.Path(sys.argv[1]).write_text('ready'); "
                        "time.sleep(30)"
                    ),
                    str(tmp_path / "shutdown-child-ready"),
                ],
                cwd=run.project_dir,
                stdin="",
            )

        def summarize_result(self, run: Run, artifacts: RunArtifacts) -> str:
            return "unexpected"

    real_popen = executor_module.subprocess.Popen
    popen_entered = threading.Event()
    release_popen = threading.Event()
    spawned: list[object] = []
    first_call_lock = threading.Lock()
    first_call = True
    child_ready = tmp_path / "shutdown-child-ready"

    def blocked_popen(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        nonlocal first_call
        with first_call_lock:
            should_block = first_call
            first_call = False
        if should_block:
            popen_entered.set()
            assert release_popen.wait(timeout=3)
        process = real_popen(*args, **kwargs)
        if should_block:
            deadline = time.monotonic() + 3
            while not child_ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            assert child_ready.exists(), "shutdown-race child did not install its SIGTERM handler"
            spawned.append(process)
        return process

    monkeypatch.setattr(executor_module.subprocess, "Popen", blocked_popen)
    executor = RunExecutor(registry=registry)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(executor.execute, run, SleepingAdapter())
        assert popen_entered.wait(timeout=3)
        # The shutdown snapshot is intentionally taken while Popen is not yet
        # registered, reproducing the historical orphan window.
        executor.begin_shutdown()
        executor.shutdown(grace_seconds=0.1)
        released_at = time.monotonic()
        release_popen.set()
        result = future.result(timeout=5)

    assert result.run.status == RunStatus.CANCELLED
    assert result.returncode == -2
    assert len(spawned) == 1
    assert spawned[0].poll() is not None
    if os.name == "posix":
        assert spawned[0].returncode == -signal.SIGKILL
    assert time.monotonic() - released_at < 3
    assert executor._processes == {}  # noqa: SLF001 - no owned child remains
