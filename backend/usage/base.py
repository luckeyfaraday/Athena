"""Provider-neutral types for subscription usage monitoring.

The usage service reads quota windows (a 5-hour session, a weekly cap, ...)
from the CLIs the user is already signed into. Credentials never leave an
adapter: identities carry display fields plus opaque fingerprints, and only
``UsageWindow`` values and display labels travel to clients.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol

CredentialState = Literal["ok", "missing", "expired", "unsupported"]
ProbeErrorKind = Literal["auth", "expired", "rate_limited", "network", "timeout", "unavailable", "protocol"]


@dataclass(frozen=True)
class ProviderHome:
    """One CLI config home (``~/.claude``, a ``CODEX_HOME``, a switcher profile)."""

    provider: str
    path: Path
    label: str
    source: str

    def display_path(self) -> str:
        home = Path.home()
        try:
            return "~/" + self.path.relative_to(home).as_posix()
        except ValueError:
            return str(self.path)


@dataclass(frozen=True)
class AccountIdentity:
    """Who a home is signed in as. ``stable_id`` is internal and never serialized."""

    provider: str
    stable_id: str | None
    email: str | None = None
    display_name: str | None = None
    organization: str | None = None
    plan: str | None = None
    credential_state: CredentialState = "missing"
    # Changes whenever the CLI rewrites its credential file (login, refresh), so
    # an auth failure can wait for the CLI to fix the login instead of retrying.
    credential_fingerprint: str = ""
    expires_at: datetime | None = None
    # A credential or metadata file existed but could not be parsed, as when the
    # CLI is mid-rewrite. The service keeps the last good identity instead of
    # treating the home as a different (or signed-out) account.
    unreadable: bool = False

    def account_key(self, home: ProviderHome) -> str:
        # A home whose account cannot be identified is keyed by its path, so it
        # never shares a cache entry with an identified account.
        basis = f"account:{self.stable_id}" if self.stable_id else f"home:{home.path}"
        digest = hashlib.sha256(f"{self.provider}\0{basis}".encode("utf-8")).hexdigest()[:16]
        return f"{self.provider}:{digest}"


@dataclass(frozen=True)
class UsageWindow:
    id: str
    label: str
    used_percent: float
    resets_at: datetime | None = None
    window_minutes: int | None = None

    def is_open(self, now: datetime) -> bool:
        return self.resets_at is None or self.resets_at > now

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "used_percent": round(self.used_percent, 1),
            "resets_at": iso(self.resets_at),
            "window_minutes": self.window_minutes,
        }


@dataclass
class ProbeResult:
    ok: bool
    windows: list[UsageWindow] = field(default_factory=list)
    plan: str | None = None
    email: str | None = None
    error_kind: ProbeErrorKind | None = None
    message: str | None = None
    retry_after_seconds: float | None = None

    @classmethod
    def failure(cls, kind: ProbeErrorKind, message: str, *, retry_after_seconds: float | None = None) -> "ProbeResult":
        return cls(ok=False, error_kind=kind, message=message, retry_after_seconds=retry_after_seconds)


class UsageAdapter(Protocol):
    provider: str
    display_name: str

    def discover_homes(self) -> list[ProviderHome]:
        """Config homes to monitor. Must only read the filesystem."""

    def read_identity(self, home: ProviderHome) -> AccountIdentity:
        """Identity and credential state for a home, without any network call."""

    def probe(self, home: ProviderHome, identity: AccountIdentity) -> ProbeResult:
        """Fetch live quota windows. Must be bounded in time and never raise."""

    def signed_out_hint(self, home: ProviderHome) -> str:
        """How the user restores a missing or rejected login for this home."""

    def expired_hint(self, home: ProviderHome) -> str:
        """Why an expired login is not probed, and what refreshes it."""


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def parse_percent(value: Any) -> float | None:
    """A 0..100 percentage, or None when the provider reports no usable number.

    Unknown must stay unknown: ``None``, booleans, strings, NaN and negatives are
    rejected rather than coerced to zero.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0:
        return None
    return min(number, 100.0)


def parse_timestamp(value: Any) -> datetime | None:
    """ISO-8601 strings, or epoch seconds/milliseconds, as an aware UTC datetime."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0:
            return None
        seconds = value / 1000 if value > 1e12 else value
        try:
            return datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return parse_timestamp(int(text))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def content_fingerprint(raw: bytes | None) -> str:
    """Opaque digest of a credential file's bytes; changes whenever the CLI rewrites it.

    Hashing the bytes a probe actually read (rather than mtime/size) ties a
    fingerprint to exactly one token. The digest never leaves the service.
    """
    if raw is None:
        return "absent"
    return hashlib.sha256(raw).hexdigest()[:16]


def read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def json_object(raw: bytes | None) -> dict[str, Any]:
    if raw is None:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def env_paths(env: dict[str, str], name: str) -> list[Path]:
    """Extra config homes listed in an ``os.pathsep``-separated variable."""
    raw = env.get(name, "")
    return [Path(os.path.expanduser(part.strip())) for part in raw.split(os.pathsep) if part.strip()]


def resolved(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError:
        return path.expanduser().absolute()


def window_label(minutes: int | None) -> str:
    if minutes == 300:
        return "Session"
    if minutes == 10080:
        return "Weekly"
    if minutes and minutes % 1440 == 0:
        return f"{minutes // 1440}-day"
    if minutes and minutes % 60 == 0:
        return f"{minutes // 60}-hour"
    if minutes:
        return f"{minutes}-min"
    return "Limit"
