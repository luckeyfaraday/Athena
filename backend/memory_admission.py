"""Physical-memory admission for heavyweight legacy agent launches.

The Electron terminal path has its own launch admission service.  The backend
``POST /agents/spawn`` route is a separate, non-visible execution surface, so it
must reserve physical headroom independently instead of assuming the desktop
gate ran first.
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


MIB = 1024 * 1024
GIB = 1024 * MIB

# The measured Codex process group was about 621 MiB including helper and MCP
# descendants.  Match the Electron-side reservation so either launch surface
# makes the same conservative capacity decision.
DEFAULT_LAUNCH_RESERVATION_BYTES = 640 * MIB
DEFAULT_MINIMUM_HEADROOM_BYTES = 1 * GIB
DEFAULT_RESERVATION_TTL_SECONDS = 15.0


@dataclass(frozen=True)
class MemoryAdmissionDecision:
    allowed: bool
    available_bytes: int | None
    requested_bytes: int
    reserved_bytes: int
    projected_available_bytes: int | None
    reservation_id: str | None
    reason: str


@dataclass(frozen=True)
class _Reservation:
    bytes: int
    expires_at: float


class _WindowsMemoryStatusEx(ctypes.Structure):
    # Windows DWORD is always 32-bit even on 64-bit Python.  Using c_ulong
    # would be incorrect on non-Windows CI hosts where it may be 64-bit.
    _fields_ = [
        ("dwLength", ctypes.c_uint32),
        ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


class LaunchMemoryAdmission:
    """Atomically checks and briefly reserves physical launch headroom.

    ``MemAvailable`` already includes reclaimable page cache.  Swap is
    deliberately absent from this model: admitting a heavyweight process only
    because it fits in swap is the freeze mode this guard prevents.
    """

    def __init__(
        self,
        *,
        probe: Callable[[], int | None] | None = None,
        reservation_bytes: int = DEFAULT_LAUNCH_RESERVATION_BYTES,
        minimum_headroom_bytes: int = DEFAULT_MINIMUM_HEADROOM_BYTES,
        reservation_ttl_seconds: float = DEFAULT_RESERVATION_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._probe = probe if probe is not None else read_physical_available_bytes
        self._reservation_bytes = max(1, int(reservation_bytes))
        self._minimum_headroom_bytes = max(0, int(minimum_headroom_bytes))
        self._reservation_ttl_seconds = max(0.001, float(reservation_ttl_seconds))
        self._clock = clock
        self._reservations: dict[str, _Reservation] = {}
        self._lock = threading.Lock()

    def reserve(self) -> MemoryAdmissionDecision:
        """Check current physical headroom and reserve capacity as one action."""

        with self._lock:
            now = self._clock()
            self._expire_locked(now)
            available_bytes = self._safe_probe()
            reserved_bytes = sum(reservation.bytes for reservation in self._reservations.values())
            projected = (
                None
                if available_bytes is None
                else available_bytes - reserved_bytes - self._reservation_bytes
            )

            # A failed platform probe must not make the backend permanently
            # unusable.  Runtime concurrency limits still apply, and a later
            # healthy probe will restore physical-memory enforcement.
            if available_bytes is not None and projected < self._minimum_headroom_bytes:
                return MemoryAdmissionDecision(
                    allowed=False,
                    available_bytes=available_bytes,
                    requested_bytes=self._reservation_bytes,
                    reserved_bytes=reserved_bytes,
                    projected_available_bytes=max(0, projected),
                    reservation_id=None,
                    reason=(
                        "Agent launch blocked by physical-memory admission: "
                        f"{_format_gib(available_bytes)} MemAvailable, "
                        f"{_format_gib(reserved_bytes)} already reserved, and "
                        f"{_format_gib(self._minimum_headroom_bytes)} minimum headroom required. "
                        "Swap is not counted as launch capacity."
                    ),
                )

            reservation_id = f"backend-launch-{uuid4().hex}"
            self._reservations[reservation_id] = _Reservation(
                bytes=self._reservation_bytes,
                expires_at=now + self._reservation_ttl_seconds,
            )
            return MemoryAdmissionDecision(
                allowed=True,
                available_bytes=available_bytes,
                requested_bytes=self._reservation_bytes,
                reserved_bytes=reserved_bytes,
                projected_available_bytes=None if projected is None else max(0, projected),
                reservation_id=reservation_id,
                reason=(
                    "Physical-memory probe unavailable; launch admitted with runtime limits."
                    if available_bytes is None
                    else "Physical-memory capacity reserved for agent launch."
                ),
            )

    def release(self, reservation_id: str | None) -> bool:
        if not reservation_id:
            return False
        with self._lock:
            return self._reservations.pop(reservation_id, None) is not None

    def reserved_bytes(self) -> int:
        with self._lock:
            self._expire_locked(self._clock())
            return sum(reservation.bytes for reservation in self._reservations.values())

    def _safe_probe(self) -> int | None:
        try:
            value = self._probe()
            if value is None:
                return None
            value = int(value)
        except (OSError, RuntimeError, TypeError, ValueError, OverflowError):
            return None
        return value if value >= 0 else None

    def _expire_locked(self, now: float) -> None:
        expired = [
            reservation_id
            for reservation_id, reservation in self._reservations.items()
            if reservation.expires_at <= now
        ]
        for reservation_id in expired:
            del self._reservations[reservation_id]


def parse_linux_mem_available(text: str) -> int | None:
    """Return ``MemAvailable`` bytes from ``/proc/meminfo``.

    The parser intentionally ignores ``SwapFree`` and every other swap field.
    """

    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if not separator or key != "MemAvailable":
            continue
        fields = value.split()
        if not fields:
            return None
        try:
            amount = int(fields[0])
        except ValueError:
            return None
        if amount < 0:
            return None
        unit = fields[1].lower() if len(fields) > 1 else "kb"
        if unit != "kb":
            return None
        return amount * 1024
    return None


def read_physical_available_bytes() -> int | None:
    """Best-effort physical available memory, never including swap."""

    if sys.platform == "win32":
        return read_windows_physical_available_bytes()

    if sys.platform.startswith("linux"):
        try:
            return parse_linux_mem_available(Path("/proc/meminfo").read_text(encoding="ascii"))
        except OSError:
            return None

    # POSIX exposes the currently available physical pages without swap.
    if hasattr(os, "sysconf"):
        try:
            pages = int(os.sysconf("SC_AVPHYS_PAGES"))
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            if pages >= 0 and page_size > 0:
                return pages * page_size
        except (OSError, TypeError, ValueError, OverflowError):
            pass

    # Keep the guard fail-open on platforms without a standard-library
    # physical-memory probe.  Concurrency limits remain enforced.
    return None


def read_windows_physical_available_bytes(kernel32: object | None = None) -> int | None:
    """Return Windows physical availability from ``GlobalMemoryStatusEx``.

    ``ullAvailPageFile`` is intentionally ignored: page-file capacity is the
    Windows analogue of swap and cannot safely justify another agent launch.
    ``kernel32`` is injectable so the ABI mapping and failure path can be
    validated on non-Windows CI.
    """

    if kernel32 is None:
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except (AttributeError, OSError):
            return None

    status = _WindowsMemoryStatusEx()
    status.dwLength = ctypes.sizeof(_WindowsMemoryStatusEx)
    try:
        succeeded = getattr(kernel32, "GlobalMemoryStatusEx")(ctypes.byref(status))
    except (AttributeError, OSError, TypeError, ValueError, ctypes.ArgumentError):
        return None
    if not succeeded:
        return None
    return int(status.ullAvailPhys)


def _format_gib(value: int) -> str:
    return f"{value / GIB:.1f} GiB"
