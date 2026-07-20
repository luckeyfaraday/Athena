from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import backend.memory_admission as memory_admission_module
from backend.memory_admission import (
    DEFAULT_LAUNCH_RESERVATION_BYTES,
    DEFAULT_MINIMUM_HEADROOM_BYTES,
    GIB,
    LaunchMemoryAdmission,
    parse_linux_mem_available,
    read_windows_physical_available_bytes,
)


def test_linux_probe_uses_memavailable_and_never_swapfree() -> None:
    text = """\
MemTotal:       16384000 kB
MemFree:          100000 kB
MemAvailable:     700000 kB
SwapTotal:      67108864 kB
SwapFree:       67108864 kB
"""

    assert parse_linux_mem_available(text) == 700000 * 1024


def test_windows_probe_uses_available_physical_memory_not_pagefile() -> None:
    class FakeKernel32:
        @staticmethod
        def GlobalMemoryStatusEx(status_pointer):  # noqa: ANN001, ANN205
            status = status_pointer._obj  # noqa: SLF001 - ctypes byref test double
            status.ullAvailPhys = 750 * 1024 * 1024
            status.ullAvailPageFile = 64 * GIB
            return 1

    assert read_windows_physical_available_bytes(FakeKernel32()) == 750 * 1024 * 1024


def test_windows_probe_fails_open_only_when_api_probe_fails() -> None:
    class FailingKernel32:
        @staticmethod
        def GlobalMemoryStatusEx(status_pointer):  # noqa: ARG004, ANN001, ANN205
            return 0

    assert read_windows_physical_available_bytes(FailingKernel32()) is None


def test_platform_probe_dispatches_win32_to_global_memory_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(memory_admission_module.sys, "platform", "win32")
    monkeypatch.setattr(
        memory_admission_module,
        "read_windows_physical_available_bytes",
        lambda: 123456789,
    )

    assert memory_admission_module.read_physical_available_bytes() == 123456789


def test_admission_reservations_are_atomic_across_concurrent_requests() -> None:
    # Exactly one reservation fits while preserving the minimum headroom.
    available = (
        DEFAULT_MINIMUM_HEADROOM_BYTES
        + 2 * DEFAULT_LAUNCH_RESERVATION_BYTES
        - 1
    )
    admission = LaunchMemoryAdmission(probe=lambda: available)
    ready = threading.Barrier(8)

    def reserve_once():  # noqa: ANN202
        ready.wait(timeout=2)
        return admission.reserve()

    with ThreadPoolExecutor(max_workers=8) as pool:
        decisions = list(pool.map(lambda _index: reserve_once(), range(8)))

    allowed = [decision for decision in decisions if decision.allowed]
    rejected = [decision for decision in decisions if not decision.allowed]
    assert len(allowed) == 1
    assert len(rejected) == 7
    assert admission.reserved_bytes() == DEFAULT_LAUNCH_RESERVATION_BYTES


def test_admission_reservation_expires_without_counting_swap() -> None:
    now = [100.0]
    admission = LaunchMemoryAdmission(
        probe=lambda: 4 * GIB,
        reservation_ttl_seconds=5,
        clock=lambda: now[0],
    )

    assert admission.reserve().allowed is True
    assert admission.reserved_bytes() == DEFAULT_LAUNCH_RESERVATION_BYTES
    now[0] += 5
    assert admission.reserved_bytes() == 0


def test_failed_memory_probe_is_fail_open_but_still_reserved() -> None:
    admission = LaunchMemoryAdmission(probe=lambda: None)

    decision = admission.reserve()

    assert decision.allowed is True
    assert decision.available_bytes is None
    assert decision.reservation_id is not None
    assert admission.reserved_bytes() == DEFAULT_LAUNCH_RESERVATION_BYTES
