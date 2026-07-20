"""Subprocess execution for one-shot agent runs."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .adapters.base import AgentAdapter
from .context_artifacts import ContextArtifactWriter, RunArtifacts
from .runs import Run, RunRegistry, RunStatus


LATE_SHUTDOWN_PROCESS_GRACE_SECONDS = 0.5


@dataclass(frozen=True)
class ExecutionResult:
    run: Run
    artifacts: RunArtifacts
    returncode: int
    summary: str


class RunExecutor:
    def __init__(
        self,
        *,
        registry: RunRegistry,
        artifacts: ContextArtifactWriter | None = None,
        max_log_bytes: int | None = None,
    ) -> None:
        self.registry = registry
        self.artifacts = artifacts or ContextArtifactWriter()
        configured_max = max_log_bytes if max_log_bytes is not None else int(
            os.environ.get("CONTEXT_WORKSPACE_RUN_LOG_MAX_BYTES", str(4 * 1024 * 1024))
        )
        self.max_log_bytes = max(64 * 1024, configured_max)
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._process_lock = threading.Lock()
        self._shutting_down = False

    def execute(
        self,
        run: Run,
        adapter: AgentAdapter,
        *,
        memory_excerpt: str = "",
        timeout_seconds: float | None = None,
    ) -> ExecutionResult:
        artifacts = self.artifacts.write_context(run, memory_excerpt=memory_excerpt)
        self.artifacts.initialize_logs(run)
        command = adapter.build_command(run, artifacts)
        if self.registry.cancel_requested(run.run_id) or self._shutdown_requested():
            cancelled = self.registry.update_status(run.run_id, RunStatus.CANCELLED)
            return ExecutionResult(
                run=cancelled,
                artifacts=artifacts,
                returncode=-2,
                summary=f"{run.agent_id} was cancelled before start.",
            )
        self.registry.update_status(run.run_id, RunStatus.RUNNING)

        # ``build_command`` may do non-trivial work.  Close the gap between the
        # first shutdown check and Popen without holding a lock across process
        # creation: if shutdown begins immediately after this check, the
        # post-Popen gate below owns termination and reaping.
        if self._shutdown_requested():
            cancelled = self.registry.update_status(run.run_id, RunStatus.CANCELLED)
            return ExecutionResult(
                run=cancelled,
                artifacts=artifacts,
                returncode=-2,
                summary=f"{run.agent_id} was cancelled during shutdown.",
            )

        try:
            try:
                process = subprocess.Popen(
                    command.argv,
                    cwd=command.cwd,
                    env={**os.environ, **command.env},
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=os.name == "posix",
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                )
            except OSError as exc:
                # The agent binary is missing or not executable. Without this
                # the exception would escape into the executor thread pool and
                # leave the run stuck in RUNNING forever (and counted against
                # runtime limits).
                error = f"Failed to start {run.agent_type} process: {exc}"
                artifacts.stderr.write_text(error + "\n", encoding="utf-8")
                failed = self.registry.fail(run.run_id, error)
                return ExecutionResult(
                    run=failed,
                    artifacts=artifacts,
                    returncode=-3,
                    summary=f"{run.agent_id} failed to start: {exc}",
                )
            with self._process_lock:
                self._processes[run.run_id] = process
                shutdown_after_start = self._shutting_down
            drain_threads = [
                self._start_stream_drain(process.stdout, artifacts.stdout),
                self._start_stream_drain(process.stderr, artifacts.stderr),
            ]
            stdin_thread = self._start_stdin_write(process.stdin, command.stdin)
            if shutdown_after_start:
                # shutdown() may already have taken an empty process snapshot
                # while this Popen was in progress.  This worker therefore
                # owns bounded termination and reaping; it must not fall into
                # the run's potentially hour-long timeout if SIGTERM is
                # ignored.
                self._terminate_and_reap(
                    process,
                    grace_seconds=LATE_SHUTDOWN_PROCESS_GRACE_SECONDS,
                )
            elif self.registry.cancel_requested(run.run_id):
                self._terminate_process_tree(process)
            process.wait(timeout=timeout_seconds)
            returncode = process.returncode
            cancelled_during_shutdown = shutdown_after_start or self._shutdown_requested()
        except subprocess.TimeoutExpired:
            self._terminate_process_tree(process)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._terminate_process_tree(process, force=True)
                process.wait()
            for thread in drain_threads:
                thread.join(timeout=5)
            if artifacts.stderr.stat().st_size == 0:
                artifacts.stderr.write_text("Process timed out.\n", encoding="utf-8")
            failed = self.registry.update_status(run.run_id, RunStatus.FAILED)
            return ExecutionResult(
                run=failed,
                artifacts=artifacts,
                returncode=-1,
                summary=f"{run.agent_id} timed out.",
            )
        finally:
            stdin_writer = locals().get("stdin_thread")
            if stdin_writer is not None:
                stdin_writer.join(timeout=5)
            for thread in locals().get("drain_threads", []):
                thread.join(timeout=5)
            with self._process_lock:
                self._processes.pop(run.run_id, None)

        if self.registry.cancel_requested(run.run_id) or cancelled_during_shutdown:
            updated = self.registry.update_status(run.run_id, RunStatus.CANCELLED)
            return ExecutionResult(
                run=updated,
                artifacts=artifacts,
                returncode=-2,
                summary=f"{run.agent_id} was cancelled.",
            )

        status = RunStatus.SUCCEEDED if returncode == 0 else RunStatus.FAILED
        updated = self.registry.update_status(run.run_id, status)
        return ExecutionResult(
            run=updated,
            artifacts=artifacts,
            returncode=returncode,
            summary=adapter.summarize_result(updated, artifacts),
        )

    def cancel(self, run_id: str) -> bool:
        with self._process_lock:
            process = self._processes.get(run_id)
        if process is None or process.poll() is not None:
            return False
        self._terminate_process_tree(process)
        return True

    def begin_shutdown(self) -> None:
        """Permanently close the executor's process-admission gate."""

        with self._process_lock:
            self._shutting_down = True

    def shutdown(self, *, grace_seconds: float = 3.0) -> None:
        self.begin_shutdown()
        with self._process_lock:
            processes = list(self._processes.values())
        for process in processes:
            if process.poll() is None:
                self._terminate_process_tree(process)
        deadline = time.monotonic() + max(0.0, grace_seconds)
        for process in processes:
            if process.poll() is not None:
                continue
            try:
                process.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self._terminate_process_tree(process, force=True)
        for process in processes:
            if process.poll() is not None:
                continue
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                # The process group has received a hard kill. Do not let an
                # uncooperative platform-specific wait block backend shutdown.
                pass

    def _shutdown_requested(self) -> bool:
        with self._process_lock:
            return self._shutting_down

    @classmethod
    def _terminate_and_reap(
        cls,
        process: subprocess.Popen[bytes],
        *,
        grace_seconds: float,
    ) -> None:
        if process.poll() is not None:
            process.wait()
            return
        cls._terminate_process_tree(process)
        try:
            process.wait(timeout=max(0.0, grace_seconds))
            return
        except subprocess.TimeoutExpired:
            cls._terminate_process_tree(process, force=True)
        # A hard-killed child must be collected here because the global
        # shutdown snapshot never saw it.  Waiting after SIGKILL is reaping,
        # not an additional graceful-shutdown window.
        process.wait()

    def _start_stream_drain(self, stream: BinaryIO | None, destination: Path) -> threading.Thread:
        if stream is None:
            raise RuntimeError("Agent process was started without a captured output stream.")
        thread = threading.Thread(
            target=_drain_stream_bounded,
            args=(stream, destination, self.max_log_bytes),
            name=f"athena-run-log-{destination.name}",
            daemon=True,
        )
        thread.start()
        return thread

    @staticmethod
    def _start_stdin_write(stream: BinaryIO | None, value: str) -> threading.Thread:
        if stream is None:
            raise RuntimeError("Agent process was started without an input stream.")
        thread = threading.Thread(
            target=_write_stdin,
            args=(stream, value),
            name="athena-run-stdin",
            daemon=True,
        )
        thread.start()
        return thread

    @staticmethod
    def _terminate_process_tree(process: subprocess.Popen[bytes], *, force: bool = False) -> None:
        if process.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif os.name == "nt":
                command = ["taskkill", "/PID", str(process.pid), "/T"]
                if force:
                    command.append("/F")
                subprocess.run(command, check=False, capture_output=True)
            elif force:
                process.kill()
            else:
                process.terminate()
        except (OSError, subprocess.SubprocessError):
            try:
                process.kill() if force else process.terminate()
            except OSError:
                pass


def _drain_stream_bounded(stream: BinaryIO, destination: Path, max_bytes: int) -> None:
    written = 0
    dropped = 0
    try:
        with destination.open("wb") as target:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                remaining = max(0, max_bytes - written)
                if remaining:
                    kept = chunk[:remaining]
                    target.write(kept)
                    written += len(kept)
                dropped += max(0, len(chunk) - remaining)
            if dropped:
                target.write(f"\n[Athena truncated {dropped} output bytes]\n".encode("utf-8"))
    finally:
        stream.close()


def _write_stdin(stream: BinaryIO, value: str) -> None:
    try:
        # Keep the executor thread free to enforce timeout/cancellation even if
        # a child never drains its pipe. Modest chunks also avoid a second full
        # encoded copy of a large prompt.
        for offset in range(0, len(value), 64 * 1024):
            data = value[offset : offset + 64 * 1024].encode("utf-8")
            view = memoryview(data)
            while view:
                written = stream.write(view)
                if written is None:
                    break
                view = view[written:]
        stream.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass
